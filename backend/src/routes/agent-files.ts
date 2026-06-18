import type { FastifyInstance } from "fastify";
import { NodeSSH } from "node-ssh";
import { WebSocket as WS } from "ws";
import { eq, and } from "drizzle-orm";
import net from "net";
import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { resolveSSHKey } from "../services/ssh.js";

/**
 * Agent Files API — Read/write agent workspace files (SOUL.md, IDENTITY.md, etc.)
 * through the OpenClaw Gateway's agents.files.get / agents.files.set methods.
 *
 * Uses SSH tunnel → WebSocket → Gateway RPC (same pattern as chat-proxy).
 *
 * All routes accept ?agentId=xxx query param to target a specific agent.
 * Defaults to "main" if not provided.
 *
 * Routes:
 *   GET  /api/agents/:instanceId/files             — List workspace files
 *   GET  /api/agents/:instanceId/files/:filename    — Read a workspace file
 *   POST /api/agents/:instanceId/files/:filename    — Write a workspace file
 *   POST /api/agents/:instanceId/files-batch        — Write multiple files at once
 */

const ALLOWED_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "AGENTS.md",
  "USER.md",
  "MEMORY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
];

const GW_TIMEOUT_MS = 15_000;

// ── SSH Tunnel Cache ──

const tunnelCache = new Map<string, {
  ssh: NodeSSH;
  localPort: number;
  tcpServer: net.Server;
  gatewayPort: number;
  gatewayToken: string;
  lastActivity: number;
  refCount: number;
}>();

setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tunnelCache) {
    if (t.refCount <= 0 && now - t.lastActivity > 15 * 60 * 1000) {
      logger.info({ instanceId: id }, "agent-files: closing idle tunnel");
      try { t.tcpServer.close(); } catch {}
      try { t.ssh.dispose(); } catch {}
      tunnelCache.delete(id);
    }
  }
}, 5 * 60 * 1000);

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function getOrCreateTunnel(instanceId: string) {
  const existing = tunnelCache.get(instanceId);
  if (existing && existing.ssh.isConnected()) {
    existing.lastActivity = Date.now();
    existing.refCount++;
    return existing;
  }

  if (existing) {
    try { existing.tcpServer.close(); } catch {}
    try { existing.ssh.dispose(); } catch {}
    tunnelCache.delete(instanceId);
  }

  const [instance] = await db
    .select({
      ip_address: instances.ip_address,
      ssh_private_key_enc: instances.ssh_private_key_enc,
      gateway_port: instances.gateway_port,
      gateway_token_enc: instances.gateway_token_enc,
      status: instances.status,
    })
    .from(instances)
    .where(eq(instances.id, instanceId));

  if (!instance) throw new Error("Instance not found");
  if (instance.status !== "active") throw new Error(`Instance not active (${instance.status})`);
  if (!instance.gateway_port) throw new Error("No gateway port");
  if (!instance.gateway_token_enc) throw new Error("No gateway token");

  const privateKey = resolveSSHKey(instance.ssh_private_key_enc);
  const gatewayToken = decrypt(instance.gateway_token_enc);
  const gatewayPort = instance.gateway_port;

  const ssh = new NodeSSH();
  await ssh.connect({
    host: instance.ip_address,
    port: 22,
    username: "root",
    privateKey,
    readyTimeout: 15_000,
  });

  const localPort = await getFreePort();

  const tcpServer = net.createServer((localSocket) => {
    const conn = ssh.connection;
    if (!conn) { localSocket.destroy(); return; }
    conn.forwardOut(
      "127.0.0.1", localPort,
      "127.0.0.1", gatewayPort,
      (err, channel) => {
        if (err) { localSocket.destroy(); return; }
        localSocket.pipe(channel);
        channel.pipe(localSocket);
        localSocket.on("close", () => channel.close());
        channel.on("close", () => localSocket.destroy());
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    tcpServer.listen(localPort, "127.0.0.1", () => resolve());
    tcpServer.on("error", reject);
  });

  const tunnel = {
    ssh, localPort, tcpServer, gatewayPort, gatewayToken,
    lastActivity: Date.now(), refCount: 1,
  };
  tunnelCache.set(instanceId, tunnel);
  return tunnel;
}

function releaseTunnel(instanceId: string) {
  const t = tunnelCache.get(instanceId);
  if (t) {
    t.lastActivity = Date.now();
    t.refCount = Math.max(0, t.refCount - 1);
    t.lastActivity = Date.now();
  }
}

// ── Gateway WebSocket RPC ──

async function gatewayRPC(
  tunnel: { localPort: number; gatewayToken: string },
  method: string,
  params: Record<string, any>
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Gateway RPC timeout"));
    }, GW_TIMEOUT_MS);

    const ws = new WS(`ws://127.0.0.1:${tunnel.localPort}`, {
      headers: { origin: "http://127.0.0.1" },
    });
    let handshakeDone = false;
    const reqId = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });

    ws.on("close", () => {
      if (!handshakeDone) { clearTimeout(timeout); reject(new Error("Gateway closed before handshake")); }
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Step 1: connect.challenge → auth
        if (!handshakeDone && msg.type === "event" && msg.event === "connect.challenge") {
          ws.send(JSON.stringify({
            type: "req",
            id: `c-${Date.now()}`,
            method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: "openclaw-control-ui", version: "2026.2.23", platform: "linux", mode: "webchat" },
              role: "operator",
              scopes: ["operator.admin"],
              caps: [], commands: [], permissions: {},
              auth: { token: tunnel.gatewayToken },
              locale: "en-US",
              userAgent: "otto-backend/1.0.0",
            },
          }));
          return;
        }

        // Step 2: hello-ok → send RPC
        if (!handshakeDone && msg.type === "res" && msg.ok && msg.payload?.type === "hello-ok") {
          handshakeDone = true;
          ws.send(JSON.stringify({ type: "req", id: reqId, method, params }));
          return;
        }

        // Step 3: RPC response
        if (handshakeDone && msg.type === "res" && msg.id === reqId) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          if (msg.ok) resolve(msg.payload);
          else reject(new Error(msg.error?.message || "Gateway RPC failed"));
          return;
        }

        // Handshake failure
        if (!handshakeDone && msg.type === "res" && !msg.ok) {
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          reject(new Error(msg.error?.message || "Gateway handshake failed"));
        }
      } catch {}
    });
  });
}

