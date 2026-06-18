import { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, instances, subscriptions } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { NodeSSH } from "node-ssh";
import { decrypt } from "../utils/encryption.js";
import { resolveSSHKey } from "../services/ssh.js";

/** Restart the OpenClaw gateway so it re-reads jobs.json (cron config).
 *  Fire-and-forget on a separate SSH connection. Uses nohup so the gateway
 *  survives SSH disconnect. Verifies the process started. */
function restartGatewayAsync(ip: string, privateKey: string): void {
  (async () => {
    let ssh2: NodeSSH | null = null;
    try {
      ssh2 = new NodeSSH();
      await ssh2.connect({ host: ip, port: 22, username: "root", privateKey, readyTimeout: 15_000 });
      // Single atomic command: kill → wait → restart with nohup → verify
      const cmd = [
        `pkill -u openclaw -f "openclaw" 2>/dev/null || true`,
        `sleep 2`,
        `su - openclaw -c "nohup openclaw gateway run </dev/null >/dev/null 2>&1 &"`,
        `sleep 3`,
        `pgrep -u openclaw -f openclaw-gateway >/dev/null && echo "GATEWAY_OK" || echo "GATEWAY_FAIL"`,
      ].join(" && ");
      const r = await ssh2.execCommand(cmd);
      if (r.stdout.includes("GATEWAY_OK")) {
        logger.info("Gateway restarted successfully after cron config change");
      } else {
        logger.error({ stdout: r.stdout, stderr: r.stderr }, "Gateway restart may have failed — watchdog will recover in 2min");
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Gateway restart failed (async) — watchdog will recover in 2min");
    } finally {
      if (ssh2) ssh2.dispose();
    }
  })();
}

/**
 * Dashboard routes — provides data for the user-facing dashboard.
 */
export async function dashboardRoutes(app: FastifyInstance) {

  // ============================================================
  // GET /api/dashboard/:userId — Full dashboard data
  // ============================================================
  app.get("/dashboard/:userId", async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Auth: verify JWT and ensure user can only access their own data
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Get user + instance + subscription in one query
    const result = await db
      .select({
        // User
        email: users.email,
        // Instance
        instanceId: instances.id,
        instanceStatus: instances.status,
        model: instances.model,
        channel: instances.channel,
        healthOk: instances.health_ok,
        lastHealthCheck: instances.last_health_check,
        lastError: instances.last_error,
        assignedAt: instances.assigned_at,
        clawVersion: instances.openclaw_version,
        // Subscription
        plan: subscriptions.plan,
        subStatus: subscriptions.status,
        creditsUsed: subscriptions.ai_credits_used,
        creditsLimit: subscriptions.ai_credits_limit,
        creditsBonus: subscriptions.ai_credits_bonus,
        periodStart: subscriptions.current_period_start,
        periodEnd: subscriptions.current_period_end,
      })
      .from(users)
      .leftJoin(subscriptions, and(
        eq(subscriptions.user_id, users.id),
        eq(subscriptions.status, "active"),
      ))
      .leftJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(eq(users.id, userId))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ error: "User not found" });
    }

    let row = result[0];

    // Lazy VPS provisioning: assign a VPS on-demand for free users with no instance
    if (row.plan && !row.instanceId) {
      const [readyVps] = await db
        .select({ id: instances.id })
        .from(instances)
        .where(and(eq(instances.status, "ready"), isNull(instances.user_id)))
        .limit(1);

      if (readyVps) {
        await db.update(instances).set({
          user_id: userId, status: "active", assigned_at: new Date(),
        }).where(eq(instances.id, readyVps.id));

        await db.update(subscriptions).set({
          instance_id: readyVps.id,
        }).where(and(eq(subscriptions.user_id, userId), eq(subscriptions.status, "active")));

        logger.info({ userId, instanceId: readyVps.id }, "Lazy VPS provisioning: assigned VPS on dashboard load");

        // Re-query to get updated data
        const refreshed = await db
          .select({
            email: users.email,
            instanceId: instances.id, instanceStatus: instances.status,
            model: instances.model, channel: instances.channel,
            healthOk: instances.health_ok, lastHealthCheck: instances.last_health_check,
            lastError: instances.last_error, assignedAt: instances.assigned_at,
            clawVersion: instances.openclaw_version,
            plan: subscriptions.plan, subStatus: subscriptions.status,
            creditsUsed: subscriptions.ai_credits_used, creditsLimit: subscriptions.ai_credits_limit,
            creditsBonus: subscriptions.ai_credits_bonus,
            periodStart: subscriptions.current_period_start, periodEnd: subscriptions.current_period_end,
          })
          .from(users)
          .leftJoin(subscriptions, and(eq(subscriptions.user_id, users.id), eq(subscriptions.status, "active")))
          .leftJoin(instances, and(eq(instances.id, subscriptions.instance_id), eq(instances.status, "active")))
          .where(eq(users.id, userId))
          .limit(1);

        if (refreshed.length > 0) row = refreshed[0];
      }
    }

    // Calculate uptime
    let uptimeSeconds = 0;
    if (row.assignedAt) {
      uptimeSeconds = Math.floor((Date.now() - new Date(row.assignedAt).getTime()) / 1000);
    }

    // Format uptime as human readable
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);

    const creditsUsed = row.creditsUsed || 0;
    const creditsLimit = row.creditsLimit || 0;
    const creditsBonus = row.creditsBonus || 0;
    const totalLimit = creditsLimit + creditsBonus;
    const creditsRemaining = Math.max(0, totalLimit - creditsUsed);

    reply.send({
      user: {
        email: row.email,
      },
      instance: row.instanceId ? {
        id: row.instanceId,
        status: row.instanceStatus,
        model: row.model,
        channel: row.channel,
        health_ok: row.healthOk,
        last_health_check: row.lastHealthCheck,
        last_error: row.lastError,
        openclaw_version: row.clawVersion,
        uptime: {
          seconds: uptimeSeconds,
          human: `${days}d ${hours}h ${minutes}m`,
        },
      } : null,
      subscription: row.plan ? {
        plan: row.plan,
        status: row.subStatus,
        credits: {
          used_cents: creditsUsed,
          limit_cents: creditsLimit,
          bonus_cents: creditsBonus,
          remaining_cents: creditsRemaining,
          used_dollars: (creditsUsed / 100).toFixed(2),
          limit_dollars: (totalLimit / 100).toFixed(2),
          remaining_dollars: (creditsRemaining / 100).toFixed(2),
          usage_percent: totalLimit > 0 ? Math.round((creditsUsed / totalLimit) * 100) : 0,
        },
        period_start: row.periodStart,
        period_end: row.periodEnd,
      } : null,
    });
  });

  // ============================================================
  // POST /api/dashboard/:instanceId/restart — Restart the gateway
  // ============================================================
  app.post("/dashboard/:instanceId/restart", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) return reply.status(400).send({ error: "Invalid instance ID" });

    // Auth: verify JWT and ownership
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt) {
      return reply.status(401).send({ error: "Invalid token" });
    }

    const instance = await db
      .select()
      .from(instances)
      .where(eq(instances.id, instanceId))
      .limit(1);

    if (instance.length === 0 || instance[0].user_id !== jwt.userId) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    // The actual restart is done by the health check job
    // We just mark it as needing attention
    await db
      .update(instances)
      .set({ health_ok: false, last_error: "User requested restart" })
      .where(eq(instances.id, instanceId));

    logger.info({ instanceId }, "User requested gateway restart");

    reply.send({ status: "restarting", message: "Gateway restart initiated. This takes about 30 seconds." });
  });

  // ============================================================
  // POST /api/dashboard/:instanceId/stop — Stop the instance
  // ============================================================
  app.post("/dashboard/:instanceId/stop", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) return reply.status(400).send({ error: "Invalid instance ID" });

    // Auth: verify JWT and ownership
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt) {
      return reply.status(401).send({ error: "Invalid token" });
    }

    const [inst] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, instanceId))
      .limit(1);

    if (!inst || inst.user_id !== jwt.userId) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    await db
      .update(instances)
      .set({ status: "recycling" })
      .where(eq(instances.id, instanceId));

    logger.info({ instanceId }, "User stopped instance");

    reply.send({ status: "stopping", message: "Instance is being stopped." });
  });

  // ============================================================
  // GET /api/dashboard/:userId/automations — Cron run history
  // ============================================================
  app.get("/dashboard/:userId/automations", async (request, reply) => {
    const { userId } = request.params as { userId: string };

    // Auth
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Get instance for this user (via subscription linkage)
    const [inst] = await db
      .select({
        id: instances.id,
        ip_address: instances.ip_address,
        ssh_private_key_enc: instances.ssh_private_key_enc,
      })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);

    if (!inst || !inst.ip_address) {
      return reply.send({ jobs: [], runs: [] });
    }

    let ssh: NodeSSH | null = null;
    try {
      const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
      ssh = new NodeSSH();
      await ssh.connect({
        host: inst.ip_address,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 15_000,
      });

      // 1. Get cron jobs — read from jobs.json for latest config (after dashboard edits)
      const fileResult = await ssh.execCommand("sudo -u openclaw cat /home/openclaw/.openclaw/cron/jobs.json 2>/dev/null");
      let jobs: any[] = [];
      try {
        const parsed = JSON.parse(fileResult.stdout);
        jobs = Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
      } catch { /* ignore */ }

      // Also try CLI for state info (lastRun, nextRun)
      if (jobs.length === 0) {
        const cliResult = await ssh.execCommand("cd /tmp && sudo -u openclaw openclaw cron list --json 2>&1");
        try {
          const parsed = JSON.parse(cliResult.stdout);
          jobs = Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
        } catch { /* ignore */ }
      } else {
        // Merge state from CLI into file-based jobs
        const cliResult = await ssh.execCommand("cd /tmp && sudo -u openclaw openclaw cron list --json 2>&1");
        try {
          const parsed = JSON.parse(cliResult.stdout);
          const cliJobs = Array.isArray(parsed) ? parsed : (parsed?.jobs || []);
          const stateMap: Record<string, any> = {};
          for (const cj of cliJobs) stateMap[cj.id] = cj.state;
          for (const j of jobs) {
            if (stateMap[j.id]) j.state = stateMap[j.id];
          }
        } catch { /* ignore */ }
      }

      // 2. Get recent run results for each cron job
      const runsResult = await ssh.execCommand(
        `cd /tmp && for f in /home/openclaw/.openclaw/cron/runs/*.jsonl; do [ -f "$f" ] && tail -5 "$f"; done 2>/dev/null`
      );

      const runs: any[] = [];
      if (runsResult.stdout) {
        for (const line of runsResult.stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.action === "finished" && entry.summary) {
              runs.push({
                jobId: entry.jobId,
                ts: entry.ts,
                status: entry.status,
                summary: entry.summary,
                sessionId: entry.sessionId || null,
                sessionKey: entry.sessionKey || null,
                model: entry.model,
                usage: entry.usage,
                truncated: entry.summary.endsWith("…") || entry.summary.endsWith("...") || entry.summary.endsWith("…\""),
              });
            }
          } catch { /* skip malformed lines */ }
        }
      }

      // Sort runs newest first
      runs.sort((a, b) => (b.ts || 0) - (a.ts || 0));

      // For the 5 most recent runs, try to fetch full transcript from session files
      // This replaces truncated summaries with the complete assistant message
      for (const run of runs.slice(0, 5)) {
        if (!run.sessionId) continue;
        try {
          // Session files are at /agents/{agentId}/sessions/{sessionId}.jsonl
          // We don't know which agent, so use find
          const findRes = await ssh.execCommand(
            `cd /tmp && find /home/openclaw/.openclaw/agents/ -name "${run.sessionId}.jsonl" -type f 2>/dev/null | head -1`
          );
          const filePath = findRes.stdout?.trim();
          if (!filePath) continue;

          // Get assistant messages — extract the longest one (the final brief)
          const catRes = await ssh.execCommand(
            `cd /tmp && sudo -u openclaw grep '"role":"assistant"' "${filePath}" 2>/dev/null`
          );
          if (!catRes.stdout) continue;

          let bestText = "";
          for (const line of catRes.stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              let text = "";
              const content = msg.message?.content || msg.content;
              if (typeof content === "string") text = content;
              else if (Array.isArray(content)) {
                text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
              }
              if (text.length > bestText.length) bestText = text;
            } catch { /* skip */ }
          }

          if (bestText.length > run.summary.length) {
            run.summary = bestText;
            run.truncated = false;
          }
        } catch { /* If session fetch fails, keep the truncated summary */ }
      }

      // Map job names to IDs
      const jobMap: Record<string, string> = {};
      for (const j of jobs) {
        jobMap[j.id] = j.name || j.id;
      }

      reply.send({
        jobs: jobs.map(j => ({
          id: j.id,
          name: j.name,
          schedule: typeof j.schedule === 'string' ? j.schedule : (j.schedule?.expr || j.schedule?.cron || ''),
          timezone: j.schedule?.tz || 'Europe/Paris',
          enabled: j.enabled !== false,
          agentId: j.agentId,
          sessionTarget: j.sessionTarget,
          message: j.payload?.message || "",
          lastRun: j.state?.lastRunAt,
          lastStatus: j.state?.lastRunStatus,
        })),
        runs: runs.slice(0, 20).map(r => ({
          ...r,
          jobName: jobMap[r.jobId] || r.jobId,
        })),
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Automations fetch failed");
      reply.send({ jobs: [], runs: [], error: err.message });
    } finally {
      if (ssh) ssh.dispose();
    }
  });

  // ============================================================
  // GET /api/dashboard/:userId/automations/session/:sessionId
  // Fetch full transcript of a cron run session (untruncated)
  // ============================================================
  app.get("/dashboard/:userId/automations/session/:sessionId", async (request, reply) => {
    const { userId, sessionId } = request.params as { userId: string; sessionId: string };

    // Auth
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Validate sessionId format (UUID)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return reply.status(400).send({ error: "Invalid session ID" });
    }

    // Get instance
    const [inst] = await db
      .select({
        id: instances.id,
        ip_address: instances.ip_address,
        ssh_private_key_enc: instances.ssh_private_key_enc,
      })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);

    if (!inst) {
      return reply.status(404).send({ error: "No active instance" });
    }

    let ssh: any = null;
    try {
      const { NodeSSH } = await import("node-ssh");
      ssh = new NodeSSH();
      const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
      await ssh.connect({ host: inst.ip_address, username: "root", privateKey });

      // Sessions are stored under /agents/{agentId}/sessions/{sessionId}.jsonl
      // Find the file first since we don't know which agent ran it
      const findResult = await ssh.execCommand(
        `cd /tmp && find /home/openclaw/.openclaw/agents/ -name "${sessionId}.jsonl" -type f 2>/dev/null | head -1`
      );

      if (!findResult.stdout?.trim()) {
        return reply.status(404).send({ error: "Session not found" });
      }

      const filePath = findResult.stdout.trim();
      // Extract assistant messages — grep for text content blocks
      const result = await ssh.execCommand(
        `cd /tmp && sudo -u openclaw grep '"role":"assistant"' "${filePath}" 2>/dev/null | tail -10`
      );

      if (!result.stdout) {
        return reply.status(404).send({ error: "No assistant messages in session" });
      }

      return extractFullBrief(result.stdout);
    } catch (err: any) {
      logger.error({ err: err.message, sessionId }, "Session transcript fetch failed");
      return reply.status(500).send({ error: "Failed to fetch session" });
    } finally {
      if (ssh) ssh.dispose();
    }

    function extractFullBrief(stdout: string) {
      // Parse JSONL lines, find the longest assistant text (the final brief)
      let bestText = "";
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          let text = "";
          if (msg.message?.role === "assistant") {
            const content = msg.message.content;
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
            }
          } else if (msg.role === "assistant") {
            const content = msg.content;
            if (typeof content === "string") text = content;
            else if (Array.isArray(content)) {
              text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
            }
          }
          if (text.length > bestText.length) bestText = text;
        } catch { /* skip */ }
      }
      if (!bestText) {
        return { ok: false, error: "No assistant message found in session" };
      }
      return { ok: true, fullText: bestText };
    }
  });

  // ============================================================
  // POST /api/dashboard/:userId/automations — Create a new cron job
  // ============================================================
  app.post("/dashboard/:userId/automations", async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const body = request.body as { name: string; agentId: string; schedule: string; message: string };

    // Auth
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Validate required fields
    if (!body.name || !body.agentId || !body.schedule || !body.message) {
      return reply.status(400).send({ error: "Missing required fields: name, agentId, schedule, message" });
    }

    // Validate schedule (5-field cron)
    const parts = body.schedule.trim().split(/\s+/);
    if (parts.length !== 5) {
      return reply.status(400).send({ error: "Invalid cron schedule — must be 5 fields" });
    }

    // Get instance (via subscription linkage)
    const [inst] = await db
      .select({
        id: instances.id,
        ip_address: instances.ip_address,
        ssh_private_key_enc: instances.ssh_private_key_enc,
      })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);

    if (!inst || !inst.ip_address) {
      return reply.status(404).send({ error: "No active instance" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
      ssh = new NodeSSH();
      await ssh.connect({
        host: inst.ip_address,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 15_000,
      });

      // Strategy: Use OpenClaw CLI to create the cron (talks to running daemon directly).
      // The CLI registers the job in memory AND writes to jobs.json atomically.
      // Fallback: if CLI fails, write directly to jobs.json and restart gateway.
      const jobsFile = "/home/openclaw/.openclaw/cron/jobs.json";
      const escapedName = body.name.replace(/[^a-zA-Z0-9_-]/g, '-');
      const escapedMessage = body.message.replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const escapedSchedule = body.schedule.replace(/'/g, "'\\''");

      // Try CLI first (preferred — no restart needed)
      const cliCmd = `cd /tmp && sudo -u openclaw openclaw cron create `
        + `--agent ${body.agentId} `
        + `--name "${escapedName}" `
        + `--schedule "${escapedSchedule}" `
        + `--tz "Europe/Paris" `
        + `--message "${escapedMessage}" `
        + `--json 2>&1`;

      logger.info({ cmd: cliCmd }, "Attempting cron create via CLI");
      const cliResult = await ssh.execCommand(cliCmd);
      let result: any = { ok: false };

      // Try to parse CLI output
      try {
        const parsed = JSON.parse(cliResult.stdout);
        if (parsed.id) {
          result = { ok: true, id: parsed.id, name: parsed.name || escapedName };
          logger.info({ id: result.id }, "Cron created via CLI (daemon aware, no restart needed)");
        }
      } catch {
        // CLI failed or returned non-JSON — fall back to direct file write
        logger.warn({ stdout: cliResult.stdout, stderr: cliResult.stderr }, "CLI cron create failed, falling back to jobs.json write");
      }

      if (!result.ok) {
        // Fallback: write directly to jobs.json
        const newJobJson = JSON.stringify({
          name: escapedName,
          agentId: body.agentId,
          schedule: body.schedule,
          message: body.message,
        }).replace(/'/g, "'\\''");

        const pyCmd = [
          `cat > /tmp/_cron_create.py << 'PYEOF'`,
          `import json, sys, uuid, time`,
          `f, new_job_str = sys.argv[1], sys.argv[2]`,
          `nj = json.loads(new_job_str)`,
          `data = json.load(open(f))`,
          `if isinstance(data, list):`,
          `    job_list = data`,
          `else:`,
          `    job_list = data.get("jobs", [])`,
          `new_id = str(uuid.uuid4())`,
          `job = {`,
          `    "id": new_id,`,
          `    "agentId": nj["agentId"],`,
          `    "name": nj["name"],`,
          `    "description": "",`,
          `    "enabled": True,`,
          `    "createdAtMs": int(time.time() * 1000),`,
          `    "updatedAtMs": int(time.time() * 1000),`,
          `    "schedule": {"kind": "cron", "expr": nj["schedule"], "tz": "Europe/Paris"},`,
          `    "sessionTarget": "isolated",`,
          `    "wakeMode": "now",`,
          `    "payload": {"kind": "agentTurn", "message": nj["message"]},`,
          `    "delivery": {"mode": "none"},`,
          `    "state": {}`,
          `}`,
          `job_list.append(job)`,
          `if isinstance(data, list):`,
          `    data = job_list`,
          `else:`,
          `    data["jobs"] = job_list`,
          `json.dump(data, open(f, "w"), indent=2)`,
          `print(json.dumps({"ok": True, "id": new_id, "name": nj["name"]}))`,
          `PYEOF`,
          `sudo -u openclaw python3 /tmp/_cron_create.py '${jobsFile}' '${newJobJson}'`,
        ].join('\n');

        const r = await ssh.execCommand(pyCmd);
        try { result = JSON.parse(r.stdout); } catch {}

        if (!result.ok) {
          logger.error({ stderr: r.stderr, stdout: r.stdout }, "Cron create failed (both CLI and file)");
          return reply.status(500).send({ error: r.stderr || r.stdout || "Create failed" });
        }

        // File-based create requires gateway restart to pick up the new job
        restartGatewayAsync(inst.ip_address, privateKey);
        logger.info({ id: result.id }, "Cron created via jobs.json fallback + gateway restart");
      }

      logger.info({ name: body.name, agentId: body.agentId, id: result.id }, "Cron job created");
      reply.send({ ok: true, id: result.id, name: result.name });
    } catch (err: any) {
      logger.error({ err: err.message }, "Cron create failed");
      reply.status(500).send({ error: err.message });
    } finally {
      if (ssh) ssh.dispose();
    }
  });

  // ============================================================
  // PUT /api/dashboard/:userId/automations/:jobId — Edit a cron job
  // ============================================================
  // Support both PUT and POST (some reverse proxies don't forward PUT properly)
  const editHandler = async (request: any, reply: any) => {
    const { userId, jobId } = request.params as { userId: string; jobId: string };
    const body = request.body as { schedule?: string; message?: string; enabled?: boolean };

    // Auth
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Validate jobId format (UUID or alphanumeric)
    if (!/^[0-9a-zA-Z_-]{4,64}$/i.test(jobId)) {
      return reply.status(400).send({ error: "Invalid job ID" });
    }

    // Validate schedule format if provided (basic cron validation: 5 fields)
    if (body.schedule) {
      const parts = body.schedule.trim().split(/\s+/);
      if (parts.length !== 5) {
        return reply.status(400).send({ error: "Invalid cron schedule — must be 5 fields (min hour dom month dow)" });
      }
    }

    // Get instance (via subscription linkage)
    const [inst] = await db
      .select({
        id: instances.id,
        ip_address: instances.ip_address,
        ssh_private_key_enc: instances.ssh_private_key_enc,
      })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);

    if (!inst || !inst.ip_address) {
      return reply.status(404).send({ error: "No active instance" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
      ssh = new NodeSSH();
      await ssh.connect({
        host: inst.ip_address,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 15_000,
      });

      const jobsFile = "/home/openclaw/.openclaw/cron/jobs.json";

      // Build a Python script that edits ALL fields atomically in jobs.json
      // This avoids CLI limitations (no --schedule flag) and prevents
      // race conditions between separate CLI calls
      const changes: Record<string, string> = {};
      if (body.schedule) changes.schedule = body.schedule;
      if (body.message !== undefined) changes.message = body.message;
      if (body.enabled !== undefined) changes.enabled = body.enabled ? "true" : "false";
      // Single-quoted shell strings preserve backslashes literally, so JSON escape
      // sequences (\n, \t, etc.) pass through correctly to Python's json.loads.
      // Only need to handle single quotes within the JSON.
      const changesJson = JSON.stringify(changes).replace(/'/g, "'\\''");

      const cmd = [
        `cat > /tmp/_cron_edit.py << 'PYEOF'`,
        `import json, sys`,
        `f, jid, changes_str = sys.argv[1], sys.argv[2], sys.argv[3]`,
        `changes = json.loads(changes_str)`,
        `data = json.load(open(f))`,
        `# Handle both formats: plain array or {jobs: [...]}`,
        `if isinstance(data, list):`,
        `    job_list = data`,
        `else:`,
        `    job_list = data.get("jobs", [])`,
        `found = False`,
        `for j in job_list:`,
        `    if j["id"] == jid:`,
        `        found = True`,
        `        if "schedule" in changes:`,
        `            tz = j.get("schedule", {}).get("tz", "Europe/Paris") if isinstance(j.get("schedule"), dict) else "Europe/Paris"`,
        `            j["schedule"] = {"kind": "cron", "expr": changes["schedule"], "tz": tz}`,
        `        if "message" in changes:`,
        `            if "payload" not in j: j["payload"] = {}`,
        `            j["payload"]["message"] = changes["message"]`,
        `        if "enabled" in changes:`,
        `            j["enabled"] = changes["enabled"] == "true"`,
        `        sched = j["schedule"].get("expr","") if isinstance(j["schedule"], dict) else j["schedule"]`,
        `        msg = j.get("payload",{}).get("message","")`,
        `        print(json.dumps({"ok": True, "job": {"id": j["id"], "name": j.get("name",""), "schedule": sched, "enabled": j.get("enabled", True), "message": msg}}))`,
        `        break`,
        `if not found:`,
        `    print(json.dumps({"ok": False, "error": "Job not found"}))`,
        `    sys.exit(0)`,
        `json.dump(data, open(f, "w"), indent=2)`,
        `PYEOF`,
        `sudo -u openclaw python3 /tmp/_cron_edit.py '${jobsFile}' '${jobId}' '${changesJson}'`,
      ].join('\n');

      const r = await ssh.execCommand(cmd);
      let result: any = { ok: false, error: "Unknown error" };
      try {
        result = JSON.parse(r.stdout);
      } catch {
        result = { ok: false, error: r.stderr || r.stdout || "Parse error" };
      }

      if (!result.ok) {
        reply.status(400).send({ error: result.error });
        return;
      }

      // Restart gateway async (don't block the response)
      restartGatewayAsync(inst.ip_address, privateKey);

      reply.send({
        ok: true,
        results: Object.keys(changes).map(k => `${k}: updated`),
        job: result.job,
      });
    } catch (err: any) {
      logger.error({ err: err.message, jobId }, "Cron edit failed");
      reply.status(500).send({ error: err.message });
    } finally {
      if (ssh) ssh.dispose();
    }
  };
  app.put("/dashboard/:userId/automations/:jobId", editHandler);
  app.post("/dashboard/:userId/automations/:jobId/edit", editHandler);

  // ============================================================
  // DELETE /api/dashboard/:userId/automations/:jobId — Delete a cron job
  // ============================================================
  const deleteHandler = async (request: any, reply: any) => {
    const { userId, jobId } = request.params as { userId: string; jobId: string };

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== userId) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    if (!/^[0-9a-zA-Z_-]{4,64}$/i.test(jobId)) {
      return reply.status(400).send({ error: "Invalid job ID" });
    }

    // Get instance (via subscription linkage)
    const [inst] = await db
      .select({
        id: instances.id,
        ip_address: instances.ip_address,
        ssh_private_key_enc: instances.ssh_private_key_enc,
      })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, userId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);

    if (!inst || !inst.ip_address) {
      return reply.status(404).send({ error: "No active instance" });
    }

    let ssh: NodeSSH | null = null;
    try {
      const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
      ssh = new NodeSSH();
      await ssh.connect({
        host: inst.ip_address,
        port: 22,
        username: "root",
        privateKey,
        readyTimeout: 15_000,
      });

      const jobsFile = "/home/openclaw/.openclaw/cron/jobs.json";
      const cmd = [
        `cat > /tmp/_cron_delete.py << 'PYEOF'`,
        `import json, sys`,
        `f, jid = sys.argv[1], sys.argv[2]`,
        `data = json.load(open(f))`,
        `if isinstance(data, list):`,
        `    before = len(data)`,
        `    data = [j for j in data if j["id"] != jid]`,
        `    removed = before - len(data)`,
        `else:`,
        `    jobs = data.get("jobs", [])`,
        `    before = len(jobs)`,
        `    data["jobs"] = [j for j in jobs if j["id"] != jid]`,
        `    removed = before - len(data["jobs"])`,
        `json.dump(data, open(f, "w"), indent=2)`,
        `print(json.dumps({"ok": True, "removed": removed}))`,
        `PYEOF`,
        `sudo -u openclaw python3 /tmp/_cron_delete.py '${jobsFile}' '${jobId}'`,
      ].join('\n');

      const r = await ssh.execCommand(cmd);
      let result: any = { ok: false };
      try { result = JSON.parse(r.stdout); } catch {}

      if (!result.ok) {
        return reply.status(500).send({ error: r.stderr || r.stdout || "Delete failed" });
      }

      // Restart gateway async (don't block the response)
      restartGatewayAsync(inst.ip_address, privateKey);

      logger.info({ jobId, removed: result.removed }, "Cron job deleted");
      reply.send({ ok: true, removed: result.removed });
    } catch (err: any) {
      logger.error({ err: err.message, jobId }, "Cron delete failed");
      reply.status(500).send({ error: err.message });
    } finally {
      if (ssh) ssh.dispose();
    }
  };
  app.delete("/dashboard/:userId/automations/:jobId", deleteHandler);
  app.post("/dashboard/:userId/automations/:jobId/delete", deleteHandler);

  logger.info("Dashboard routes registered");
}

// No helpers needed — sensitive data stays server-side
