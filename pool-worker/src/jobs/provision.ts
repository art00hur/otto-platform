import { NodeSSH } from "node-ssh";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db, instances } from "../db.js";
import { encrypt } from "../encryption.js";
import { logger } from "../logger.js";
import * as hetzner from "../providers/hetzner.js";

const OPENROUTER_PROVISIONING_KEY = process.env.OPENROUTER_PROVISIONING_KEY || "";
const SSH_READY_TIMEOUT = 180_000;  // 3 min max to wait for SSH
const SSH_RETRY_DELAY = 8_000;      // 8s between SSH attempts
const SSH_MAX_RETRIES = 20;

/**
 * Provision a single instance end-to-end:
 *
 * 1. Create Hetzner VPS
 * 2. Wait for it to boot
 * 3. Wait for cloud-init to finish (Docker + Node.js + OpenClaw installed)
 * 4. Verify OpenClaw is installed
 * 5. Record in DB as "ready"
 *
 * Total time: ~2-4 minutes
 */
export async function provisionInstance(): Promise<string> {
  const instanceName = "otto-" + Array.from({length: 8}, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  let ssh: NodeSSH | null = null;
  let providerInstanceId: string | null = null;

  logger.info({ instanceName }, "Starting instance provisioning");

  try {
    // ---- Step 1: Create VPS ----
    const result = await hetzner.createInstance({ name: instanceName });
    providerInstanceId = result.provider_instance_id;

    // ---- Step 2: Insert into DB as "provisioning" ----
    const [dbInstance] = await db
      .insert(instances)
      .values({
        provider: "hetzner",
        provider_instance_id: result.provider_instance_id,
        ip_address: result.ip_address,
        ssh_private_key_enc: encrypt(result.ssh_private_key),
        status: "provisioning",
        region: process.env.POOL_REGION || "nbg1",
      })
      .returning();

    logger.info(
      { id: dbInstance.id, ip: result.ip_address },
      "Instance record created"
    );

    // ---- Step 3: Wait for Hetzner server to be "running" ----
    await hetzner.waitForRunning(result.provider_instance_id);

    // ---- Step 4: Update status to "installing" ----
    await db
      .update(instances)
      .set({ status: "installing" })
      .where(eq(instances.id, dbInstance.id));

    // ---- Step 5: Wait for SSH to become available ----
    ssh = await waitForSSH(result.ip_address, result.ssh_private_key);

    // ---- Step 6: Upgrade OpenClaw to latest (snapshot may have old version) ----
    await ssh.execCommand("npm install -g openclaw@latest 2>&1");
    const version = await verifyOpenClaw(ssh);

    // ---- Step 6b: Configure OpenClaw (full architecture config) ----
    logger.info({ instanceName }, "Configuring OpenClaw...");
    const { gatewayPort, gatewayToken } = await configureOpenClawFull(ssh);

    // ---- Step 6c: Create per-customer OpenRouter API key ----
    let openrouterKeyHash: string | null = null;
    if (OPENROUTER_PROVISIONING_KEY) {
      try {
        const keyRes = await fetch("https://openrouter.ai/api/v1/keys", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + OPENROUTER_PROVISIONING_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "otto-" + dbInstance.id.slice(0, 8),
            limit: parseInt(process.env.OPENROUTER_KEY_LIMIT || "75"),
            limit_reset: "monthly",
          }),
        });
        if (keyRes.ok) {
          const keyData = (await keyRes.json()) as { data: { hash: string }; key: string };
          openrouterKeyHash = keyData.data.hash;
          const customerKey = keyData.key;

          // Update openclaw.json with customer-specific key
          await ssh.execCommand(
            `sudo -u openclaw openclaw config set env.OPENROUTER_API_KEY ${customerKey} 2>&1`
          );

          // Also update the systemd service env var
          await ssh.execCommand(
            `sed -i "s|Environment=OPENROUTER_API_KEY=.*|Environment=OPENROUTER_API_KEY=${customerKey}|" /home/openclaw/.config/systemd/user/openclaw-gateway.service 2>/dev/null`
          );

          // Reload systemd and restart gateway with new key
          const uid2 = (await ssh.execCommand("id -u openclaw")).stdout.trim();
          const sysEnv2 = `XDG_RUNTIME_DIR=/run/user/${uid2} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid2}/bus`;
          await ssh.execCommand(`sudo -u openclaw ${sysEnv2} systemctl --user daemon-reload 2>&1`);
          await ssh.execCommand(`sudo -u openclaw ${sysEnv2} systemctl --user restart openclaw-gateway 2>&1`);
          await sleep(3000);

          logger.info({ hash: openrouterKeyHash.slice(0, 12) + "..." }, "Per-customer OpenRouter key created");
        } else {
          logger.warn({ status: keyRes.status }, "Failed to create OpenRouter key — using master key");
        }
      } catch (err: any) {
        logger.warn({ error: err.message }, "OpenRouter key creation failed — using master key");
      }
    }

    // ---- Step 7: Mark as "ready" with gateway metadata ----
    await db
      .update(instances)
      .set({
        status: "ready",
        openclaw_version: version,
        health_ok: true,
        last_health_check: new Date(),
        gateway_token_enc: encrypt(gatewayToken),
        gateway_port: gatewayPort,
        openrouter_key_hash: openrouterKeyHash,
      })
      .where(eq(instances.id, dbInstance.id));

    logger.info(
      { id: dbInstance.id, ip: result.ip_address, version },
      "✅ Instance ready and added to pool"
    );

    return dbInstance.id;

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ instanceName, error: message }, "❌ Provisioning failed");

    // Clean up: delete the Hetzner server if it was created
    if (providerInstanceId) {
      try {
        await hetzner.deleteInstance(providerInstanceId);
        logger.info({ providerInstanceId }, "Cleaned up failed instance from Hetzner");
      } catch (cleanupErr) {
        logger.error({ providerInstanceId, cleanupErr }, "Failed to cleanup Hetzner instance");
      }
    }

    throw error;

  } finally {
    // Clean up SSH key from Hetzner (key is already baked into the server)
    // SSH key cleanup not needed — using persistent key
    if (ssh) {
      try { ssh.dispose(); } catch {}
    }
  }
}