// ── Auth helper ──

async function authenticateAndAuthorize(request: any, reply: any): Promise<{ userId: string; instanceId: string; plan: string } | null> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) { reply.code(401).send({ error: "Missing token" }); return null; }

  const decoded = verifyJWT(auth.slice(7));
  if (!decoded) { reply.code(401).send({ error: "Invalid token" }); return null; }

  const instanceId = (request.params as any).instanceId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
    return reply.status(400).send({ error: "Invalid instance ID" });
  }
  const userId = decoded.userId;

  const [sub] = await db
    .select({ instance_id: subscriptions.instance_id, plan: subscriptions.plan })
    .from(subscriptions)
    .where(and(eq(subscriptions.user_id, userId), eq(subscriptions.instance_id, instanceId)));

  if (!sub) { reply.code(403).send({ error: "Not authorized for this instance" }); return null; }
  return { userId, instanceId, plan: sub.plan || "free" };
}

/**
 * Extract agentId from query params. Defaults to "main".
 * Validates: lowercase alphanumeric + hyphens only.
 */
function getAgentId(request: any): string {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const agentId = url.searchParams.get("agentId") || "main";
  // Sanitize: only allow safe characters
  return agentId.replace(/[^a-z0-9-]/gi, "").slice(0, 30) || "main";
}

// ── Routes ──

