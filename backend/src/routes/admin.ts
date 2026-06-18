import { logger } from "../utils/logger.js";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { users, instances, subscriptions, creditTopups, prospects } from "../db/schema.js";
import { eq, desc, and, isNull, sql, asc } from "drizzle-orm";
import { decrypt } from "../utils/encryption.js";
import { NodeSSH } from "node-ssh";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { verifyJWT } from "./auth.js";
import { getSpendingStatus, resetCircuitBreaker } from "../services/spending-guard.js";
import { resolveSSHKey } from "../services/ssh.js";

const execAsync = promisify(exec);

// ─── Admin Auth ───────────────────────────────────────────────────────────────

const ADMIN_USER_IDS = [
  "3850163b-c506-4913-bbee-2fcae6e9e279",
  "448f1fc8-a9b2-4d67-9977-5498245bdae8",
];

async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      logger.warn({ url: request.url }, "Admin: missing auth token");
      return reply.code(401).send({ error: "Missing auth token" });
    }
    const token = authHeader.slice(7);
    const decoded = verifyJWT(token);
    if (!decoded || !decoded.userId) {
      logger.warn({ url: request.url }, "Admin: token decode failed");
      return reply.code(401).send({ error: "Invalid token" });
    }
    if (!ADMIN_USER_IDS.includes(decoded.userId)) {
      logger.warn({ url: request.url, userId: decoded.userId }, "Admin: not authorized");
      return reply.code(403).send({ error: "Not authorized" });
    }
    (request as any).adminUserId = decoded.userId;
  } catch (err: any) {
    logger.warn({ url: request.url, error: err.message }, "Admin: invalid token");
    return reply.code(401).send({ error: "Invalid token" });
  }
}

// ─── SSH Helper ─────────────────────────────────────────────────────────────

