import type { FastifyInstance } from "fastify";
import { NodeSSH } from "node-ssh";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { resolveSSHKey } from "../services/ssh.js";

/**
 * Agent Management API — Add, list, and delete agents on a customer VPS.
 *
 * Uses SSH to run `openclaw agents add/delete/set-identity` commands,
 * then restarts the gateway to pick up changes.
 *
 * Routes:
 *   GET  /api/agents/:instanceId/list          — List all agents on VPS
 *   POST /api/agents/:instanceId/add           — Add a new agent
 *   POST /api/agents/:instanceId/delete        — Delete an agent
 */

// Plan agent limits
const PLAN_AGENT_LIMITS: Record<string, number> = {
  free: 1,
  starter: 1,
  pro: 5,
  ultra: 12,
};

// Extra agents purchased via top-up (tracked in subscription metadata)
// For now, we allow +1 per $30 top-up. Tracked via `extra_agents` column.

// ── Auth helper ──

async function authenticateAndAuthorize(
  request: any,
  reply: any
): Promise<{ userId: string; instanceId: string; plan: string; extraSlots: number } | null> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing token" });
    return null;
  }

  const decoded = verifyJWT(auth.slice(7));
  if (!decoded) {
    reply.code(401).send({ error: "Invalid token" });
    return null;
  }

  const instanceId = (request.params as any).instanceId;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      instanceId
    )
  ) {
    reply.code(400).send({ error: "Invalid instance ID" });
    return null;
  }

  const userId = decoded.userId;

  const [sub] = await db
    .select({
      instance_id: subscriptions.instance_id,
      plan: subscriptions.plan,
      extra_agent_slots: subscriptions.extra_agent_slots,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.instance_id, instanceId)
      )
    );

  if (!sub) {
    reply.code(403).send({ error: "Not authorized for this instance" });
    return null;
  }

  return { userId, instanceId, plan: sub.plan, extraSlots: sub.extra_agent_slots || 0 };
}

// ── SSH helper ──

async function sshToInstance(
  instanceId: string
): Promise<{ ssh: NodeSSH; ip: string }> {
  const [instance] = await db
    .select({
      ip_address: instances.ip_address,
      ssh_private_key_enc: instances.ssh_private_key_enc,
      status: instances.status,
    })
    .from(instances)
    .where(eq(instances.id, instanceId));

  if (!instance) throw new Error("Instance not found");
  if (instance.status !== "active")
    throw new Error(`Instance not active (${instance.status})`);
  const privateKey = resolveSSHKey(instance.ssh_private_key_enc);

  const ssh = new NodeSSH();
  // Retry SSH connection up to 3 times with exponential backoff
  // (freshly provisioned VPS may still be booting)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ssh.connect({
        host: instance.ip_address,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 15_000,
      });
      break;
    } catch (e: any) {
      if (attempt === 3) throw e;
      logger.warn({ instanceId, attempt, error: e.message }, "SSH connect failed, retrying...");
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }

  return { ssh, ip: instance.ip_address };
}

