import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { verifyJWT } from "./auth.js";
import { decrypt } from "../utils/encryption.js";
import { resolveSSHKey } from "../services/ssh.js";
import { NodeSSH } from "node-ssh";
import { logger } from "../utils/logger.js";

export async function healthRoutes(app: FastifyInstance) {
  /**
   * GET /api/health/:instanceId — Check if a user's instance is healthy.
   */
  app.get("/health/:instanceId", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) return reply.status(400).send({ error: "Invalid instance ID" });

    // Auth: verify JWT
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt) {
      return reply.status(401).send({ error: "Invalid token" });
    }

    const [instance] = await db
      .select({
        id: schema.instances.id,
        user_id: schema.instances.user_id,
        status: schema.instances.status,
        health_ok: schema.instances.health_ok,
        last_health_check: schema.instances.last_health_check,
        model: schema.instances.model,
        channel: schema.instances.channel,
      })
      .from(schema.instances)
      .where(eq(schema.instances.id, instanceId));

    if (!instance || instance.user_id !== jwt.userId) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    return {
      instance_id: instance.id,
      status: instance.status,
      health_ok: instance.health_ok,
      last_check: instance.last_health_check,
      model: instance.model,
      channel: instance.channel,
    };
  });

  /**
   * GET /api/pool/stats — Pool statistics (admin/debug).
   * Only returns counts, never instance details.
   */
  app.get("/pool/stats", async () => {
    const all = await db
      .select({ status: schema.instances.status })
      .from(schema.instances);

    const stats = {
      total: all.length,
      by_status: {} as Record<string, number>,
    };

    for (const inst of all) {
      stats.by_status[inst.status] = (stats.by_status[inst.status] || 0) + 1;
    }

    return stats;
  });

  /**
   * GET /api/health/deep/:instanceId — Deep health check: DB → decrypt → SSH → gateway.
   * Validates the full chain of secrets for an instance. Admin-only.
   * Returns granular status so you know exactly what's broken.
   */
  app.get("/health/deep/:instanceId", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
      return reply.status(400).send({ error: "Invalid instance ID" });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return reply.status(401).send({ error: "Unauthorized" });
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt) return reply.status(401).send({ error: "Invalid token" });

    const ADMIN_IDS = (process.env.ADMIN_USER_IDS || "").split(",").map(s => s.trim());
    if (!ADMIN_IDS.includes(jwt.userId)) return reply.status(403).send({ error: "Admin only" });

    const [inst] = await db
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, instanceId));

    if (!inst) return reply.status(404).send({ error: "Instance not found" });

    const checks: Record<string, { ok: boolean; error?: string }> = {};

    // 1. Decrypt SSH key
    let privateKey: string | null = null;
    try {
      privateKey = resolveSSHKey(inst.ssh_private_key_enc);
      checks.ssh_key_decrypt = { ok: true };
    } catch (e: any) {
      checks.ssh_key_decrypt = { ok: false, error: e.message };
    }

    // 2. Decrypt gateway token
    let gatewayToken: string | null = null;
    try {
      gatewayToken = inst.gateway_token_enc ? decrypt(inst.gateway_token_enc) : null;
      checks.gateway_token_decrypt = gatewayToken ? { ok: true } : { ok: false, error: "No gateway token" };
    } catch (e: any) {
      checks.gateway_token_decrypt = { ok: false, error: `Decrypt failed: ${e.message}` };
    }

    // 3. SSH connection
    if (privateKey) {
      const ssh = new NodeSSH();
      try {
        await ssh.connect({
          host: inst.ip_address, username: "root", privateKey,
          readyTimeout: 10_000,
        });
        checks.ssh_connect = { ok: true };

        // 4. Gateway process running
        const proc = await ssh.execCommand("pgrep -u openclaw -f openclaw-gateway");
        checks.gateway_process = proc.stdout.trim()
          ? { ok: true }
          : { ok: false, error: "Gateway process not running" };

        // 5. Gateway token matches config on VPS
        if (gatewayToken) {
          const configCmd = await ssh.execCommand(
            "cat /home/openclaw/.openclaw/openclaw.json 2>/dev/null"
          );
          try {
            const config = JSON.parse(configCmd.stdout);
            const vpsToken = config?.gateway?.auth?.token;
            if (vpsToken === gatewayToken) {
              checks.gateway_token_match = { ok: true };
            } else {
              checks.gateway_token_match = {
                ok: false,
                error: "DB token does not match VPS gateway.auth.token",
              };
            }
          } catch {
            checks.gateway_token_match = { ok: false, error: "Could not parse openclaw.json" };
          }
        }

        ssh.dispose();
      } catch (e: any) {
        checks.ssh_connect = { ok: false, error: e.message };
        try { ssh.dispose(); } catch {}
      }
    }

    const allOk = Object.values(checks).every(c => c.ok);

    if (!allOk) {
      logger.warn({ instanceId, checks }, "Deep health check found issues");
    }

    return { instanceId, healthy: allOk, checks };
  });
}