async function sshToInstance(instanceId: string): Promise<{ ssh: NodeSSH; ip: string }> {
  const [instance] = await db
    .select({
      ip_address: instances.ip_address,
      ssh_private_key_enc: instances.ssh_private_key_enc,
      status: instances.status,
    })
    .from(instances)
    .where(eq(instances.id, instanceId));

  if (!instance) throw new Error("Instance not found");
  if (!instance.ip_address) throw new Error("Instance has no IP");

  const privateKey = resolveSSHKey(instance.ssh_private_key_enc!);
  const ssh = new NodeSSH();
  await ssh.connect({
    host: instance.ip_address,
    port: 22,
    username: "root",
    privateKey,
    readyTimeout: 15_000,
  });
  return { ssh, ip: instance.ip_address };
}

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onRequest", requireAdmin);

  // ── Platform Overview ─────────────────────────────────────────────────────

  app.get("/api/admin/overview", async (request, reply) => {
    try {
      const allUserRows = await db.select({ id: users.id }).from(users);
      const totalUsers = allUserRows.length;

      const activeSubRows = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.status, "active"));
      const activeSubs = activeSubRows.length;

      const allSubs = await db
        .select({ plan: subscriptions.plan })
        .from(subscriptions)
        .where(eq(subscriptions.status, "active"));

      const planPrices: Record<string, number> = { free: 0, starter: 49, solo: 49, pro: 149, team: 149, ultra: 349, enterprise: 349 };
      const monthlyRevenue = allSubs.reduce((sum, s) => sum + (planPrices[s.plan || "starter"] || 0), 0);
      const freeUsers = allSubs.filter(s => s.plan === "free").length;
      const paidUsers = activeSubs - freeUsers;

      const allInstances = await db.select({ status: instances.status }).from(instances);
      const activeVPS = allInstances.filter((i) => i.status === "active").length;
      const readyVPS = allInstances.filter((i) => i.status === "ready").length;
      const provisioningVPS = allInstances.filter((i) => i.status === "provisioning").length;
      const stoppedVPS = allInstances.filter((i) => i.status === "stopped").length;

      const allSubsForUsage = await db.select({ ai_credits_used: subscriptions.ai_credits_used }).from(subscriptions);
      const totalAiUsage = allSubsForUsage.reduce((sum, s) => sum + (s.ai_credits_used || 0), 0);

      const allTopups = await db.select({ amount_paid_cents: creditTopups.amount_paid_cents }).from(creditTopups);
      const topupRevenue = allTopups.reduce((sum, t) => sum + (t.amount_paid_cents || 0), 0);

      let pm2Status: any[] = [];
      try {
        const { stdout } = await execAsync("pm2 jlist");
        pm2Status = JSON.parse(stdout).map((p: any) => ({
          name: p.name,
          status: p.pm2_env?.status,
          uptime: p.pm2_env?.pm_uptime,
          restarts: p.pm2_env?.restart_time,
          memory: p.monit?.memory,
          cpu: p.monit?.cpu,
        }));
      } catch (err) {
        pm2Status = [{ error: "Could not fetch PM2 status" }];
      }

      return {
        totalUsers,
        activeSubs,
        freeUsers,
        paidUsers,
        monthlyRevenue,
        topupRevenue: Math.round(topupRevenue / 100),
        vps: { active: activeVPS, ready: readyVPS, provisioning: provisioningVPS, stopped: stoppedVPS },
        totalAiUsage,
        pm2: pm2Status,
        timestamp: new Date().toISOString(),
      };
    } catch (err: any) {
      console.error("ADMIN OVERVIEW ERROR:", err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── User List ─────────────────────────────────────────────────────────────

  app.get("/api/admin/users", async (request, reply) => {
    try {
      const allUsers = await db
        .select({
          id: users.id,
          email: users.email,
          stripe_customer_id: users.stripe_customer_id,
          created_at: users.created_at,
        })
        .from(users)
        .orderBy(desc(users.created_at));

      // Filter out admin users — only show real clients
      const clientUsers = allUsers.filter(u => !ADMIN_USER_IDS.includes(u.id));

      const enriched = [];
      for (const u of clientUsers) {
        try {
          const subs = await db
            .select({
              plan: subscriptions.plan,
              status: subscriptions.status,
              ai_credits_used: subscriptions.ai_credits_used,
              ai_credits_limit: subscriptions.ai_credits_limit,
              ai_credits_bonus: subscriptions.ai_credits_bonus,
              current_period_end: subscriptions.current_period_end,
              instance_id: subscriptions.instance_id,
            })
            .from(subscriptions)
            .where(eq(subscriptions.user_id, u.id));

          // Try direct instance lookup first, then via subscription
          let insts = await db
            .select({
              id: instances.id,
              ip_address: instances.ip_address,
              status: instances.status,
              gateway_port: instances.gateway_port,
              provider_instance_id: instances.provider_instance_id,
              assigned_at: instances.assigned_at,
            })
            .from(instances)
            .where(eq(instances.user_id, u.id));

          // Fallback: find instance via subscription linkage
          if (insts.length === 0 && subs.length > 0) {
            for (const sub of subs) {
              if ((sub as any).instance_id) {
                const subInsts = await db
                  .select({
                    id: instances.id,
                    ip_address: instances.ip_address,
                    status: instances.status,
                    gateway_port: instances.gateway_port,
                    provider_instance_id: instances.provider_instance_id,
                    assigned_at: instances.assigned_at,
                  })
                  .from(instances)
                  .where(eq(instances.id, (sub as any).instance_id));
                if (subInsts.length > 0) { insts = subInsts; break; }
              }
            }
          }

          enriched.push({
            ...u,
            subscription: subs.length > 0 ? subs[0] : null,
            instance: insts.length > 0 ? insts[0] : null,
          });
        } catch (e) {
          enriched.push({ ...u, subscription: null, instance: null });
        }
      }

      return { users: enriched };
    } catch (err: any) {
      console.error("ADMIN USERS ERROR:", err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── User Detail ───────────────────────────────────────────────────────────

  app.get<{ Params: { userId: string } }>(
    "/api/admin/users/:userId",
    async (request, reply) => {
      const { userId } = request.params;
      if (!isValidUUID(userId)) return reply.code(400).send({ error: "Invalid user ID" });

      try {
        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            stripe_customer_id: users.stripe_customer_id,
            created_at: users.created_at,
          })
          .from(users)
          .where(eq(users.id, userId));

        if (!user) return reply.code(404).send({ error: "User not found" });

        const userSubs = await db
          .select({
            id: subscriptions.id,
            plan: subscriptions.plan,
            status: subscriptions.status,
            ai_credits_used: subscriptions.ai_credits_used,
            ai_credits_limit: subscriptions.ai_credits_limit,
            ai_credits_bonus: subscriptions.ai_credits_bonus,
            current_period_start: subscriptions.current_period_start,
            current_period_end: subscriptions.current_period_end,
            instance_id: subscriptions.instance_id,
          })
          .from(subscriptions)
          .where(eq(subscriptions.user_id, userId));

        // Direct instance lookup
        let userInstances = await db
          .select({
            id: instances.id,
            ip_address: instances.ip_address,
            status: instances.status,
            gateway_port: instances.gateway_port,
            provider_instance_id: instances.provider_instance_id,
            assigned_at: instances.assigned_at,
            created_at: instances.created_at,
          })
          .from(instances)
          .where(eq(instances.user_id, userId));

        // Fallback: find instance via subscription linkage
        if (userInstances.length === 0 && userSubs.length > 0) {
          for (const sub of userSubs) {
            if (sub.instance_id) {
              const subInsts = await db
                .select({
                  id: instances.id,
                  ip_address: instances.ip_address,
                  status: instances.status,
                  gateway_port: instances.gateway_port,
                  provider_instance_id: instances.provider_instance_id,
                  assigned_at: instances.assigned_at,
                  created_at: instances.created_at,
                })
                .from(instances)
                .where(eq(instances.id, sub.instance_id));
              if (subInsts.length > 0) { userInstances = subInsts; break; }
            }
          }
        }

        const userTopups = await db
          .select({
            id: creditTopups.id,
            amount_paid_cents: creditTopups.amount_paid_cents,
            credits_granted_cents: creditTopups.credits_granted_cents,
            created_at: creditTopups.created_at,
          })
          .from(creditTopups)
          .where(eq(creditTopups.user_id, userId))
          .orderBy(desc(creditTopups.created_at));

        return {
          user,
          subscriptions: userSubs,
          instances: userInstances,
          topups: userTopups,
        };
      } catch (err: any) {
        console.error("ADMIN USER DETAIL ERROR:", err);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Instance Actions ──────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/admin/instances/:id/restart-gateway",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const cmd = `uid=$(id -u openclaw) && sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemctl --user restart openclaw-gateway`;
        const result = await ssh.execCommand(cmd);
        ssh.dispose();
        return { success: true, ip, stdout: result.stdout, stderr: result.stderr };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/instances/:id/stop-gateway",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const cmd = `uid=$(id -u openclaw) && sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemctl --user stop openclaw-gateway`;
        const result = await ssh.execCommand(cmd);
        ssh.dispose();
        return { success: true, ip, stdout: result.stdout, stderr: result.stderr };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/instances/:id/reboot-vps",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const [instance] = await db
          .select({ provider_instance_id: instances.provider_instance_id })
          .from(instances)
          .where(eq(instances.id, id));

        if (!instance?.provider_instance_id) {
          return reply.code(404).send({ error: "Instance or Hetzner ID not found" });
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let resp: Response;
        try {
          resp = await fetch(
            `https://api.hetzner.cloud/v1/servers/${instance.provider_instance_id}/actions/reboot`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.HETZNER_API_TOKEN}`,
                "Content-Type": "application/json",
              },
              signal: controller.signal,
            }
          );
        } finally {
          clearTimeout(timeout);
        }
        const data = await resp.json();
        return { success: resp.ok, hetzner_response: data };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/instances/:id/health",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const gatewayStatus = await ssh.execCommand(
          `uid=$(id -u openclaw) && sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemctl --user is-active openclaw-gateway`
        );
        const uptimeResult = await ssh.execCommand("uptime -s && cat /proc/loadavg");
        const diskResult = await ssh.execCommand("df -h / | tail -1 | awk '{print $5}'");
        const memResult = await ssh.execCommand(
          "free -m | awk 'NR==2{printf \"%d/%dMB (%.1f%%)\", $3,$2,$3*100/$2}'"
        );
        const agentsResult = await ssh.execCommand(
          `sudo -u openclaw cat /home/openclaw/.openclaw/openclaw.json 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4`
        );
        ssh.dispose();
        return {
          instanceId: id, ip,
          gateway: gatewayStatus.stdout.trim(),
          uptime: uptimeResult.stdout.trim(),
          disk: diskResult.stdout.trim(),
          memory: memResult.stdout.trim(),
          agents: agentsResult.stdout.trim().split("\n").filter(Boolean),
          checkedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        return { instanceId: id, gateway: "unreachable", error: err.message, checkedAt: new Date().toISOString() };
      }
    }
  );

  // ── Backend Controls ──────────────────────────────────────────────────────

  app.post("/api/admin/backend/restart", async (request, reply) => {
    try {
      exec("pm2 restart otto-backend", (err) => { if (err) console.error("Restart error:", err); });
      return { success: true, message: "Restart initiated" };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post("/api/admin/pool/restart", async (request, reply) => {
    try {
      const { stdout, stderr } = await execAsync("pm2 restart otto-pool");
      return { success: true, stdout, stderr };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { lines?: string; process?: string } }>(
    "/api/admin/logs",
    async (request, reply) => {
      try {
        const lines = parseInt((request.query as any).lines || "100", 10);
        const proc = (request.query as any).process || "otto-backend";
        const safeProc = proc.replace(/[^a-zA-Z0-9_-]/g, "");
        const safeLines = Math.min(Math.max(lines, 10), 500);
        const { stdout } = await execAsync(`pm2 logs ${safeProc} --nostream --lines ${safeLines} 2>&1`);
        return { logs: stdout, process: safeProc, lines: safeLines };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Pool Status ───────────────────────────────────────────────────────────

  app.get("/api/admin/pool/status", async (request, reply) => {
    try {
      const poolInstances = await db
        .select({
          id: instances.id,
          ip_address: instances.ip_address,
          status: instances.status,
          user_id: instances.user_id,
          provider_instance_id: instances.provider_instance_id,
          gateway_port: instances.gateway_port,
          created_at: instances.created_at,
          assigned_at: instances.assigned_at,
        })
        .from(instances)
        .orderBy(desc(instances.created_at));

      return {
        instances: poolInstances,
        summary: {
          total: poolInstances.length,
          active: poolInstances.filter((i) => i.status === "active").length,
          ready: poolInstances.filter((i) => i.status === "ready").length,
          provisioning: poolInstances.filter((i) => i.status === "provisioning").length,
          stopped: poolInstances.filter((i) => i.status === "stopped").length,
        },
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.post("/api/admin/pool/provision", async (request, reply) => {
    logger.info("Admin provision triggered");
    try {
      const readyInstances = await db.select().from(instances).where(eq(instances.status, "ready"));
      const currentTarget = parseInt(process.env.POOL_TARGET_READY || "1", 10);
      const newTarget = Math.max(1, Math.min(readyInstances.length + 1, 50)); // Sanitize to safe integer range
      process.env.POOL_TARGET_READY = String(newTarget);
      await execAsync("pm2 restart otto-pool --update-env");
      setTimeout(async () => {
        try {
          process.env.POOL_TARGET_READY = String(currentTarget);
          await execAsync("pm2 restart otto-pool --update-env");
        } catch {}
      }, 300000);
      return { success: true, message: "Provisioning triggered (target bumped to " + newTarget + ", resets in 5 min)" };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ── Spending Guard ──────────────────────────────────────────────────────

  app.get("/api/admin/spending", async (request, reply) => {
    return getSpendingStatus();
  });

  app.post("/api/admin/spending/reset", async (request, reply) => {
    resetCircuitBreaker();
    return { success: true, status: getSpendingStatus() };
  });

  // ── Usage ─────────────────────────────────────────────────────────────────

  app.get("/api/admin/usage/all", async (request, reply) => {
    try {
      const allUsage = await db
        .select({
          user_id: subscriptions.user_id,
          plan: subscriptions.plan,
          status: subscriptions.status,
          ai_credits_used: subscriptions.ai_credits_used,
          ai_credits_limit: subscriptions.ai_credits_limit,
          ai_credits_bonus: subscriptions.ai_credits_bonus,
          current_period_start: subscriptions.current_period_start,
          current_period_end: subscriptions.current_period_end,
        })
        .from(subscriptions)
        .where(eq(subscriptions.status, "active"));

      const withEmails = [];
      for (const s of allUsage) {
        try {
          const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, s.user_id!));
          withEmails.push({ ...s, email: user?.email || "unknown" });
        } catch {
          withEmails.push({ ...s, email: "unknown" });
        }
      }

      return { usage: withEmails };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // EMERGENCY TOOLS — Instance-level operations for live troubleshooting
  // ══════════════════════════════════════════════════════════════════════════

  // ── Gateway restart (manual method — for VPS where systemd is broken) ──
  app.post<{ Params: { id: string } }>(
    "/api/admin/instances/:id/restart-gateway-manual",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        // Kill existing gateway, then restart with background process
        const kill = await ssh.execCommand("pkill -u openclaw -f openclaw-gateway || true");
        // Wait a moment for clean shutdown
        await new Promise(r => setTimeout(r, 2000));
        const start = await ssh.execCommand('su - openclaw -c "openclaw gateway run &"');
        // Verify it's running
        await new Promise(r => setTimeout(r, 3000));
        const check = await ssh.execCommand("pgrep -u openclaw -f openclaw-gateway -a");
        ssh.dispose();
        return {
          success: check.stdout.includes("openclaw-gateway"),
          ip,
          pid: check.stdout.trim(),
          kill_output: kill.stderr || kill.stdout,
          start_output: start.stderr || start.stdout,
        };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Add bonus credits to a subscription ──
  app.post<{ Params: { id: string } }>(
    "/api/admin/subscriptions/:id/add-credits",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid subscription ID" });
      const body = request.body as any;
      const amountCents = parseInt(body?.amount_cents || "0");
      if (!amountCents || amountCents < 0 || amountCents > 50000) {
        return reply.code(400).send({ error: "amount_cents must be between 1 and 50000" });
      }
      try {
        const [sub] = await db
          .select({ ai_credits_bonus: subscriptions.ai_credits_bonus, ai_credits_limit: subscriptions.ai_credits_limit, ai_credits_used: subscriptions.ai_credits_used })
          .from(subscriptions)
          .where(eq(subscriptions.id, id));
        if (!sub) return reply.code(404).send({ error: "Subscription not found" });

        const newBonus = (sub.ai_credits_bonus || 0) + amountCents;
        await db.update(subscriptions).set({ ai_credits_bonus: newBonus }).where(eq(subscriptions.id, id));

        const totalLimit = (sub.ai_credits_limit || 0) + newBonus;
        const remaining = Math.max(0, totalLimit - (sub.ai_credits_used || 0));
        logger.info({ subscriptionId: id, added: amountCents, newBonus, totalLimit }, "Admin added bonus credits");
        return {
          success: true,
          credits: {
            added_cents: amountCents,
            bonus_cents: newBonus,
            limit_cents: sub.ai_credits_limit,
            used_cents: sub.ai_credits_used,
            total_limit_cents: totalLimit,
            remaining_cents: remaining,
          },
        };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Reset usage counter (emergency — resets ai_credits_used to 0) ──
  app.post<{ Params: { id: string } }>(
    "/api/admin/subscriptions/:id/reset-usage",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid subscription ID" });
      try {
        const [sub] = await db
          .select({ ai_credits_used: subscriptions.ai_credits_used })
          .from(subscriptions)
          .where(eq(subscriptions.id, id));
        if (!sub) return reply.code(404).send({ error: "Subscription not found" });

        await db.update(subscriptions).set({ ai_credits_used: 0 }).where(eq(subscriptions.id, id));
        logger.info({ subscriptionId: id, previousUsage: sub.ai_credits_used }, "Admin reset usage counter");
        return { success: true, previous_used_cents: sub.ai_credits_used };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── List cron jobs on a VPS ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/instances/:id/crons",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        // Read from jobs.json directly for latest config (after dashboard edits)
        const fileResult = await ssh.execCommand('sudo -u openclaw cat /home/openclaw/.openclaw/cron/jobs.json 2>/dev/null');
        // Also try CLI for state info (lastRun, nextRun, etc.)
        const cliResult = await ssh.execCommand('cd /tmp && sudo -u openclaw openclaw cron list --json 2>&1');
        ssh.dispose();

        let crons: any = null;
        let fileJobs: any[] = [];
        try {
          const fileParsed = JSON.parse(fileResult.stdout);
          fileJobs = Array.isArray(fileParsed) ? fileParsed : (fileParsed?.jobs || []);
        } catch {}
        try { crons = JSON.parse(cliResult.stdout); } catch {}

        // Merge: use file config (schedule, message, enabled) + CLI state
        if (fileJobs.length > 0) {
          const cliJobs = Array.isArray(crons) ? crons : (crons?.jobs || []);
          const cliMap: Record<string, any> = {};
          for (const cj of cliJobs) cliMap[cj.id] = cj;

          const merged = fileJobs.map((fj: any) => ({
            ...fj,
            state: cliMap[fj.id]?.state || fj.state || {},
          }));
          crons = merged;
        }
        return { success: true, ip, raw: cliResult.stdout, parsed: crons };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Trigger a cron job manually ──
  app.post<{ Params: { id: string; cronId: string } }>(
    "/api/admin/instances/:id/crons/:cronId/run",
    async (request, reply) => {
      const { id, cronId } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      if (!isValidUUID(cronId)) return reply.code(400).send({ error: "Invalid cron ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const result = await ssh.execCommand(`cd /tmp && sudo -u openclaw openclaw cron run ${cronId} 2>&1`);
        ssh.dispose();
        return { success: !result.stderr?.includes("error"), ip, stdout: result.stdout, stderr: result.stderr };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── List agents on a VPS ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/instances/:id/agents",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const result = await ssh.execCommand('sudo -u openclaw openclaw agents list --json 2>&1');
        ssh.dispose();
        let agents: any = null;
        try { agents = JSON.parse(result.stdout); } catch {}
        return { success: true, ip, raw: result.stdout, parsed: agents };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Full VPS health check (non-systemd) ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/instances/:id/health-full",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        const [gateway, uptime, disk, mem, agents, crons, openclawVer] = await Promise.all([
          ssh.execCommand("pgrep -u openclaw -f openclaw-gateway -a"),
          ssh.execCommand("uptime -s && cat /proc/loadavg"),
          ssh.execCommand("df -h / | tail -1 | awk '{print $3, $4, $5}'"),
          ssh.execCommand("free -m | awk 'NR==2{printf \"%d/%dMB (%.1f%%)\", $3,$2,$3*100/$2}'"),
          ssh.execCommand('sudo -u openclaw openclaw agents list --json 2>&1 | head -50'),
          ssh.execCommand('sudo -u openclaw openclaw cron list --json 2>&1 | head -50'),
          ssh.execCommand('sudo -u openclaw openclaw --version 2>/dev/null'),
        ]);
        ssh.dispose();
        return {
          instanceId: id, ip,
          gateway: gateway.stdout.trim() ? "running" : "stopped",
          gateway_pid: gateway.stdout.trim(),
          uptime: uptime.stdout.trim(),
          disk: disk.stdout.trim(),
          memory: mem.stdout.trim(),
          agents: agents.stdout.trim(),
          crons: crons.stdout.trim(),
          openclaw_version: openclawVer.stdout.trim(),
          checkedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        return { instanceId: id, gateway: "unreachable", error: err.message, checkedAt: new Date().toISOString() };
      }
    }
  );

  // ── Fetch logs from instance VPS ──
  app.get<{ Params: { id: string }; Querystring: { type?: string; lines?: string; filter?: string } }>(
    "/api/admin/instances/:id/logs",
    async (request, reply) => {
      const { id } = request.params;
      const logType = request.query.type || "gateway";
      const lines = Math.min(parseInt(request.query.lines || "100"), 500);
      const filter = request.query.filter || "";
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });
      try {
        const { ssh, ip } = await sshToInstance(id);
        let cmd = "";
        // "cd /tmp &&" avoids "Failed to restore initial working directory: /root"
        const SU = "cd /tmp && sudo -u openclaw";
        switch (logType) {
          case "gateway":
            // Gateway status + process info
            cmd = `${SU} bash -c '
              echo "=== Gateway Process ===";
              ps aux | grep openclaw | grep -v grep;
              echo "";
              echo "=== Gateway Port Listening ===";
              ss -tlnp 2>/dev/null | grep openclaw || netstat -tlnp 2>/dev/null | grep openclaw || echo "(could not check)";
              echo "";
              echo "=== Recent Config Audit ===";
              tail -n ${lines} /home/openclaw/.openclaw/logs/config-audit.jsonl 2>/dev/null || echo "(no config-audit.jsonl)";
            '`;
            break;
          case "openclaw":
            // Most recent conversation transcripts across all agents
            cmd = `${SU} bash -c '
              echo "=== Most recent session files ===";
              for f in $(find /home/openclaw/.openclaw/agents -name "*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -5); do
                echo "";
                echo "========== $f ($(wc -l < "$f") lines, $(stat -c%s "$f") bytes) ==========";
                tail -n ${lines} "$f" 2>/dev/null;
              done;
              echo "";
              echo "=== Cron run logs ===";
              for f in $(find /home/openclaw/.openclaw/cron/runs -name "*.jsonl" -type f 2>/dev/null | xargs ls -t 2>/dev/null | head -3); do
                echo "";
                echo "========== $f ==========";
                tail -n 20 "$f" 2>/dev/null;
              done
            '`;
            break;
          case "system":
            cmd = `journalctl --no-pager -n ${lines} 2>/dev/null | grep -iE "openclaw|claw|gateway" || tail -n ${lines} /var/log/syslog 2>/dev/null | grep -iE "openclaw|claw|gateway" || echo "No system logs found"`;
            break;
          case "sessions":
            // Directory structure + recent file activity
            cmd = `${SU} bash -c '
              echo "=== Agent directories ===";
              for d in /home/openclaw/.openclaw/agents/*/; do
                name=$(basename "$d");
                sessions=$(find "$d" -name "*.jsonl" -type f 2>/dev/null | wc -l);
                latest=$(find "$d" -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -1 | cut -d" " -f2);
                latest_time=$(stat -c%y "$latest" 2>/dev/null | cut -d. -f1);
                echo "$name: $sessions sessions, latest: $latest_time";
              done;
              echo "";
              echo "=== All recent files (last 24h) ===";
              find /home/openclaw/.openclaw -type f -mmin -1440 -printf "%T+ %s %p\\n" 2>/dev/null | sort -r | head -30;
            '`;
            break;
          default:
            return reply.code(400).send({ error: "Invalid log type. Use: gateway, openclaw, system, sessions" });
        }
        const safeFilter = filter.replace(/[^a-zA-Z0-9 _\-.:]/g, '');
        if (safeFilter) {
          cmd += ` | grep -i -- ${JSON.stringify(safeFilter)}`;
        }
        const result = await ssh.execCommand(cmd);
        ssh.dispose();
        return {
          success: true, ip, logType, lines,
          filter: safeFilter || null,
          output: result.stdout || result.stderr || "No output",
          fetchedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // ── Fetch backend PM2 logs (runs on THIS server) ──
  app.get<{ Querystring: { lines?: string; filter?: string } }>(
    "/api/admin/backend-logs",
    async (request, reply) => {
      const lines = Math.min(parseInt(request.query.lines || "100"), 500);
      const filter = request.query.filter || "";
      try {
        const safeLines = Math.min(Math.max(lines, 10), 500);
        const safeFilter = filter.replace(/[^a-zA-Z0-9 _\-.:]/g, '');
        let output: string;
        if (safeFilter) {
          const logsOutput = execSync(`pm2 logs otto-backend --nostream --lines ${safeLines} 2>&1`, { timeout: 10000, encoding: "utf-8" });
          // Filter in JS to avoid shell injection entirely
          const regex = new RegExp(safeFilter, 'i');
          output = logsOutput.split('\n').filter(line => regex.test(line)).join('\n');
        } else {
          output = execSync(`pm2 logs otto-backend --nostream --lines ${safeLines} 2>&1`, { timeout: 10000, encoding: "utf-8" });
        }
        return {
          success: true,
          output: output || "No logs",
          lines, filter: safeFilter || null,
          fetchedAt: new Date().toISOString(),
        };
      } catch (err: any) {
        return reply.code(500).send({ error: err.stdout || err.message });
      }
    }
  );

  // ── Quick Diagnostic — one-click full health check ──
  app.get<{ Params: { id: string } }>(
    "/api/admin/instances/:id/quick-diag",
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidUUID(id)) return reply.code(400).send({ error: "Invalid instance ID" });

      const checks: Record<string, any> = { instanceId: id, checkedAt: new Date().toISOString(), issues: [] as string[], status: "ok" };

      // 1. Check subscription & credits
      try {
        const [inst] = await db.select().from(instances).where(eq(instances.id, id));
        if (!inst) { checks.issues.push("Instance not found in DB"); checks.status = "critical"; return checks; }
        checks.ip = inst.ip_address;
        // Subscription is linked via user_id, not directly on instances table
        const [sub] = inst.user_id
          ? await db.select().from(subscriptions).where(eq(subscriptions.user_id, inst.user_id))
          : [undefined];
        if (!sub) {
          checks.credits = { error: "No subscription found" };
          checks.issues.push("No subscription linked");
        } else {
          const usedCents = sub.ai_credits_used ?? 0;
          const limitCents = sub.ai_credits_limit ?? 0;
          const remainingCents = limitCents - usedCents;
          checks.credits = {
            status: sub.status,
            used: `$${(usedCents / 100).toFixed(2)}`,
            limit: `$${(limitCents / 100).toFixed(2)}`,
            remaining: `$${(remainingCents / 100).toFixed(2)}`,
            pct_used: limitCents > 0 ? Math.round((usedCents / limitCents) * 100) : 0,
          };
          if (sub.status !== "active") checks.issues.push(`Subscription inactive (${sub.status})`);
          if (remainingCents <= 0) checks.issues.push("Credits EXHAUSTED — AI calls will fail");
          else if (remainingCents < 200) checks.issues.push(`Credits low — only $${(remainingCents / 100).toFixed(2)} remaining`);
        }
      } catch (err: any) {
        checks.credits = { error: err.message };
        checks.issues.push("DB check failed: " + err.message);
      }

      // 2. SSH checks — gateway, agents, last conversation
      try {
        const { ssh, ip } = await sshToInstance(id);
        checks.ssh = "connected";

        // Gateway process
        const gw = await ssh.execCommand("pgrep -u openclaw -f openclaw-gateway -c 2>/dev/null");
        const gwCount = parseInt(gw.stdout.trim()) || 0;
        checks.gateway = gwCount > 0 ? `running (${gwCount} processes)` : "DOWN";
        if (gwCount === 0) checks.issues.push("Gateway is DOWN — no messages will be received");

        // Gateway port
        const port = await ssh.execCommand("ss -tlnp 2>/dev/null | grep -c openclaw || echo 0");
        checks.gateway_listening = parseInt(port.stdout.trim()) > 0;
        if (!checks.gateway_listening && gwCount > 0) checks.issues.push("Gateway process exists but not listening on port");

        // Agents
        const agentsRes = await ssh.execCommand("cd /tmp && sudo -u openclaw openclaw agents list --json 2>&1");
        try {
          const agents = JSON.parse(agentsRes.stdout);
          checks.agents = agents.map((a: any) => a.identityName || a.id);
          checks.agent_count = agents.length;
        } catch {
          checks.agents = agentsRes.stdout.trim() || "Could not parse";
        }

        // Last conversation activity — find most recent .jsonl and get last few lines
        const lastSession = await ssh.execCommand(`cd /tmp && sudo -u openclaw bash -c '
          latest=$(find /home/openclaw/.openclaw/agents -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null | sort -rn | head -1 | cut -d" " -f2);
          if [ -n "$latest" ]; then
            echo "FILE:$latest";
            echo "MODIFIED:$(stat -c%y "$latest" 2>/dev/null)";
            tail -n 3 "$latest" 2>/dev/null;
          else
            echo "NO_SESSIONS";
          fi
        '`);
        const sessionOutput = lastSession.stdout.trim();
        if (sessionOutput === "NO_SESSIONS") {
          checks.last_activity = "No conversation sessions found";
          checks.issues.push("No conversation sessions found on VPS");
        } else {
          const fileMatch = sessionOutput.match(/FILE:(.+)/);
          const modMatch = sessionOutput.match(/MODIFIED:(.+)/);
          checks.last_activity = {
            file: fileMatch?.[1] || "unknown",
            modified: modMatch?.[1]?.trim() || "unknown",
          };
          // Check for errors in last messages
          const lastLines = sessionOutput.split("\n").filter(l => !l.startsWith("FILE:") && !l.startsWith("MODIFIED:"));
          const errorLines = lastLines.filter(l => /error|fail|exception|timeout|refused/i.test(l));
          if (errorLines.length > 0) {
            checks.last_error_hint = errorLines[0].substring(0, 300);
            checks.issues.push("Recent conversation contains errors");
          }
          // Parse last message for stop reason
          try {
            const lastLine = lastLines[lastLines.length - 1];
            const parsed = JSON.parse(lastLine);
            if (parsed?.message?.usage) {
              checks.last_message = {
                role: parsed.message.role,
                model: parsed.message.model,
                stopReason: parsed.message.stopReason,
                tokens: parsed.message.usage.totalTokens,
                cost: parsed.message.usage.cost?.total,
              };
            }
          } catch {}
        }

        // Disk space
        const disk = await ssh.execCommand("df -h / | tail -1 | awk '{print $5, $4}'");
        const diskParts = disk.stdout.trim().split(" ");
        checks.disk = { used_pct: diskParts[0], available: diskParts[1] };
        const diskPct = parseInt(diskParts[0]) || 0;
        if (diskPct > 90) checks.issues.push(`Disk almost full (${diskParts[0]} used)`);

        // Memory
        const mem = await ssh.execCommand("free -m | awk 'NR==2{printf \"%d/%dMB (%.0f%%)\", $3,$2,$3*100/$2}'");
        checks.memory = mem.stdout.trim();
        const memPct = parseInt(mem.stdout.match(/\((\d+)%\)/)?.[1] || "0");
        if (memPct > 90) checks.issues.push(`Memory critical (${checks.memory})`);

        ssh.dispose();
      } catch (err: any) {
        checks.ssh = "FAILED: " + err.message;
        checks.issues.push("Cannot SSH to VPS: " + err.message);
      }

      // 3. Determine overall status
      if (checks.issues.length === 0) {
        checks.status = "ok";
        checks.summary = "All systems operational";
      } else {
        const critical = checks.issues.some((i: string) => /DOWN|EXHAUSTED|Cannot SSH|critical/i.test(i));
        checks.status = critical ? "critical" : "warning";
        checks.summary = checks.issues.join(" | ");
      }

      return checks;
    }
  );

  // ============================================================
  // Prospects Mini CRM
  // ============================================================

  // GET /api/admin/prospects — List all prospects
  app.get("/api/admin/prospects", async (request, reply) => {
    const all = await db
      .select()
      .from(prospects)
      .orderBy(desc(prospects.updated_at));
    return { prospects: all };
  });

  // GET /api/admin/prospects/stats — Pipeline stats
  app.get("/api/admin/prospects/stats", async (request, reply) => {
    const all = await db.select({ status: prospects.status, deal_value: prospects.deal_value }).from(prospects);
    const pipeline: Record<string, { count: number; value: number }> = {};
    for (const p of all) {
      const s = p.status || "new";
      if (!pipeline[s]) pipeline[s] = { count: 0, value: 0 };
      pipeline[s].count++;
      pipeline[s].value += p.deal_value || 0;
    }
    const total = all.length;
    const totalValue = all.reduce((sum, p) => sum + (p.deal_value || 0), 0);
    const won = all.filter(p => p.status === "won");
    const wonValue = won.reduce((sum, p) => sum + (p.deal_value || 0), 0);
    const overdue = all.filter(p => p.next_action_date && new Date(p.next_action_date) < new Date() && !["won", "lost", "churned"].includes(p.status || ""));
    return { pipeline, total, totalValue, wonCount: won.length, wonValue, overdueCount: overdue.length };
  });

  // POST /api/admin/prospects — Create prospect
  app.post("/api/admin/prospects", async (request, reply) => {
    const body = request.body as any;
    const [created] = await db.insert(prospects).values({
      name: body.name,
      company: body.company || null,
      email: body.email || null,
      phone: body.phone || null,
      linkedin: body.linkedin || null,
      status: body.status || "new",
      source: body.source || "inbound",
      deal_value: body.deal_value || null,
      next_action: body.next_action || null,
      next_action_date: body.next_action_date ? new Date(body.next_action_date) : null,
      tags: body.tags || [],
      notes: body.notes || [],
    }).returning();
    return { prospect: created };
  });

  // PUT /api/admin/prospects/:id — Update prospect
  app.put("/api/admin/prospects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updates: any = { updated_at: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.company !== undefined) updates.company = body.company;
    if (body.email !== undefined) updates.email = body.email;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.linkedin !== undefined) updates.linkedin = body.linkedin;
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === "contacted" || body.status === "demo_scheduled") {
        updates.last_contact_date = new Date();
      }
    }
    if (body.source !== undefined) updates.source = body.source;
    if (body.deal_value !== undefined) updates.deal_value = body.deal_value;
    if (body.next_action !== undefined) updates.next_action = body.next_action;
    if (body.next_action_date !== undefined) updates.next_action_date = body.next_action_date ? new Date(body.next_action_date) : null;
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.notes !== undefined) updates.notes = body.notes;
    if (body.user_id !== undefined) updates.user_id = body.user_id || null;

    const [updated] = await db
      .update(prospects)
      .set(updates)
      .where(eq(prospects.id, id))
      .returning();

    if (!updated) return reply.code(404).send({ error: "Prospect not found" });
    return { prospect: updated };
  });

  // POST /api/admin/prospects/:id/note — Add a note
  app.post("/api/admin/prospects/:id/note", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = request.body as { text: string };

    const [prospect] = await db.select({ notes: prospects.notes }).from(prospects).where(eq(prospects.id, id));
    if (!prospect) return reply.code(404).send({ error: "Prospect not found" });

    const existingNotes = (prospect.notes as any[]) || [];
    existingNotes.push({ text, date: new Date().toISOString() });

    const [updated] = await db
      .update(prospects)
      .set({ notes: existingNotes, updated_at: new Date(), last_contact_date: new Date() })
      .where(eq(prospects.id, id))
      .returning();

    return { prospect: updated };
  });

  // DELETE /api/admin/prospects/:id — Delete prospect
  app.delete("/api/admin/prospects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.delete(prospects).where(eq(prospects.id, id));
    return { success: true };
  });

  logger.info("Admin emergency routes registered");
}