function sanitizeId(input: string): string {
  // Agent IDs: lowercase alphanumeric + hyphens, max 30 chars
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

function sanitizeName(input: string): string {
  // Strip anything dangerous for shell, keep readable
  return input.replace(/['"\\`$]/g, "").slice(0, 50);
}

function sanitizeEmoji(input: string): string {
  // Keep the full emoji including ZWJ sequences (e.g. 👩‍💼)
  // Use Intl.Segmenter if available, otherwise allow up to 12 UTF-16 code units
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const first = segmenter.segment(input)[Symbol.iterator]().next().value;
    return first?.segment || input.slice(0, 4);
  }
  // Fallback: allow ZWJ sequences up to 12 chars (covers most compound emojis)
  const match = input.match(/^(\p{Emoji}(?:\u200D\p{Emoji})*(?:\uFE0F)?)/u);
  return match ? match[1] : input.slice(0, 4);
}

// ── Routes ──

async function rebuildAllAgentsMd(ssh: NodeSSH, instanceId: string) {
  const res = await ssh.execCommand("sudo -u openclaw openclaw agents list --json 2>&1");
  let agents: { id: string; identityName?: string }[] = [];
  try { agents = JSON.parse(res.stdout); } catch { return; }
  if (agents.length < 2) return;

  for (const ag of agents) {
    const workspace = ag.id === "main"
      ? "/home/openclaw/.openclaw/workspace"
      : "/home/openclaw/.openclaw/agents/" + ag.id + "/workspace";

    const existing = await ssh.execCommand("sudo -u openclaw cat " + workspace + "/AGENTS.md 2>/dev/null");
    let content = existing.stdout || "";

    const teammates = agents.filter(a => a.id !== ag.id);
    const teamList = teammates.map(t => "- **" + (t.identityName || t.id) + "** — session key: `agent:" + t.id + ":main`").join("\n");

    const rosterBlock = `<!-- OTTO:TEAM:START -->
# Team & Delegation

## Your Team
${teamList}

## How to Delegate
Use sessions_send to communicate with other agents:
- sessionKey: the agent's session key (e.g. agent:hugo:main)
- message: a detailed task description with ALL context needed
- timeoutSeconds: 240 (always set this — web searches need extra time)

Example: sessions_send(sessionKey: "agent:hugo:main", message: "TÂCHE: Find 3 companies... CONTEXTE: ... FORMAT ATTENDU: ...", timeoutSeconds: 240)

## Delegation Rules
- ALWAYS use sessions_send with timeoutSeconds: 240
- NEVER use sessions_spawn (it restricts the target agent's tools)
- NEVER use the message tool for agent-to-agent communication
- Include ALL relevant data in your message — agents don't share memory or files
- If an agent needs data to do their work, YOU must include that data in the delegation message
- Wait for the response before presenting results to the human

## Communication Rules
- When delegating, call sessions_send SILENTLY — do NOT generate any text before the tool call
- Do NOT narrate what you are about to do ("Je transmets à...", "Let me ask...", "Je vais demander à...")
- If an agent times out, do NOT explain the timeout to the user — either retry once or do the work yourself silently
- Present ONLY the final result to the user — never intermediate steps, retries, or internal process
- Deliver ONE clean, structured message per task — not multiple messages

## Arithmetic & Data Rules
- NEVER do mental arithmetic (sums, averages, percentages, counts)
- For ANY calculation, use the sandbox to run Python code: python3 -c "print(sum([...]))"
- This applies to all agents — LLMs make arithmetic errors, code does not
<!-- OTTO:TEAM:END -->`;

    if (content.includes("<!-- OTTO:TEAM:START -->") && content.includes("<!-- OTTO:TEAM:END -->")) {
      content = content.replace(/<!-- OTTO:TEAM:START -->[\s\S]*?<!-- OTTO:TEAM:END -->/, rosterBlock);
    } else if (content.includes("# Team & Delegation")) {
      content = rosterBlock + "\n\n## Memory & Files\n- Read SOUL.md, USER.md, and memory/ at session start\n- Write important decisions to memory/YYYY-MM-DD.md\n";
    } else if (content.trim()) {
      content = rosterBlock + "\n\n" + content;
    } else {
      content = rosterBlock + "\n\n## Memory & Files\n- Read SOUL.md, USER.md, and memory/ at session start\n- Write important decisions to memory/YYYY-MM-DD.md\n";
    }

    const b64 = Buffer.from(content).toString("base64");
    await ssh.execCommand("echo " + b64 + " | base64 -d | sudo -u openclaw tee " + workspace + "/AGENTS.md > /dev/null");
  }
  logger.info({ instanceId, agentCount: agents.length }, "AGENTS.md roster rebuilt for all agents");
}

export async function agentManagementRoutes(app: FastifyInstance) {
  /**
   * GET /api/agents/:instanceId/list — List all agents on the VPS.
   * Returns agent IDs, names, roles, emojis from openclaw.json.
   */
  app.get("/agents/:instanceId/list", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;

    let ssh: NodeSSH | null = null;
    try {
      const conn = await sshToInstance(auth.instanceId);
      ssh = conn.ssh;

      // Read agents from config
      const result = await ssh.execCommand(
        `sudo -u openclaw cat /home/openclaw/.openclaw/openclaw.json`
      );

      if (result.code !== 0) {
        throw new Error("Failed to read config: " + result.stderr);
      }

      const config = JSON.parse(result.stdout);
      const agentList = config.agents?.list || [];

      const agents = agentList.map((a: any) => ({
        id: a.id,
        name: a.identity?.name || a.name || a.id,
        theme: a.identity?.theme || "",
        emoji: a.identity?.emoji || "🤖",
        model: a.model || config.agents?.defaults?.model?.primary || "openrouter/anthropic/claude-sonnet-4-5",
      }));

      return { ok: true, agents };
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "Failed to list agents"
      );
      return reply.code(502).send({ error: "Failed to list agents: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  /**
   * POST /api/agents/:instanceId/add — Add a new agent to the VPS.
   *
   * Body: { name: string, role: string, emoji: string }
   *
   * Steps:
   * 1. Check plan limits
   * 2. SSH into VPS
   * 3. Run `openclaw agents add`
   * 4. Run `openclaw agents set-identity`
   * 5. Restart gateway
   * 6. Return new agent info
   */
  app.post("/agents/:instanceId/add", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;

    const body = request.body as any;
    const name = sanitizeName(body?.name || "");
    const role = sanitizeName(body?.role || "");
    const emoji = sanitizeEmoji(body?.emoji || "🤖");

    if (!name || name.length < 2) {
      return reply.code(400).send({ error: "Agent name is required (min 2 characters)" });
    }
    if (!role) {
      return reply.code(400).send({ error: "Agent role is required" });
    }

    // Generate agent ID from name
    const agentId = sanitizeId(name);
    if (!agentId) {
      return reply.code(400).send({ error: "Invalid agent name — must contain letters or numbers" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const conn = await sshToInstance(auth.instanceId);
      ssh = conn.ssh;

      // Check current agent count vs plan limit
      const configResult = await ssh.execCommand(
        `sudo -u openclaw cat /home/openclaw/.openclaw/openclaw.json`
      );
      const config = JSON.parse(configResult.stdout);
      const currentAgents = config.agents?.list || [];
      const planLimit = (PLAN_AGENT_LIMITS[auth.plan] || 1) + auth.extraSlots;

      if (currentAgents.length >= planLimit) {
        return reply.code(403).send({
          error: `Agent limit reached (${currentAgents.length}/${planLimit}). Upgrade your plan or purchase an extra agent slot.`,
          currentCount: currentAgents.length,
          limit: planLimit,
        });
      }

      // Check for duplicate ID
      if (currentAgents.some((a: any) => a.id === agentId)) {
        return reply.code(409).send({ error: `An agent with ID '${agentId}' already exists` });
      }

      // Step 1: Add agent via CLI
      const addResult = await ssh.execCommand(
        `sudo -u openclaw openclaw agents add '${agentId}' --model openrouter/anthropic/claude-sonnet-4-5 --non-interactive --workspace /home/openclaw/.openclaw/agents/${agentId}/workspace --json 2>&1`
      );

      if (addResult.code !== 0) {
        throw new Error("Failed to add agent: " + addResult.stderr + addResult.stdout);
      }

      logger.info({ instanceId: auth.instanceId, agentId }, "Agent added via CLI");

      // Step 2: Set identity
      const identityResult = await ssh.execCommand(
        `sudo -u openclaw openclaw agents set-identity --agent '${agentId}' --name '${name}' --theme '${role}' --emoji '${emoji}' --json 2>&1`
      );

      if (identityResult.code !== 0) {
        logger.warn({ instanceId: auth.instanceId, agentId, error: identityResult.stderr }, "set-identity failed (non-fatal)");
      }

      // Step 3: Create default SOUL.md for the new agent
      const soulContent = `# ${name} — ${role}

**Emoji:** ${emoji}
`;

      await ssh.execCommand(
        `sudo -u openclaw mkdir -p /home/openclaw/.openclaw/agents/${agentId}/workspace && cat > /tmp/soul-${agentId}.md << 'SOULEOF'
${soulContent}
SOULEOF
sudo -u openclaw cp /tmp/soul-${agentId}.md /home/openclaw/.openclaw/agents/${agentId}/workspace/SOUL.md && rm /tmp/soul-${agentId}.md`
      );

      // Step 3b: Create default USER.md for the new agent
      const userMd = "# About My Human\n";
      const userB64 = Buffer.from(userMd).toString("base64");
      await ssh.execCommand(
        `echo ${userB64} | base64 -d | sudo -u openclaw tee /home/openclaw/.openclaw/agents/${agentId}/workspace/USER.md > /dev/null`
      );

      // Step 3c: Create default AGENTS.md for the new agent
      const agentsMdLines = [
        "# Your Workspace", "",
        "This folder is your home. Everything you need is here.", "",
        "## Every Session", "",
        "Before doing anything else:", "",
        "1. Read SOUL.md — this is who you are",
        "2. Read USER.md — this is who you're helping",
        "3. Check the memory folder for recent context (today + yesterday)",
        "4. In direct chats, also read MEMORY.md for long-term context", "",
        "Do this silently — no need to announce it.", "",
        "## Memory", "",
        "You start fresh each session. These files are your continuity:", "",
        "- Daily notes: memory/YYYY-MM-DD.md — what happened today",
        "- Long-term: MEMORY.md — curated memories and key context", "",
        "When someone says remember this or you learn something important, write it down immediately. Mental notes don't survive restarts — files do.", "",
        "Periodically review daily files and update MEMORY.md with what's worth keeping long-term.", "",
        "## Being Proactive", "",
        "When you receive a heartbeat check-in, use it productively:", "",
        "Things to check (rotate through, a few times per day):",
        "- Emails — any urgent unread messages?",
        "- Calendar — upcoming events in next 24-48 hours?",
        "- Tasks — anything pending or overdue?", "",
        "When to reach out:",
        "- Important email or message arrived",
        "- Calendar event coming up soon",
        "- You found something relevant to current projects", "",
        "When to stay quiet:",
        "- Late night (11pm - 8am) unless urgent",
        "- Nothing new since last check",
        "- Your human is clearly busy", "",
        "Background work you can do without asking:",
        "- Organize and update memory files",
        "- Review and summarize recent activity",
        "- Prepare briefings", "",
        "## Safety", "",
        "- Never share private data externally",
        "- Don't run destructive actions without asking",
        "- When in doubt, ask", "",
        "Do freely: Read files, search the web, organize, research, work within your workspace", "",
        "Ask first: Send emails, post publicly, anything that leaves the workspace",
      ];
      // Rebuild AGENTS.md with team roster for all agents
      await rebuildAllAgentsMd(ssh, auth.instanceId);

      // Overwrite SOUL.md with clean version including section headings
      // that match the dashboard's expected format for settings parsing
      const cleanName = name.replace(/'/g, "");
      const cleanRole = role.replace(/'/g, "");
      await ssh.execCommand(`cat > /tmp/otto-soul-${agentId}.md << 'SOULEOF'
# ${cleanName} — ${cleanRole}

**Emoji:** ${emoji}

## Personality & Communication Style

## Key Responsibilities

## Rules & Boundaries

## General Guidelines
SOULEOF
sudo -u openclaw cp /tmp/otto-soul-${agentId}.md /home/openclaw/.openclaw/agents/${agentId}/workspace/SOUL.md && rm /tmp/otto-soul-${agentId}.md`);
      // Step 4: Enable agent-to-agent communication (auto-enable on 2+ agents)
      await ssh.execCommand(
        "sudo -u openclaw openclaw config set tools.agentToAgent.enabled true 2>&1"
      );
      await ssh.execCommand(
        "sudo -u openclaw openclaw config set tools.sessions.visibility all 2>&1"
      );
      // Get current agent list and set allow list + subagents.allowAgents
      const agentListRes = await ssh.execCommand(
        "sudo -u openclaw openclaw agents list --json 2>&1"
      );
      try {
        const agentsList = JSON.parse(agentListRes.stdout);
        const subIds = agentsList.map((a: any) => a.id);
        // Include "main" — openclaw agents list only returns sub-agents,
        // but the main agent also needs to be in the allow list to use sessions_send
        const allIds = ["main", ...subIds.filter((id: string) => id !== "main")];
        if (allIds.length > 1) {
          await ssh.execCommand(
            "sudo -u openclaw openclaw config set tools.agentToAgent.allow '" + JSON.stringify(allIds) + "' 2>&1"
          );
          // Set subagents.allowAgents + maxPingPongTurns
          const patchScript = [
            "import json, sys",
            "patch = json.loads(sys.stdin.read())",
            "with open('/home/openclaw/.openclaw/openclaw.json', 'r') as f:",
            "    c = json.load(f)",
            "for a in c['agents']['list']:",
            "    aid = a['id']",
            "    if aid in patch['aa']:",
            "        a['subagents'] = {'allowAgents': patch['aa'][aid]}",
            "    if aid != 'main' and 'workspace' not in a:",
            "        a['workspace'] = f'/home/openclaw/.openclaw/agents/{aid}/workspace'",
            "c.setdefault('session', {}).setdefault('agentToAgent', {})['maxPingPongTurns'] = patch['pt']",
            "with open('/home/openclaw/.openclaw/openclaw.json', 'w') as f:",
            "    json.dump(c, f, indent=2)",
            "print('ok')",
          ].join("\n");
          const patchScriptB64 = Buffer.from(patchScript).toString("base64");
          const patchData = JSON.stringify({
            aa: Object.fromEntries(subIds.map((id: string) => [id, allIds.filter((otherId: string) => otherId !== id)])),
            pt: 0,
          });
          const patchDataB64 = Buffer.from(patchData).toString("base64");
          await ssh.execCommand(
            "echo " + patchScriptB64 + " | base64 -d > /tmp/otto-patch.py && echo " + patchDataB64 + " | base64 -d | sudo -u openclaw python3 /tmp/otto-patch.py && rm /tmp/otto-patch.py"
          );
          logger.info({ instanceId: auth.instanceId, agents: allIds }, "Agent-to-agent + subagents.allowAgents configured");
        }
      } catch {}

      // Step 5: Restart gateway to pick up new agent
      const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
      await ssh.execCommand(
        `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user restart openclaw-gateway 2>&1`
      );

      // Wait for gateway to become responsive (poll instead of fixed sleep)
      const gwPort = (await ssh.execCommand("sudo -u openclaw openclaw config get gateway.port 2>/dev/null || echo 4100")).stdout.trim() || "4100";
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await ssh.execCommand(`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${gwPort}/health 2>/dev/null || echo 000`);
        if (check.stdout.trim() !== "000") {
          logger.info({ instanceId: auth.instanceId, attempt }, "Gateway ready after restart");
          break;
        }
        if (attempt === 4) {
          logger.warn({ instanceId: auth.instanceId }, "Gateway not responding after 10s — proceeding anyway");
        }
      }

      logger.info(
        { instanceId: auth.instanceId, agentId, name, role, emoji },
        "Agent created and gateway restarted"
      );

      return {
        ok: true,
        agent: { id: agentId, name, role, emoji, model: "openrouter/anthropic/claude-sonnet-4-5" },
      };
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "Failed to add agent"
      );
      return reply.code(502).send({ error: "Failed to add agent: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  /**
   * POST /api/agents/:instanceId/delete — Delete an agent from the VPS.
   *
   * Body: { agentId: string }
   */
  app.post("/agents/:instanceId/delete", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;

    const body = request.body as any;
    const agentId = sanitizeId(body?.agentId || "");

    if (!agentId) {
      return reply.code(400).send({ error: "agentId is required" });
    }
    if (agentId === "main") {
      return reply.code(400).send({ error: "Cannot delete the default agent" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const conn = await sshToInstance(auth.instanceId);
      ssh = conn.ssh;

      // Delete agent via CLI
      const result = await ssh.execCommand(
        `sudo -u openclaw openclaw agents delete '${agentId}' --force 2>&1`
      );

      if (result.code !== 0) {
        throw new Error("Failed to delete agent: " + result.stderr + result.stdout);
      }

      // Restart gateway
      const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
      await ssh.execCommand(
        `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user restart openclaw-gateway 2>&1`
      );

      await new Promise((r) => setTimeout(r, 3000));

      logger.info(
        { instanceId: auth.instanceId, agentId },
        "Agent deleted and gateway restarted"
      );

      // Rebuild AGENTS.md for remaining agents
      try {
        await rebuildAllAgentsMd(ssh, auth.instanceId);
      } catch (rebuildErr: any) {
        logger.warn({ error: (rebuildErr as Error).message }, "Failed to rebuild AGENTS.md after deletion (non-fatal)");
      }

      return { ok: true, deleted: agentId };
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "Failed to delete agent"
      );
      return reply.code(502).send({ error: "Failed to delete agent: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  /**
   * POST /api/agents/:instanceId/set-identity — Update an agent's config identity.
   * This syncs the identity in openclaw.json so fetchAgentsFromAPI returns the correct name.
   *
   * Body: { agentId: string, name: string, role: string, emoji: string }
   */
  app.post("/agents/:instanceId/set-identity", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;

    const body = request.body as any;
    const agentId = sanitizeId(body?.agentId || "main");
    const name = sanitizeName(body?.name || "");
    const role = sanitizeName(body?.role || "");
    const emoji = sanitizeEmoji(body?.emoji || "🤖");

    logger.info({ instanceId: auth.instanceId, agentId, name, role, emoji }, "set-identity: received request");

    if (!name) {
      return reply.code(400).send({ error: "name is required" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const conn = await sshToInstance(auth.instanceId);
      ssh = conn.ssh;

      // Patch openclaw.json identity directly instead of using `openclaw agents set-identity`
      // which overwrites SOUL.md with a minimal template, causing a race condition with
      // the gateway hot-reload (300ms debounce) that reverts user-written SOUL.md content.
      const patchScript = [
        "import json, sys",
        "patch = json.loads(sys.stdin.read())",
        "with open('/home/openclaw/.openclaw/openclaw.json', 'r') as f:",
        "    c = json.load(f)",
        "target = patch['agentId']",
        "if target == 'main':",
        "    c.setdefault('identity', {})['name'] = patch['name']",
        "    c['identity']['theme'] = patch['role']",
        "    c['identity']['emoji'] = patch['emoji']",
        "else:",
        "    for a in c.get('agents', {}).get('list', []):",
        "        if a['id'] == target:",
        "            a.setdefault('identity', {})['name'] = patch['name']",
        "            a['identity']['theme'] = patch['role']",
        "            a['identity']['emoji'] = patch['emoji']",
        "            break",
        "    else:",
        "        print(json.dumps({'error': 'agent not found'}))",
        "        sys.exit(1)",
        "with open('/home/openclaw/.openclaw/openclaw.json', 'w') as f:",
        "    json.dump(c, f, indent=2)",
        "print(json.dumps({'ok': True}))",
      ].join("\n");

      const patchScriptB64 = Buffer.from(patchScript).toString("base64");
      const patchData = JSON.stringify({ agentId, name, role, emoji });
      const patchDataB64 = Buffer.from(patchData).toString("base64");

      const result = await ssh.execCommand(
        "echo " + patchScriptB64 + " | base64 -d > /tmp/otto-identity-patch.py && echo " + patchDataB64 + " | base64 -d | sudo -u openclaw python3 /tmp/otto-identity-patch.py && rm /tmp/otto-identity-patch.py"
      );

      if (result.code !== 0) {
        throw new Error("Failed to patch identity: " + result.stderr + result.stdout);
      }

      // Verify the patch succeeded
      try {
        const output = JSON.parse(result.stdout);
        if (output.error) throw new Error(output.error);
      } catch (parseErr: any) {
        if (parseErr.message === "agent not found") throw parseErr;
        // If stdout isn't valid JSON but exit code was 0, the write succeeded
      }

      logger.info({ instanceId: auth.instanceId, agentId, name, role, emoji }, "Agent identity patched in openclaw.json (SOUL.md preserved)");

      // Rebuild AGENTS.md roster with updated name (#2 fix — rename propagation)
      try { await rebuildAllAgentsMd(ssh, auth.instanceId); } catch {}

      return { ok: true, agent: { id: agentId, name, role, emoji } };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, error: e.message }, "Failed to set identity");
      return reply.code(502).send({ error: "Failed to set identity: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  logger.info("Agent management routes registered");
}