export default async function agentFilesRoutes(app: FastifyInstance) {

  // List workspace files
  app.get("/api/agents/:instanceId/files", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      const result = await gatewayRPC(
        { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
        "agents.files.list",
        { agentId }
      );
      return { ok: true, files: result?.files || [] };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, error: e.message }, "Failed to list files");
      return reply.code(502).send({ error: "Failed to connect to agent: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });

  // Read a workspace file
  app.get("/api/agents/:instanceId/files/:filename", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    const filename = (request.params as any).filename;
    if (!ALLOWED_FILES.includes(filename)) {
      return reply.code(400).send({ error: `File not allowed: ${filename}`, allowed: ALLOWED_FILES });
    }

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      const result = await gatewayRPC(
        { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
        "agents.files.get",
        { agentId, name: filename }
      );

      const file = result?.file;
      if (!file || file.missing) {
        return { ok: true, file: { name: filename, content: "", missing: true } };
      }
      return {
        ok: true,
        file: { name: file.name, content: file.content || "", size: file.size, updatedAtMs: file.updatedAtMs, missing: false },
      };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, filename, error: e.message }, "Failed to read file");
      return reply.code(502).send({ error: "Failed to read file: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });

  // Write a workspace file
  app.post("/api/agents/:instanceId/files/:filename", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    const filename = (request.params as any).filename;
    if (!ALLOWED_FILES.includes(filename)) {
      return reply.code(400).send({ error: `File not allowed: ${filename}`, allowed: ALLOWED_FILES });
    }

    const body = request.body as any;
    if (typeof body?.content !== "string") {
      return reply.code(400).send({ error: "Missing 'content' field (string) in request body" });
    }
    if (body.content.length > 100_000) {
      return reply.code(400).send({ error: "File too large (max 100KB)" });
    }

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      const result = await gatewayRPC(
        { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
        "agents.files.set",
        { agentId, name: filename, content: body.content }
      );

      logger.info({ instanceId: auth.instanceId, agentId, filename, size: body.content.length }, "Agent file updated");
      return { ok: true, agentId, file: { name: filename, size: body.content.length, updatedAtMs: result?.file?.updatedAtMs || Date.now() } };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, filename, error: e.message }, "Failed to write file");
      return reply.code(502).send({ error: "Failed to write file: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });

  // Batch write (setup wizard)
  app.post("/api/agents/:instanceId/files-batch", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    const body = request.body as any;
    if (!Array.isArray(body?.files)) {
      return reply.code(400).send({ error: "Missing 'files' array in request body" });
    }

    for (const f of body.files) {
      if (!ALLOWED_FILES.includes(f.name)) return reply.code(400).send({ error: `File not allowed: ${f.name}` });
      if (typeof f.content !== "string") return reply.code(400).send({ error: `Missing content for ${f.name}` });
      if (f.content.length > 100_000) return reply.code(400).send({ error: `${f.name} too large (max 100KB)` });
    }

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      const results: { name: string; ok: boolean; size: number; error?: string }[] = [];
      let lastError: string | null = null;

      for (const f of body.files) {
        try {
          await gatewayRPC(
            { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
            "agents.files.set",
            { agentId, name: f.name, content: f.content }
          );
          results.push({ name: f.name, ok: true, size: f.content.length });
        } catch (fileErr: any) {
          lastError = fileErr.message;
          results.push({ name: f.name, ok: false, size: 0, error: fileErr.message });
          logger.error({ instanceId: auth.instanceId, agentId, file: f.name, error: fileErr.message }, "Failed to write file in batch");
        }
      }

      const successCount = results.filter(r => r.ok).length;
      if (successCount === 0) {
        return reply.code(502).send({ error: "Failed to write files: " + lastError, agentId, files: results });
      }

      if (successCount < results.length) {
        logger.warn({ instanceId: auth.instanceId, agentId, results }, "Partial batch write — some files failed");
      } else {
        logger.info({ instanceId: auth.instanceId, agentId, fileCount: body.files.length, fileNames: results.map(r => r.name) }, "Agent files batch updated");
      }
      return { ok: true, partial: successCount < results.length, agentId, files: results };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, error: e.message }, "Failed batch write — tunnel error");
      return reply.code(502).send({ error: "Failed to write files: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });

  // ── Model Selection ──

  const ALLOWED_MODELS = [
    "openrouter/anthropic/claude-sonnet-4-5",
    "openrouter/anthropic/claude-haiku-4-5",
    "openrouter/anthropic/claude-opus-4-6",
    "openrouter/google/gemini-2.5-flash-preview",
    "openrouter/google/gemini-3-flash-preview",
    "openrouter/openai/gpt-4o",
    "openrouter/auto",
  ];

  // Get current model
  app.get("/api/agents/:instanceId/model", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      const result = await gatewayRPC(
        { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
        "config.get",
        {}
      );

      const cfg = result?.config || {};
      const agentEntry = cfg.agents?.list?.find((a: any) => a.id === agentId);
      let model = agentEntry?.model
        || cfg.agents?.defaults?.model?.primary
        || "openrouter/anthropic/claude-sonnet-4-5";

      // Free tier: default to haiku
      if (auth.plan === "free" && model.includes("sonnet")) {
        model = "openrouter/anthropic/claude-haiku-4-5";
      }

      return { ok: true, model };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, error: e.message }, "Failed to get model");
      return reply.code(502).send({ error: "Failed to get model: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });

  // Update model
  app.post("/api/agents/:instanceId/model", async (request, reply) => {
    const auth = await authenticateAndAuthorize(request, reply);
    if (!auth) return;
    const agentId = getAgentId(request);

    const body = request.body as any;
    if (!body?.model || !ALLOWED_MODELS.includes(body.model)) {
      return reply.code(400).send({
        error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(", ")}`,
      });
    }

    // Free tier: only allow cheap models
    const FREE_ALLOWED = ["openrouter/anthropic/claude-haiku-4-5", "openrouter/google/gemini-2.5-flash-preview", "openrouter/google/gemini-3-flash-preview"];
    if (auth.plan === "free" && !FREE_ALLOWED.includes(body.model)) {
      return reply.code(403).send({ error: "Free plan only allows budget models. Upgrade to use premium models." });
    }

    let tunnel;
    try {
      tunnel = await getOrCreateTunnel(auth.instanceId);
      await gatewayRPC(
        { localPort: tunnel.localPort, gatewayToken: tunnel.gatewayToken },
        "agents.update",
        { agentId, model: body.model }
      );

      logger.info({ instanceId: auth.instanceId, agentId, model: body.model }, "Agent model updated");
      return { ok: true, model: body.model };
    } catch (e: any) {
      logger.error({ instanceId: auth.instanceId, agentId, error: e.message }, "Failed to update model");
      return reply.code(502).send({ error: "Failed to update model: " + e.message });
    } finally {
      if (tunnel) releaseTunnel(auth.instanceId);
    }
  });
}