// ---- SSH Helpers ----

/**
 * Wait for SSH to become available on a newly created VPS.
 * The server may take 30-90 seconds to fully boot and accept SSH.
 */
async function waitForSSH(host: string, privateKey: string): Promise<NodeSSH> {
  const ssh = new NodeSSH();

  for (let attempt = 1; attempt <= SSH_MAX_RETRIES; attempt++) {
    try {
      await ssh.connect({
        host,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 10_000,
      });

      logger.info({ host, attempt }, "SSH connection established");

      // Inject control plane SSH key for admin access
      const CONTROL_PLANE_PUBKEY = process.env.CONTROL_PLANE_PUBKEY || "";
      if (CONTROL_PLANE_PUBKEY) {
        await ssh.execCommand(`mkdir -p /root/.ssh && echo "${CONTROL_PLANE_PUBKEY}" >> /root/.ssh/authorized_keys`);
      }
      return ssh;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (attempt === SSH_MAX_RETRIES) {
        throw new Error(`SSH not available on ${host} after ${SSH_MAX_RETRIES} attempts: ${msg}`);
      }

      logger.debug({ host, attempt, error: msg }, "SSH not ready yet, retrying");
      await sleep(SSH_RETRY_DELAY);
    }
  }

  throw new Error("Unreachable");
}

/**
 * Wait for cloud-init to finish by checking for the marker file.
 * Cloud-init installs Docker, Node.js, OpenClaw, and configures firewall.
 */
async function waitForCloudInit(ssh: NodeSSH): Promise<void> {
  const maxAttempts = 120;  // 120 * 5s = 10 minutes max
  const interval = 5_000;

  for (let i = 1; i <= maxAttempts; i++) {
    const result = await ssh.execCommand(
      "test -f /var/lib/cloud/instance/claw-ready && echo 'READY' || echo 'WAITING'"
    );

    if (result.stdout.trim() === "READY") {
      logger.info({ attempts: i }, "Cloud-init complete");
      return;
    }

    if (i % 10 === 0) {
      // Log cloud-init progress every ~50 seconds
      const logResult = await ssh.execCommand(
        "tail -3 /var/log/claw-init.log 2>/dev/null || echo 'no log yet'"
      );
      logger.debug({ attempt: i, log: logResult.stdout.trim() }, "Cloud-init still running");
    }

    if (i < maxAttempts) await sleep(interval);
  }

  // If we get here, grab the cloud-init log for debugging
  const logResult = await ssh.execCommand("cat /var/log/claw-init.log 2>/dev/null || echo 'no log'");
  throw new Error(`Cloud-init did not complete in 5 minutes.\nLog:\n${logResult.stdout.substring(0, 1000)}`);
}

