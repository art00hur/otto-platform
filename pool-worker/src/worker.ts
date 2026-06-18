import "dotenv/config";
import { logger } from "./logger.js";
import { reconcilePool, cleanupStuckInstances, getPoolSummary, autoAssignWaitingUsers } from "./pool-manager.js";
import { initPersistentKey } from "./providers/hetzner.js";
import { runHealthChecks, cleanupErrorInstances } from "./jobs/health-check.js";

// ============================================================
// Claw Pool Worker
//
// Runs three recurring jobs:
//   1. Pool reconciliation  — keep N ready instances in the pool
//   2. Health checks         — monitor active instances, auto-restart
//   3. Cleanup              — remove stuck/error instances
// ============================================================

const POOL_INTERVAL = parseInt(process.env.POOL_CHECK_INTERVAL_MS || "30000", 10);
const HEALTH_INTERVAL = 60_000;      // Check health every 1 minute
const CLEANUP_INTERVAL = 300_000;    // Cleanup every 5 minutes
const SUMMARY_INTERVAL = 120_000;    // Log pool summary every 2 minutes

let isShuttingDown = false;

async function runPoolLoop() {
  while (!isShuttingDown) {
    try {
      const result = await reconcilePool();
      if (result.action === "provisioning") {
        logger.info(
          { needed: result.needed, launched: result.launched },
          "Pool reconciliation: launched instances"
        );
      }

      // Auto-assign ready VPSes to users waiting for one
      const autoAssigned = await autoAssignWaitingUsers();
      if (autoAssigned > 0) {
        logger.info({ assigned: autoAssigned }, "Auto-assigned VPSes to waiting users");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Pool reconciliation failed");
    }

    await sleep(POOL_INTERVAL);
  }
}

async function runHealthLoop() {
  // Wait 30s before first health check to let things settle
  await sleep(30_000);

  while (!isShuttingDown) {
    try {
      await runHealthChecks();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Health check loop failed");
    }

    await sleep(HEALTH_INTERVAL);
  }
}

async function runCleanupLoop() {
  // Wait 60s before first cleanup
  await sleep(60_000);

  while (!isShuttingDown) {
    try {
      const stuckCleaned = await cleanupStuckInstances();
      const errorCleaned = await cleanupErrorInstances();

      if (stuckCleaned > 0 || errorCleaned > 0) {
        logger.info(
          { stuckCleaned, errorCleaned },
          "Cleanup completed"
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Cleanup loop failed");
    }

    await sleep(CLEANUP_INTERVAL);
  }
}

async function runSummaryLoop() {
  while (!isShuttingDown) {
    try {
      const summary = await getPoolSummary();
      logger.info(summary);
    } catch (err) {
      // Non-critical — just skip
    }

    await sleep(SUMMARY_INTERVAL);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  logger.info("🦞 Claw Pool Worker starting");
  console.log("🦞 Pool Worker starting");
  console.log("ENV CHECK:", {
    HETZNER_API_TOKEN: process.env.HETZNER_API_TOKEN ? `set (${process.env.HETZNER_API_TOKEN.substring(0, 8)}...)` : "❌ NOT SET",
    DATABASE_URL: process.env.DATABASE_URL ? "set" : "❌ NOT SET",
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ? "set" : "❌ NOT SET",
    POOL_REGION: process.env.POOL_REGION || "nbg1 (default)",
    POOL_TARGET_READY: process.env.POOL_TARGET_READY || "10 (default)",
    POOL_INSTANCE_TYPE: process.env.POOL_INSTANCE_TYPE || "cx23 (default)",
  });

  // Test Hetzner API connectivity
  try {
    console.log("🔍 Testing Hetzner API connectivity...");
    const res = await fetch("https://api.hetzner.cloud/v1/locations", {
      headers: { Authorization: `Bearer ${process.env.HETZNER_API_TOKEN}` },
    });
    if (res.ok) {
      const data = await res.json() as any;
      const locations = data.locations?.map((l: any) => l.name).join(", ");
      console.log(`✅ Hetzner API OK — available locations: ${locations}`);
    } else {
      const body = await res.text();
      console.error(`❌ Hetzner API returned ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error("❌ Cannot reach Hetzner API:", err instanceof Error ? err.message : err);
  }

  // Test SSH key generation (pure Node.js crypto)
  try {
    const { generateKeyPairSync } = await import("node:crypto");
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    console.log(`✅ SSH key generation works (ed25519, ${publicKey.length} bytes)`);
  } catch (err) {
    console.error("❌ SSH key generation failed:", err instanceof Error ? err.message : err);
  }

  logger.info({
    poolTarget: process.env.POOL_TARGET_READY || "10",
    provider: process.env.POOL_PROVIDER || "hetzner",
    region: process.env.POOL_REGION || "nbg1",
    instanceType: process.env.POOL_INSTANCE_TYPE || "cx23",
    maxConcurrent: process.env.POOL_MAX_CONCURRENT || "3",
    poolInterval: `${POOL_INTERVAL}ms`,
    healthInterval: `${HEALTH_INTERVAL}ms`,
  }, "Configuration loaded");

  // Pre-create persistent SSH key before any provisioning
  await initPersistentKey();

  // Force-clean any stuck instances on startup — delete from BOTH DB and Hetzner
  try {
    console.log("🧹 Cleaning stuck instances from DB + Hetzner...");
    const { sql } = await import("drizzle-orm");
    const { db, instances } = await import("./db.js");
    const hetzner = await import("./providers/hetzner.js");
    const CONTROL_PLANE_IP = process.env.CONTROL_PLANE_IP || "203.0.113.10";
    const stuck = await db.select().from(instances).where(
      sql`${instances.status} IN ('provisioning', 'installing', 'error')`
    );
    for (const inst of stuck) {
      if (inst.ip_address === CONTROL_PLANE_IP) {
        console.log("🧹 SKIP control plane " + inst.ip_address);
        continue;
      }
      try {
        if (inst.provider_instance_id) {
          await hetzner.deleteInstance(inst.provider_instance_id);
          console.log("🧹 Deleted Hetzner server " + inst.provider_instance_id + " (" + inst.ip_address + ")");
        }
      } catch (e) {
        console.log("🧹 Hetzner delete failed: " + (e instanceof Error ? e.message : String(e)));
      }
    }
    const deleted = await db.delete(instances).where(
      sql`${instances.status} IN ('provisioning', 'installing', 'error')`
    ).returning();
    console.log("🧹 Removed " + deleted.length + " stuck instance(s) from DB + Hetzner");
  } catch (err) {
    console.error("🧹 Cleanup error:", err instanceof Error ? err.message : err);
  }

  // Run initial pool summary
  try {
    const summary = await getPoolSummary();
    logger.info(summary);
  } catch {}

  // Start all loops concurrently
  await Promise.all([
    runPoolLoop(),
    runHealthLoop(),
    runCleanupLoop(),
    runSummaryLoop(),
  ]);
}

// ============================================================
// Graceful Shutdown
// ============================================================

function handleShutdown(signal: string) {
  logger.info({ signal }, "Received shutdown signal — finishing current jobs");
  isShuttingDown = true;

  // Force exit after 30 seconds if jobs don't finish
  setTimeout(() => {
    logger.warn("Forced exit after timeout");
    process.exit(1);
  }, 30_000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection in pool worker");
});

// Start
main().catch((err) => {
  logger.fatal(err, "Pool worker crashed");
  process.exit(1);
});

// ---- Utility ----

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
