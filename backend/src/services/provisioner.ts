import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import * as hetzner from "./hetzner.js";
import { logger } from "../utils/logger.js";

/**
 * Recycle an instance — wipe user data and return to pool, or destroy.
 */
export async function recycleInstance(instanceId: string): Promise<void> {
  const [instance] = await db
    .select()
    .from(schema.instances)
    .where(eq(schema.instances.id, instanceId));

  if (!instance) return;

  logger.info({ instanceId }, "Recycling instance — resetting workspace");

  await db
    .update(schema.instances)
    .set({ status: "recycling" })
    .where(eq(schema.instances.id, instanceId));

  try {
    // 1. Delete per-customer OpenRouter key if it exists
    if (instance.openrouter_key_hash && process.env.OPENROUTER_PROVISIONING_KEY) {
      try {
        const delRes = await fetch(`https://openrouter.ai/api/v1/keys/${instance.openrouter_key_hash}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + process.env.OPENROUTER_PROVISIONING_KEY },
        });
        if (delRes.ok) {
          logger.info({ instanceId, keyHash: instance.openrouter_key_hash.slice(0, 12) }, "Deleted OpenRouter key");
        }
      } catch (err: any) {
        logger.warn({ instanceId, error: err.message }, "Failed to delete OpenRouter key");
      }
    }

    // 2. SSH into VPS and reset workspace
    let resetSuccess = false;
    if (instance.ip_address && instance.ssh_private_key_enc) {
      try {
        const { NodeSSH } = await import("node-ssh");
        const { resolveSSHKey: resolveKey } = await import("./ssh.js");
        const ssh = new NodeSSH();
        await ssh.connect({
          host: instance.ip_address,
          port: 22,
          username: "root",
          privateKey: resolveKey(instance.ssh_private_key_enc),
          readyTimeout: 15000,
        });

        // Stop the gateway
        const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
        const sysEnv = `XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`;
        await ssh.execCommand(`sudo -u openclaw ${sysEnv} systemctl --user stop openclaw-gateway 2>&1`);

        // Remove all extra agents (keep only main)
        const configResult = await ssh.execCommand("sudo -u openclaw cat /home/openclaw/.openclaw/openclaw.json 2>/dev/null");
        if (configResult.stdout) {
          try {
            const config = JSON.parse(configResult.stdout);
            const agentList = config.agents?.list || [];
            for (const agent of agentList) {
              if (agent.id !== "main") {
                await ssh.execCommand(`sudo -u openclaw openclaw agents delete '${agent.id}' --force 2>&1`);
                logger.info({ instanceId, agentId: agent.id }, "Deleted agent during recycle");
              }
            }
          } catch {}
        }

        // Wipe main agent workspace files
        await ssh.execCommand("sudo -u openclaw rm -rf /home/openclaw/.openclaw/workspace/memory/ 2>/dev/null");
        await ssh.execCommand("sudo -u openclaw rm -f /home/openclaw/.openclaw/workspace/MEMORY.md 2>/dev/null");
        await ssh.execCommand("sudo -u openclaw rm -f /home/openclaw/.openclaw/workspace/TOOLS.md 2>/dev/null");
        await ssh.execCommand("sudo -u openclaw rm -f /home/openclaw/.openclaw/workspace/BOOTSTRAP.md 2>/dev/null");

        // Reset SOUL.md to default
        await ssh.execCommand(`cat > /tmp/otto-soul.md << 'SOULEOF'
# Otto Agent — Assistant

**Emoji:** 🤖
SOULEOF
sudo -u openclaw cp /tmp/otto-soul.md /home/openclaw/.openclaw/workspace/SOUL.md && rm /tmp/otto-soul.md`);

        // Reset USER.md to default
        await ssh.execCommand(`cat > /tmp/otto-user.md << 'USEREOF'
# About My Human

**Name:**

## Company


## Notes & Preferences

USEREOF
sudo -u openclaw cp /tmp/otto-user.md /home/openclaw/.openclaw/workspace/USER.md && rm /tmp/otto-user.md`);

        // Reset main agent identity in openclaw.json
        await ssh.execCommand("sudo -u openclaw openclaw agents set-identity --agent main --name 'Otto Agent' --theme 'helpful business assistant' --emoji '🤖' --json 2>&1");

        // Disable agentToAgent (single agent now)
        await ssh.execCommand("sudo -u openclaw openclaw config set tools.agentToAgent.enabled false 2>&1");

        // Clear WhatsApp session data if any
        await ssh.execCommand("sudo -u openclaw rm -rf /home/openclaw/.openclaw/channels/whatsapp/ 2>/dev/null");

        // Restart gateway with clean state
        await ssh.execCommand(`sudo -u openclaw ${sysEnv} systemctl --user daemon-reload 2>&1`);
        await ssh.execCommand(`sudo -u openclaw ${sysEnv} systemctl --user start openclaw-gateway 2>&1`);

        ssh.dispose();
        resetSuccess = true;
        logger.info({ instanceId }, "Workspace reset complete");
      } catch (sshErr: any) {
        logger.warn({ instanceId, error: sshErr.message }, "SSH reset failed — falling back to destroy");
      }
    }

    if (resetSuccess) {
      // Return to pool as ready
      await db
        .update(schema.instances)
        .set({
          user_id: null,
          status: "ready",
          openrouter_key_hash: null,
          agent_hierarchy: "{}",
          last_error: null,
          error_count: 0,
          assigned_at: null,
        })
        .where(eq(schema.instances.id, instanceId));

      logger.info({ instanceId }, "✅ Instance recycled and returned to pool");
    } else {
      // Fallback: destroy VPS and let pool worker create a fresh one
      await hetzner.deleteServer(instance.provider_instance_id);
      await db
        .delete(schema.instances)
        .where(eq(schema.instances.id, instanceId));

      logger.info({ instanceId }, "Instance destroyed (fallback)");
    }
  } catch (error) {
    logger.error({ instanceId, error }, "Failed to recycle instance");
  }
}