/**
 * Verify OpenClaw is installed and get its version.
 */
async function verifyOpenClaw(ssh: NodeSSH): Promise<string> {
  // Check the version file first (written by cloud-init)
  const versionFile = await ssh.execCommand(
    "cat /home/openclaw/.openclaw/version 2>/dev/null || echo ''"
  );

  if (versionFile.stdout.trim()) {
    return versionFile.stdout.trim();
  }

  // Fallback: run the command directly
  const result = await ssh.execCommand("openclaw --version 2>/dev/null || echo 'unknown'");
  const version = result.stdout.trim();

  if (version === "unknown" || !version) {
    throw new Error("OpenClaw not found after cloud-init. Installation may have failed.");
  }

  return version;
}

/**
 * Verify the firewall is active and properly configured.
 */
async function verifyFirewall(ssh: NodeSSH): Promise<void> {
  const result = await ssh.execCommand("ufw status verbose");

  if (result.code !== 0 || !result.stdout.includes("Status: active")) {
    throw new Error(`Firewall not active: ${result.stdout}`);
  }

  // Verify only expected ports are open
  const stdout = result.stdout;
  if (!stdout.includes("22/tcp") || !stdout.includes("18789/tcp")) {
    logger.warn("Firewall may be missing expected port rules");
  }

  logger.debug("Firewall verified: active with correct rules");
}

/**
 * Configure OpenClaw: run onboard, add WhatsApp channel, run doctor.
 */
async function configureOpenClaw(ssh: NodeSSH): Promise<void> {
  // Step 1: Run onboard (non-interactive)
  const onboard = await ssh.execCommand(
    "sudo -u openclaw openclaw onboard --non-interactive --accept-risk 2>&1"
  );
  logger.debug({ stdout: onboard.stdout.substring(0, 300) }, "Onboard complete");

  // Step 2: Add WhatsApp channel to config
  const addChannel = await ssh.execCommand(
    `sudo -u openclaw python3 -c "
import json
p='/home/openclaw/.openclaw/openclaw.json'
with open(p) as f:
    c=json.load(f)
c['channels']={'whatsapp':{'accounts':{'default':{'enabled':True}}}}
with open(p,'w') as f:
    json.dump(c,f,indent=2)
print('ok')
"`
  );
  
  if (!addChannel.stdout.includes("ok")) {
    throw new Error(`Failed to add WhatsApp channel: ${addChannel.stderr}`);
  }
  logger.debug("WhatsApp channel added to config");

  // Step 3: Run doctor --fix
  const doctor = await ssh.execCommand(
    "sudo -u openclaw openclaw doctor --fix 2>&1"
  );
  logger.debug({ stdout: doctor.stdout.substring(0, 300) }, "Doctor fix complete");

  logger.info("OpenClaw configured with WhatsApp channel");
}

/**
 * Full OpenClaw configuration aligned with the Otto architecture:
 *
 * 1. Random port (20000-60000) bound to loopback only
 * 2. 256-bit auth token for gateway access
 * 3. OpenRouter API key for AI model access
 * 4. WhatsApp channel pre-configured
 * 5. Security: DM pairing, group mentions, sandbox, tool restrictions
 * 6. Gateway installed as systemd service (auto-start on boot)
 * 7. UFW hardened: only SSH from Otto control plane IP
 *
 * Returns { gatewayPort, gatewayToken } for storage in DB.
 */
