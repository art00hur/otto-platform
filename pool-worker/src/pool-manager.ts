import { eq, and, isNull, sql } from "drizzle-orm";
import { db, instances, subscriptions } from "./db.js";
import { provisionInstance } from "./jobs/provision.js";
import { logger } from "./logger.js";

export interface PoolStats {
  total: number;
  provisioning: number;
  installing: number;
  ready: number;
  assigning: number;
  active: number;
  error: number;
  recycling: number;
}

/**
 * Get current pool statistics.
 */
export async function getPoolStats(): Promise<PoolStats> {
  const all = await db.select().from(instances);

  const stats: PoolStats = {
    total: all.length,
    provisioning: 0,
    installing: 0,
    ready: 0,
    assigning: 0,
    active: 0,
    error: 0,
    recycling: 0,
  };

  for (const inst of all) {
    const status = inst.status as keyof Omit<PoolStats, "total">;
    if (status in stats) {
      stats[status]++;
    }
  }

  return stats;
}

/**
 * Core pool reconciliation loop.
 *
 * Compares current "ready" count against the target and provisions
 * new instances if needed. Also counts "provisioning" + "installing"
 * instances as in-flight to avoid over-provisioning.
 */
export async function reconcilePool(): Promise<{
  action: "none" | "provisioning";
  needed: number;
  launched: number;
}> {
  const targetReady = parseInt(process.env.POOL_TARGET_READY || "2", 10);
  const maxConcurrent = parseInt(process.env.POOL_MAX_CONCURRENT || "3", 10);

  const stats = await getPoolStats();

  // Count instances that are "ready" or on their way to being ready
  const readyOrInFlight = stats.ready + stats.provisioning + stats.installing;

  // How many more do we need?
  const deficit = targetReady - readyOrInFlight;

  if (deficit <= 0) {
    logger.debug(
      { ready: stats.ready, inFlight: stats.provisioning + stats.installing, target: targetReady },
      "Pool is at target — no action needed"
    );
    return { action: "none", needed: 0, launched: 0 };
  }

  // Don't exceed max concurrent provisioning
  const currentlyProvisioning = stats.provisioning + stats.installing;
  const canLaunch = Math.min(deficit, maxConcurrent - currentlyProvisioning);

  if (canLaunch <= 0) {
    logger.debug(
      { deficit, currentlyProvisioning, maxConcurrent },
      "At max concurrent provisioning — waiting"
    );
    return { action: "none", needed: deficit, launched: 0 };
  }

  logger.info(
    { deficit, canLaunch, ready: stats.ready, target: targetReady },
    "Pool below target — provisioning new instances"
  );

  // Launch provisioning jobs in parallel
  let launched = 0;
  const promises: Promise<void>[] = [];

  for (let i = 0; i < canLaunch; i++) {
    promises.push(
      provisionInstance()
        .then((id) => {
          launched++;
          logger.info({ instanceId: id, index: i + 1 }, "Instance provisioned successfully");
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          logger.error({ index: i + 1, error: msg }, "Instance provisioning failed");
          console.error(`❌ PROVISION ERROR [${i + 1}]: ${msg}`);
          if (stack) console.error(stack);
        })
    );
  }

  await Promise.allSettled(promises);

  return { action: "provisioning", needed: deficit, launched };
}

/**
 * Clean up instances that are stuck in transitional states.
 * Instances stuck in "provisioning" or "installing" for >15 minutes
 * are likely failed and should be cleaned up.
 */
export async function cleanupStuckInstances(): Promise<number> {
  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const stuck = await db
    .select()
    .from(instances)
    .where(
      and(
        sql`${instances.status} IN ('provisioning', 'installing')`,
        sql`${instances.created_at} < ${fifteenMinAgo}::timestamptz`
      )
    );

  if (stuck.length === 0) return 0;

  logger.warn({ count: stuck.length }, "Found stuck instances — cleaning up");

  let cleaned = 0;
  for (const inst of stuck) {
    try {
      const hetzner = await import("../providers/hetzner.js");
      await hetzner.deleteInstance(inst.provider_instance_id);
      await db.delete(instances).where(eq(instances.id, inst.id));
      cleaned++;
      logger.info({ instanceId: inst.id, age: Date.now() - inst.created_at.getTime() }, "Cleaned up stuck instance");
    } catch (err) {
      logger.error({ instanceId: inst.id, err }, "Failed to cleanup stuck instance");
      // Mark as error so it gets picked up by error cleanup
      await db
        .update(instances)
        .set({ status: "error", last_error: "Stuck in provisioning" })
        .where(eq(instances.id, inst.id));
    }
  }

  return cleaned;
}

/**
 * Get a human-readable pool status summary.
 */
export async function getPoolSummary(): Promise<string> {
  const stats = await getPoolStats();
  const target = parseInt(process.env.POOL_TARGET_READY || "2", 10);

  return [
    `🦞 Claw Pool Status`,
    `  Ready:        ${stats.ready} / ${target} target`,
    `  In-flight:    ${stats.provisioning + stats.installing}`,
    `  Active:       ${stats.active}`,
    `  Errors:       ${stats.error}`,
    `  Total:        ${stats.total}`,
  ].join("\n");
}


/**
 * Auto-assign ready VPSes to subscriptions that have no instance.
 * Runs after each pool reconciliation cycle.
 */
export async function autoAssignWaitingUsers(): Promise<number> {
  try {
    // Find subscriptions with no instance assigned
    const waiting = await db
      .select({ id: subscriptions.id, user_id: subscriptions.user_id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "active"),
          isNull(subscriptions.instance_id)
        )
      );

    if (waiting.length === 0) return 0;

    let assigned = 0;
    for (const sub of waiting) {
      // Find a ready VPS
      const [readyVPS] = await db
        .select()
        .from(instances)
        .where(eq(instances.status, "ready"))
        .limit(1);

      if (!readyVPS) {
        logger.info({ waitingUsers: waiting.length - assigned }, "No ready VPS for waiting users — will retry next cycle");
        break;
      }

      // Assign VPS to user
      await db
        .update(instances)
        .set({
          user_id: sub.user_id,
          status: "active",
          assigned_at: new Date(),
        })
        .where(eq(instances.id, readyVPS.id));

      // Link instance to subscription
      await db
        .update(subscriptions)
        .set({ instance_id: readyVPS.id })
        .where(eq(subscriptions.id, sub.id));

      assigned++;
      logger.info(
        { userId: sub.user_id, instanceId: readyVPS.id },
        "✅ Auto-assigned VPS to waiting user"
      );
    }

    return assigned;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Auto-assign failed");
    return 0;
  }
}
