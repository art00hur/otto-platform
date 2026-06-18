import { NodeSSH } from "node-ssh";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { decrypt } from "../utils/encryption.js";
import { resolveSSHKey } from "./ssh.js";
import { logger } from "../utils/logger.js";

// ============================================================
// Health Monitor — Periodic instance health checks with alerting
//
// Checks every 5 minutes:
//   1. SSH connectivity to VPS
//   2. OpenClaw gateway process running
//   3. Gateway WebSocket responding
//
// After 3 consecutive failures, sends a Telegram alert to the
// admin bot (if configured). Resets on recovery.
// ============================================================

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MAX_CONSECUTIVE_FAILURES = 3;

// Track failure counts per instance
const failureCounts = new Map<string, number>();
const alertSent = new Map<string, boolean>();

/**
 * Run a health check on a single instance.
 * Returns { ok, checks } with granular results.
 */
async function checkInstance(inst: {
  id: string;
  ip_address: string;
  ssh_private_key_enc: string | null;
  gateway_port: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  let ssh: NodeSSH | null = null;

  try {
    const privateKey = resolveSSHKey(inst.ssh_private_key_enc);
    ssh = new NodeSSH();
    await ssh.connect({
      host: inst.ip_address,
      username: "root",
      privateKey,
      readyTimeout: 10_000,
    });

    // Check gateway process
    const proc = await ssh.execCommand("pgrep -u openclaw -f openclaw-gateway");
    if (!proc.stdout.trim()) {
      return { ok: false, error: "Gateway process not running" };
    }

    // Check gateway HTTP
    if (inst.gateway_port) {
      const http = await ssh.execCommand(
        `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:${inst.gateway_port}/`
      );
      if (http.stdout !== "200") {
        return { ok: false, error: `Gateway HTTP returned ${http.stdout}` };
      }
    }

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  } finally {
    if (ssh) try { ssh.dispose(); } catch {}
  }
}

/**
 * Send a Telegram alert to the admin.
 * Looks for the first linked Telegram channel and sends to the admin's chat.
 */
async function sendTelegramAlert(message: string): Promise<void> {
  try {
    // Find any enabled Telegram channel with a linked admin
    const channels = await db
      .select({
        token_enc: schema.messagingChannels.token_enc,
      })
      .from(schema.messagingChannels)
      .where(eq(schema.messagingChannels.provider, "telegram"))
      .limit(1);

    if (channels.length === 0) {
      logger.warn("Health alert: no Telegram channel configured for alerting");
      return;
    }

    // Use ADMIN_ALERT_CHAT_ID env var for alert destination
    const adminChatId = process.env.ADMIN_ALERT_CHAT_ID;
    if (!adminChatId) {
      logger.warn("Health alert: ADMIN_ALERT_CHAT_ID not set, logging only");
      logger.error({ alert: message }, "HEALTH ALERT (no Telegram delivery)");
      return;
    }

    const botToken = decrypt(channels[0].token_enc);
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: adminChatId,
          text: message,
          parse_mode: "Markdown",
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    logger.info("Health alert sent via Telegram");
  } catch (err: any) {
    logger.error({ err: err.message }, "Failed to send health alert via Telegram");
  }
}

/**
 * Run health checks on all active instances.
 */
async function runHealthChecks(): Promise<void> {
  try {
    const activeInstances = await db
      .select({
        id: schema.instances.id,
        ip_address: schema.instances.ip_address,
        ssh_private_key_enc: schema.instances.ssh_private_key_enc,
        gateway_port: schema.instances.gateway_port,
        user_id: schema.instances.user_id,
      })
      .from(schema.instances)
      .where(eq(schema.instances.status, "active"));

    for (const inst of activeInstances) {
      const result = await checkInstance(inst);

      if (result.ok) {
        // Recovery: reset failure count
        const prevCount = failureCounts.get(inst.id) || 0;
        if (prevCount > 0) {
          logger.info({ instanceId: inst.id, prevFailures: prevCount }, "Instance recovered");
          if (alertSent.get(inst.id)) {
            sendTelegramAlert(`✅ *Instance recovered*\nIP: ${inst.ip_address}\nPrevious failures: ${prevCount}`).catch(() => {});
            alertSent.set(inst.id, false);
          }
        }
        failureCounts.set(inst.id, 0);

        // Update DB health status
        await db
          .update(schema.instances)
          .set({ health_ok: true, last_health_check: new Date(), last_error: null })
          .where(eq(schema.instances.id, inst.id));
      } else {
        const count = (failureCounts.get(inst.id) || 0) + 1;
        failureCounts.set(inst.id, count);

        logger.warn(
          { instanceId: inst.id, ip: inst.ip_address, error: result.error, consecutiveFailures: count },
          "Health check failed"
        );

        // Update DB
        await db
          .update(schema.instances)
          .set({
            health_ok: false,
            last_health_check: new Date(),
            last_error: result.error || "Health check failed",
          })
          .where(eq(schema.instances.id, inst.id));

        // Alert after N consecutive failures
        if (count >= MAX_CONSECUTIVE_FAILURES && !alertSent.get(inst.id)) {
          const msg = `🔴 *ALERTE: Instance down*\nIP: \`${inst.ip_address}\`\nErreur: ${result.error}\nEchecs consecutifs: ${count}\n\nVerifie le VPS et le gateway.`;
          sendTelegramAlert(msg).catch(() => {});
          alertSent.set(inst.id, true);
        }
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "Health monitor cycle failed");
  }
}

/**
 * Start the health monitor background loop.
 */
export function startHealthMonitor(): void {
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, "Health monitor started");

  // Run first check after 30s (let server finish startup)
  setTimeout(() => {
    runHealthChecks();
    setInterval(runHealthChecks, CHECK_INTERVAL_MS);
  }, 30_000);
}