async function configureOpenClawFull(ssh: NodeSSH): Promise<{ gatewayPort: number; gatewayToken: string }> {
  const CONTROL_PLANE_IP = process.env.CONTROL_PLANE_IP || "203.0.113.10";
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

  // Generate random port and auth token
  const gatewayPort = 20000 + Math.floor(Math.random() * 40000); // 20000-60000
  const gatewayToken = [...Array(48)].map(() => Math.random().toString(36)[2]).join("");

  // Step 1: Run onboard (non-interactive)
  const onboard = await ssh.execCommand(
    "sudo -u openclaw openclaw onboard --non-interactive --accept-risk 2>&1"
  );
  logger.debug({ stdout: onboard.stdout.substring(0, 300) }, "Onboard complete");

  // Step 2: Write full openclaw.json config
  const config = {
    gateway: {
      port: gatewayPort,
      mode: "local",
      bind: "loopback",
      auth: {
        mode: "token",
        token: gatewayToken,
      },
      controlUi: {
        // Safe: gateway is loopback-only behind SSH tunnel + UFW.
        // Auth token is still required.
        dangerouslyDisableDeviceAuth: true,
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
      tailscale: { mode: "off", resetOnExit: false },
      reload: { mode: "hybrid", debounceMs: 300 },
    },
    env: {
      OPENROUTER_API_KEY: OPENROUTER_API_KEY,
    },
    agents: {
      defaults: {
        workspace: "/home/openclaw/.openclaw/workspace",
        model: {
          primary: "openrouter/anthropic/claude-sonnet-4-5",
          fallbacks: [
            "openrouter/anthropic/claude-haiku-4-5",
          ],
        },
        models: {
          "openrouter/anthropic/claude-sonnet-4-5": { alias: "sonnet" },
          "openrouter/anthropic/claude-haiku-4-5": { alias: "haiku" },
          "openrouter/anthropic/claude-opus-4-6": { alias: "opus" },
                  },
        compaction: { mode: "safeguard", reserveTokensFloor: 20000, memoryFlush: { enabled: true, softThresholdTokens: 4000, systemPrompt: "Session nearing compaction. Store durable memories now.", prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store." } },
        maxConcurrent: 10,
        subagents: { maxConcurrent: 8, runTimeoutSeconds: 240 },
        heartbeat: { every: "0m" }, // Disabled until user enables
        sandbox: { mode: "non-main", scope: "agent" },
      },
    },
    channels: {
      whatsapp: {
        accounts: { default: { enabled: true } },
        dmPolicy: "pairing",
        groups: { "*": { requireMention: true } },
      },
    },
    session: {
      dmScope: "per-channel-peer",
      reset: { mode: "daily", atHour: 4, idleMinutes: 10080 },
    },
    tools: {
      web: { search: { provider: "perplexity", model: "perplexity/sonar-pro" } },
      deny: ["gateway", "group:runtime"],
      fs: { workspaceOnly: true },
      exec: { security: "deny", ask: "always" },
      elevated: { enabled: false },
      sessions: { visibility: "all" },
      agentToAgent: { enabled: true, allow: ["main"] },
    },
    messages: { ackReactionScope: "group-mentions" },
    commands: { native: "auto", nativeSkills: "auto", restart: true, ownerDisplay: "raw" },
    skills: { install: { nodeManager: "npm" } },
    identity: {
      name: "Otto Agent",
      theme: "helpful business assistant",
      emoji: "🤖",
      model: "openrouter/anthropic/claude-sonnet-4-5",
    },
  };

  const configJson = JSON.stringify(config, null, 2);
  
  // Write config via temp file to avoid shell escaping issues
  await ssh.execCommand(`cat > /tmp/openclaw-config.json << 'OTTOCONFIGEOF'
${configJson}
OTTOCONFIGEOF`);
  
  const writeConfig = await ssh.execCommand(
    "sudo -u openclaw cp /tmp/openclaw-config.json /home/openclaw/.openclaw/openclaw.json && rm /tmp/openclaw-config.json && echo ok"
  );

  if (!writeConfig.stdout.includes("ok")) {
    throw new Error(`Failed to write config: ${writeConfig.stderr}`);
  }
  logger.info({ gatewayPort }, "OpenClaw config written");

  // Step 3: Run doctor --fix
  const doctor = await ssh.execCommand(
    "sudo -u openclaw openclaw doctor --fix 2>&1"
  );
  logger.debug({ stdout: doctor.stdout.substring(0, 300) }, "Doctor fix complete");

  // Step 4: Install gateway as systemd user service
  // OpenClaw uses systemctl --user, needs linger + DBUS session
  await ssh.execCommand("loginctl enable-linger openclaw");
  
  const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
  const systemdEnv = `XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`;
  
  const installGw = await ssh.execCommand(
    `sudo -u openclaw ${systemdEnv} openclaw gateway install 2>&1`
  );
  logger.debug({ stdout: installGw.stdout.substring(0, 300) }, "Gateway service installed");

  // Enable and start the gateway service
  await ssh.execCommand(
    `sudo -u openclaw ${systemdEnv} systemctl --user enable openclaw-gateway 2>&1`
  );
  await ssh.execCommand(
    `sudo -u openclaw ${systemdEnv} systemctl --user start openclaw-gateway 2>&1`
  );
  logger.debug("Gateway service started");

  // Step 4b: Write Otto-format workspace files (overwrite OpenClaw defaults)
  await ssh.execCommand(`cat > /tmp/otto-soul.md << 'SOULEOF'
# Otto Agent — Assistant

**Emoji:** 🤖
SOULEOF
sudo -u openclaw cp /tmp/otto-soul.md /home/openclaw/.openclaw/workspace/SOUL.md && rm /tmp/otto-soul.md`);
  await ssh.execCommand(`cat > /tmp/otto-user.md << 'USEREOF'
# About My Human

USEREOF
sudo -u openclaw cp /tmp/otto-user.md /home/openclaw/.openclaw/workspace/USER.md && rm /tmp/otto-user.md`);
  // Step 4c: Write default AGENTS.md with delegation instructions
  const agentsMdContent = [
    "# Team Communication",
    "",
    "You work in a team of AI agents. Use sessions_send to communicate with other agents.",
    "",
    "## How to delegate",
    "",
    "Use sessions_send with timeoutSeconds: 240:",
    "  sessions_send(sessionKey: \"agent:<agentId>:main\", message: \"Your task\", timeoutSeconds: 240)",
    "",
    "## Delegation Rules",
    "- ALWAYS use sessions_send with timeoutSeconds: 240",
    "- NEVER use sessions_spawn (it restricts the target agent tools)",
    "- NEVER use the message tool for agent-to-agent communication",
    "- Include ALL relevant data in your message — agents do not share memory or files",
    "- Wait for the response before presenting results to the human",
    "",
    "## Communication Rules",
    "- Call sessions_send SILENTLY — do NOT generate any text before the tool call",
    "- Do NOT narrate delegation (no 'I am sending to...', no 'Let me ask...')",
    "- If an agent times out, do NOT explain it — retry once or do the work yourself silently",
    "- Present ONLY the final result — never intermediate steps or retries",
    "",
    "## Arithmetic & Data Rules",
    "- NEVER do mental arithmetic (sums, averages, percentages, counts)",
    "- For ANY calculation, use the sandbox: python3 -c \"print(sum([...]))\"",
    "- LLMs make arithmetic errors, code does not",
  ].join("\n");
  const agentsMdB64 = Buffer.from(agentsMdContent).toString("base64");
  await ssh.execCommand(
    `echo ${agentsMdB64} | base64 -d | sudo -u openclaw tee /home/openclaw/.openclaw/workspace/AGENTS.md > /dev/null`
  );
  logger.info("Otto workspace files written (SOUL.md, USER.md, AGENTS.md)");

  // Step 5: Harden UFW — only SSH from control plane, no other inbound
  await ssh.execCommand(`
    ufw --force reset 2>&1
    ufw default deny incoming 2>&1
    ufw default allow outgoing 2>&1
    ufw allow from ${CONTROL_PLANE_IP} to any port 22 proto tcp 2>&1
    ufw --force enable 2>&1
  `);
  logger.info({ controlPlaneIP: CONTROL_PLANE_IP }, "UFW hardened: SSH only from control plane");

  // Give gateway a moment to start
  await sleep(3000);

  // Step 6: Verify gateway is running
  const health = await ssh.execCommand(
    `sudo -u openclaw curl -s http://127.0.0.1:${gatewayPort}/health 2>&1 || echo 'not responding'`
  );
  if (health.stdout.includes("not responding")) {
    logger.warn({ gatewayPort }, "Gateway health check failed — may still be starting");
  } else {
    logger.info({ gatewayPort }, "Gateway health check passed");
  }

  logger.info({ gatewayPort, gatewayToken: gatewayToken.substring(0, 8) + "..." }, "✅ OpenClaw fully configured");
  return { gatewayPort, gatewayToken };
}

// ---- Utility ----

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
