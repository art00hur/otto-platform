import { NodeSSH } from "node-ssh";
import { eq, and } from "drizzle-orm";
import { db, instances } from "../db.js";
import { decrypt } from "../encryption.js";
import { logger } from "../logger.js";

/**
 * Run health checks on all active instances.
 * - Checks if the OpenClaw gateway is responding
 * - Auto-restarts if down
 * - Updates health status in DB
 */
export async function runHealthChecks(): Promise<{
  checked: number;
  healthy: number;
  unhealthy: number;
  restarted: number;
}> {
  const activeInstances = await db
    .select()
    .from(instances)
    .where(eq(instances.status, "active"));

  if (activeInstances.length === 0) {
    return { checked: 0, healthy: 0, unhealthy: 0, restarted: 0 };
  }

  logger.info({ count: activeInstances.length }, "Running health checks");

  let healthy = 0;
  let unhealthy = 0;
  let restarted = 0;

  // Run checks in parallel with concurrency limit
  const CONCURRENCY = 5;
  for (let i = 0; i < activeInstances.length; i += CONCURRENCY) {
    const batch = activeInstances.slice(i, i + CONCURRENCY);

    await Promise.allSettled(
      batch.map(async (instance) => {
        try {
          const isHealthy = await checkInstance(instance);

          if (isHealthy) {
            healthy++;
            await db
              .update(instances)
              .set({
                health_ok: true,
                last_health_check: new Date(),
                error_count: 0,
              })
              .where(eq(instances.id, instance.id));
          } else {
            unhealthy++;

            // Try auto-restart
            const didRestart = await tryAutoRestart(instance);
            if (didRestart) restarted++;

            const newErrorCount = (instance.error_count || 0) + 1;
            await db
              .update(instances)
              .set({
                health_ok: didRestart,
                last_health_check: new Date(),
                error_count: newErrorCount,
                last_error: didRestart
                  ? "Auto-restarted gateway"
                  : "Gateway unresponsive",
              })
              .where(eq(instances.id, instance.id));

            // If too many consecutive failures, mark as error
            if (newErrorCount >= 5 && !didRestart) {
              logger.error(
                { instanceId: instance.id, errorCount: newErrorCount },
                "Instance has too many consecutive failures"
              );
              await db
                .update(instances)
                .set({ status: "error" })
                .where(eq(instances.id, instance.id));
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ instanceId: instance.id, error: msg }, "Health check failed");
          unhealthy++;
        }
      })
    );
  }

  logger.info({ checked: activeInstances.length, healthy, unhealthy, restarted }, "Health checks complete");
  return { checked: activeInstances.length, healthy, unhealthy, restarted };
}

/**
 * Check a single instance: SSH in, curl the gateway health endpoint.
 */
async function checkInstance(instance: typeof instances.$inferSelect): Promise<boolean> {
  if (!instance.ssh_private_key_enc && !process.env.CONTROL_PLANE_SSH_PRIVATE_KEY) {
    logger.warn({ instanceId: instance.id }, "No SSH key — cannot health check");
    return false;
  }

  const ssh = new NodeSSH();

  try {
    const privateKey = process.env.CONTROL_PLANE_SSH_PRIVATE_KEY?.replace(/\\n/g, "\n") || decrypt(instance.ssh_private_key_enc);

    await ssh.connect({
      host: instance.ip_address,
      port: 22,
      username: "root",
      privateKey,
      readyTimeout: 10_000,
    });

    // Check 1: Does the health endpoint respond? (works regardless of how gateway was started)
    const port = instance.gateway_port || 18789;
    const healthResult = await ssh.execCommand(
      `curl -sf -m 5 http://localhost:${port}/health >/dev/null 2>&1 && echo OK || echo FAIL`
    );
    if (healthResult.stdout.trim() === "OK") {
      return true;
    }

    // Check 2: If health endpoint failed, check if process is at least running
    const processCheck = await ssh.execCommand(
      `pgrep -u openclaw -f openclaw-gateway >/dev/null 2>&1 && echo RUNNING || echo STOPPED`
    );
    if (processCheck.stdout.trim() === "RUNNING") {
      // Gateway process exists but health endpoint not responding — might still be starting
      logger.warn({ instanceId: instance.id }, "Gateway process running but health endpoint not responding");
      return false;
    }

    logger.warn({ instanceId: instance.id }, "Gateway not running");
    return false;

    return true;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ instanceId: instance.id, error: msg }, "SSH health check failed");
    return false;

  } finally {
    try { ssh.dispose(); } catch {}
  }
}

/**
 * Attempt to auto-restart the OpenClaw gateway via SSH.
 */
async function tryAutoRestart(instance: typeof instances.$inferSelect): Promise<boolean> {
  if (!instance.ssh_private_key_enc) return false;

  const ssh = new NodeSSH();

  try {
    const privateKey = process.env.CONTROL_PLANE_SSH_PRIVATE_KEY?.replace(/\\n/g, "\n") || decrypt(instance.ssh_private_key_enc);

    await ssh.connect({
      host: instance.ip_address,
      port: 22,
      username: "root",
      privateKey,
      readyTimeout: 10_000,
    });

    logger.info({ instanceId: instance.id }, "Attempting gateway auto-restart");

    // Try systemd first, fall back to manual start
    const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
    const systemdRestart = await ssh.execCommand(
      `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user restart openclaw-gateway 2>&1`
    );
    if (systemdRestart.stderr?.includes("not found") || systemdRestart.stderr?.includes("does not exist")) {
      // No systemd service — start manually
      await ssh.execCommand("pkill -u openclaw -f openclaw-gateway 2>/dev/null; sleep 2");
      await ssh.execCommand(
        `sudo -i -u openclaw openclaw gateway > /dev/null 2>&1 &`
      );
      logger.info({ instanceId: instance.id }, "Manual gateway restart (no systemd service)");
    }

    // Wait a few seconds for it to come back up
    await new Promise((r) => setTimeout(r, 5_000));

    // Verify it's back
    const port = instance.gateway_port || 18789;
    const check = await ssh.execCommand(
      `curl -sf -m 5 http://localhost:${port}/health >/dev/null 2>&1 && echo OK || echo FAIL`
    );

    const success = check.stdout.trim() === "OK";
    logger.info({ instanceId: instance.id, success }, "Auto-restart result");
    return success;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ instanceId: instance.id, error: msg }, "Auto-restart failed");
    return false;

  } finally {
    try { ssh.dispose(); } catch {}
  }
}

/**
 * Clean up stale instances that have been in "error" state too long.
 */
export async function cleanupErrorInstances(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const errorInstances = await db
    .select()
    .from(instances)
    .where(
      and(
        eq(instances.status, "error"),
        eq(instances.health_ok, false)
      )
    );

  let cleaned = 0;
  const cutoff = Date.now() - maxAgeMs;

  for (const inst of errorInstances) {
    const lastCheck = inst.last_health_check?.getTime() || 0;
    if (lastCheck < cutoff) {
      try {
        // Import dynamically to avoid circular deps
        const hetzner = await import("../providers/hetzner.js");
        await hetzner.deleteInstance(inst.provider_instance_id);
        await db.delete(instances).where(eq(instances.id, inst.id));
        cleaned++;
        logger.info({ instanceId: inst.id }, "Cleaned up stale error instance");
      } catch (err) {
        logger.error({ instanceId: inst.id, err }, "Failed to cleanup error instance");
      }
    }
  }

  return cleaned;
}
