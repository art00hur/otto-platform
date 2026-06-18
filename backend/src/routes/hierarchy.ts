import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { verifyJWT } from "./auth.js";
import { logger } from "../utils/logger.js";
import { NodeSSH } from "node-ssh";
import { decrypt } from "../utils/encryption.js";
import { resolveSSHKey } from "../services/ssh.js";

// ── Zod Schemas ──

const hierarchyUpdateSchema = z.object({
  hierarchy: z.record(z.string(), z.object({
    reports_to: z.string().nullable(),
  })),
});

async function sshToInstance(instanceId: string) {
  const [inst] = await db
    .select({ ip_address: instances.ip_address, ssh_private_key_enc: instances.ssh_private_key_enc })
    .from(instances)
    .where(eq(instances.id, instanceId));
  if (!inst?.ip_address) throw new Error("Instance not found");
  const privateKey = resolveSSHKey(inst.ssh_private_key_enc!);
  const ssh = new NodeSSH();
  await ssh.connect({ host: inst.ip_address, port: 22, username: "root", privateKey, readyTimeout: 15000 });
  return ssh;
}

export async function hierarchyRoutes(app: FastifyInstance) {

  // GET /api/agents/:instanceId/hierarchy
  app.get("/agents/:instanceId/hierarchy", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Missing token" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    const instanceId = (request.params as any).instanceId;

    // Verify the user owns this instance
    const [sub] = await db
      .select({ instance_id: subscriptions.instance_id })
      .from(subscriptions)
      .where(and(eq(subscriptions.user_id, decoded.userId), eq(subscriptions.instance_id, instanceId)));
    if (!sub) return reply.code(403).send({ error: "Not authorized for this instance" });

    const [inst] = await db.select({ agent_hierarchy: instances.agent_hierarchy }).from(instances).where(eq(instances.id, instanceId));
    if (!inst) return reply.code(404).send({ error: "Instance not found" });

    return { ok: true, hierarchy: inst.agent_hierarchy || {} };
  });

  // POST /api/agents/:instanceId/hierarchy
  app.post("/agents/:instanceId/hierarchy", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Missing token" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    const instanceId = (request.params as any).instanceId;

    // Verify the user owns this instance
    const [sub] = await db
      .select({ instance_id: subscriptions.instance_id })
      .from(subscriptions)
      .where(and(eq(subscriptions.user_id, decoded.userId), eq(subscriptions.instance_id, instanceId)));
    if (!sub) return reply.code(403).send({ error: "Not authorized for this instance" });

    const parsed = hierarchyUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { hierarchy } = parsed.data;

    let ssh: NodeSSH | null = null;
    try {
      ssh = await sshToInstance(instanceId);

      // 1. Get current agents list
      const configResult = await ssh.execCommand("sudo -u openclaw cat /home/openclaw/.openclaw/openclaw.json");
      const config = JSON.parse(configResult.stdout);
      const agentsList = config.agents?.list || [];
      const agentIds = agentsList.map((a: any) => a.id);

      // 2. Enable agentToAgent if multiple agents
      if (agentIds.length > 1) {
        await ssh.execCommand("sudo -u openclaw openclaw config set tools.agentToAgent.enabled true 2>&1");
        await ssh.execCommand(`sudo -u openclaw openclaw config set tools.agentToAgent.allow '${JSON.stringify(agentIds)}' 2>&1`);
      }

      // 3. Update each agent's SOUL.md with hierarchy info
      for (const agent of agentsList) {
        const agentId = agent.id;
        const agentHierarchy = hierarchy[agentId];
        const reportsTo = agentHierarchy?.reports_to || null;

        // Find who reports to this agent
        const directReports = Object.entries(hierarchy)
          .filter(([_, v]) => v.reports_to === agentId)
          .map(([id]) => {
            const a = agentsList.find((x: any) => x.id === id);
            return a ? `${a.identity?.name || id} (${a.identity?.theme || "Agent"})` : id;
          });

        // Build hierarchy section
        let hierarchySection = "\n## Team Structure\n\n";
        if (reportsTo) {
          const manager = agentsList.find((a: any) => a.id === reportsTo);
          const managerName = manager ? `${manager.identity?.name || reportsTo} (${manager.identity?.theme || "Agent"})` : reportsTo;
          hierarchySection += `You report to **${managerName}**. Keep them informed of important decisions and escalate when needed.\n\n`;
        } else {
          hierarchySection += `You are a **top-level leader**. You make final decisions and set direction.\n\n`;
        }
        if (directReports.length > 0) {
          hierarchySection += `Your direct reports: ${directReports.join(", ")}. You can delegate tasks to them using agent-to-agent communication.\n`;
        }

        // Read current SOUL.md
        const workspacePath = agentId === "main"
          ? "/home/openclaw/.openclaw/workspace"
          : `/home/openclaw/.openclaw/agents/${agentId}/workspace`;
        const soulResult = await ssh.execCommand(`sudo -u openclaw cat "${workspacePath}/SOUL.md" 2>/dev/null`);
        let soul = soulResult.stdout || "";

        // Remove old hierarchy section if exists
        soul = soul.replace(/\n## Team Structure[\s\S]*?(?=\n## |$)/, "");

        // Append hierarchy section
        soul = soul.trimEnd() + "\n" + hierarchySection;

        // Write back using base64 encoding to avoid shell injection
        const b64 = Buffer.from(soul, 'utf-8').toString('base64');
        await ssh.execCommand(`echo "${b64}" | base64 -d > /tmp/otto-soul-${agentId}.md && sudo -u openclaw cp /tmp/otto-soul-${agentId}.md "${workspacePath}/SOUL.md" && rm /tmp/otto-soul-${agentId}.md`);
      }

      // 4. Save hierarchy to DB
      await db.update(instances).set({ agent_hierarchy: hierarchy }).where(eq(instances.id, instanceId));

      // 5. Restart gateway
      const uid = (await ssh.execCommand("id -u openclaw")).stdout.trim();
      await ssh.execCommand(
        `sudo -u openclaw XDG_RUNTIME_DIR=/run/user/${uid} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus systemctl --user restart openclaw-gateway 2>&1`
      );

      logger.info({ instanceId, hierarchy }, "Agent hierarchy updated");
      return { ok: true };
    } catch (e: any) {
      logger.error({ instanceId, error: e.message }, "Failed to update hierarchy");
      return reply.code(502).send({ error: e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });
}
