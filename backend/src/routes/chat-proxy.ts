import type { FastifyInstance } from "fastify";
import { NodeSSH } from "node-ssh";
import { WebSocket as WS } from "ws";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import net from "net";
import { resolveSSHKey } from "../services/ssh.js";

/**
 * Chat Proxy — WebSocket proxy from browser to OpenClaw Gateway via SSH tunnel.
 *
 * Flow:
 *   Browser (wss://api.otto-ai.co/api/chat/{instanceId})
 *     → Otto Backend (this proxy)
 *       → SSH tunnel to customer VPS
 *         → ws://127.0.0.1:{gatewayPort} on VPS (OpenClaw Gateway)
 *
 * The proxy handles the OpenClaw handshake (connect challenge + auth token)
 * so the browser never sees the gateway token.
 */

// Active SSH tunnels cache (instanceId → tunnel info)
const tunnelCache = new Map<string, {
  ssh: NodeSSH;
  localPort: number;
  gatewayPort: number;
  gatewayToken: string;
  lastActivity: number;
  refCount: number;
}>();

// Cleanup idle tunnels every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tunnelCache) {
    if (t.refCount <= 0 && now - t.lastActivity > 15 * 60 * 1000) {
      logger.info({ instanceId: id }, "Closing idle SSH tunnel");
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

/**
 * Get or create an SSH tunnel to a customer VPS.
 * Uses ssh2 forwardOut to create a local TCP server that tunnels to the VPS.
 */
async function getOrCreateTunnel(instanceId: string) {
  const existing = tunnelCache.get(instanceId);
  if (existing && existing.ssh.isConnected()) {
    existing.lastActivity = Date.now();
    existing.refCount++;
    return existing;
  }

  // Clean up stale entry
  if (existing) {
    try { existing.ssh.dispose(); } catch {}
    tunnelCache.delete(instanceId);
  }

  // Look up instance
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

  // SSH connect
  const ssh = new NodeSSH();
  await ssh.connect({
    host: instance.ip_address,
    port: 22,
    username: "root",
    privateKey,
    readyTimeout: 15_000,
  });

  // Create local TCP server that tunnels to VPS gateway
  const localPort = await getFreePort();

  const tcpServer = net.createServer((localSocket) => {
    // For each local connection, open a forwarded channel to VPS
    const conn = ssh.connection;
    if (!conn) {
      localSocket.destroy();
      return;
    }

    conn.forwardOut(
      "127.0.0.1", localPort,
      "127.0.0.1", gatewayPort,
      (err, stream) => {
        if (err) {
          localSocket.destroy();
          return;
        }
        localSocket.pipe(stream).pipe(localSocket);
        stream.on("close", () => localSocket.destroy());
        localSocket.on("close", () => stream.destroy());
      }
    );
  });

  await new Promise<void>((resolve, reject) => {
    tcpServer.listen(localPort, "127.0.0.1", () => resolve());
    tcpServer.on("error", reject);
  });

  logger.info({ instanceId, localPort, gatewayPort }, "SSH tunnel + TCP proxy established");

  const entry = {
    ssh,
    localPort,
    gatewayPort,
    gatewayToken,
    lastActivity: Date.now(),
    refCount: 1,
  };
  tunnelCache.set(instanceId, entry);

  // Clean up when SSH drops
  ssh.connection?.on("close", () => {
    logger.warn({ instanceId }, "SSH connection dropped");
    tcpServer.close();
    tunnelCache.delete(instanceId);
  });

  return entry;
}

function releaseTunnel(instanceId: string) {
  const t = tunnelCache.get(instanceId);
  if (t) {
    t.refCount = Math.max(0, t.refCount - 1);
    t.lastActivity = Date.now();
  }
}

/**
 * Register chat proxy routes.
 */
export async function chatProxyRoutes(app: FastifyInstance) {

  app.get("/chat/:instanceId", { websocket: true }, async (socket, request) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) return reply.status(400).send({ error: "Invalid instance ID" });

    // Auth: verify JWT from query param (WebSocket can't set headers)
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get("token");
    const agentId = url.searchParams.get("agentId") || "main";
    if (!token) {
      socket.send(JSON.stringify({ type: "otto:error", error: "Missing auth token. Pass ?token=JWT" }));
      socket.close(4001, "unauthorized");
      return;
    }
    const jwt = verifyJWT(token);
    if (!jwt) {
      socket.send(JSON.stringify({ type: "otto:error", error: "Invalid or expired token" }));
      socket.close(4001, "unauthorized");
      return;
    }

    // Verify user has an active subscription for this instance
    const [sub] = await db
      .select({ instance_id: subscriptions.instance_id })
      .from(subscriptions)
      .innerJoin(instances, and(
        eq(instances.id, subscriptions.instance_id),
        eq(instances.status, "active")
      ))
      .where(and(
        eq(subscriptions.user_id, jwt.userId),
        eq(subscriptions.instance_id, instanceId),
        eq(subscriptions.status, "active")
      ))
      .limit(1);
    if (!sub) {
      socket.send(JSON.stringify({ type: "otto:error", error: "Instance not found or not yours" }));
      socket.close(4003, "forbidden");
      return;
    }

    logger.info({ instanceId, userId: jwt.userId }, "Chat proxy: browser connected (authenticated)");

    let gwWs: WS | null = null;

    try {
      const tunnel = await getOrCreateTunnel(instanceId);

      // Connect WebSocket to gateway through the SSH tunnel
      // Set origin to loopback so gateway treats it as local
      gwWs = new WS(`ws://127.0.0.1:${tunnel.localPort}`, {
        origin: `http://127.0.0.1:${tunnel.gatewayPort}`,
        headers: {
          "Host": `127.0.0.1:${tunnel.gatewayPort}`,
        },
      });

      let handshakeDone = false;

      gwWs.on("open", () => {
        logger.debug({ instanceId }, "Chat proxy: connected to gateway");
      });

      gwWs.on("message", (raw) => {
        const msg = raw.toString();

        try {
          const parsed = JSON.parse(msg);

          // Step 1: Gateway sends connect.challenge → we respond with auth
          if (!handshakeDone && parsed.type === "event" && parsed.event === "connect.challenge") {
            const connectReq = {
              type: "req",
              id: `c-${Date.now()}`,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "openclaw-control-ui",
                  version: "2026.2.23",
                  platform: "linux",
                  mode: "webchat",
                },
                role: "operator",
                scopes: ["operator.admin", "operator.write"],
                caps: [],
                commands: [],
                permissions: {},
                auth: { token: tunnel.gatewayToken },
                locale: "en-US",
                userAgent: "otto-dashboard/1.0.0",
              },
            };
            gwWs!.send(JSON.stringify(connectReq));
            return;
          }

          // Step 2: Gateway responds with hello-ok → handshake complete
          if (!handshakeDone && parsed.type === "res" && parsed.ok && parsed.payload?.type === "hello-ok") {
            handshakeDone = true;
            logger.info({ instanceId }, "Chat proxy: handshake complete");

            // Tell browser we're ready
            socket.send(JSON.stringify({
              type: "otto:connected",
              agentId: agentId,
              protocol: parsed.payload.protocol,
            }));

            // Load chat history for the specific agent
            const historyReq = {
              type: "req",
              id: `h-${Date.now()}`,
              method: "chat.history",
              params: { sessionKey: agentId === "main" ? "agent:main:main" : "agent:" + agentId + ":main", limit: 50 },
            };
            gwWs!.send(JSON.stringify(historyReq));
            return;
          }

          // After handshake: relay everything to browser
          if (handshakeDone) {
            socket.send(msg);
          }

        } catch {
          if (handshakeDone) socket.send(msg);
        }
      });

      gwWs.on("close", (code, reason) => {
        logger.info({ instanceId, code }, "Chat proxy: gateway closed");
        releaseTunnel(instanceId);
        try { socket.close(); } catch {}
      });

      gwWs.on("error", (err) => {
        logger.error({ instanceId, error: err.message }, "Chat proxy: gateway error");
        releaseTunnel(instanceId);
        try {
          socket.send(JSON.stringify({ type: "otto:error", error: "Gateway connection failed" }));
          socket.close();
        } catch {}
      });

      // Browser → Gateway relay
      socket.on("message", (data) => {
        if (gwWs && gwWs.readyState === WS.OPEN && handshakeDone) {
          tunnel.lastActivity = Date.now();
          gwWs.send(data.toString());
        }
      });

      socket.on("close", () => {
        logger.info({ instanceId }, "Chat proxy: browser disconnected");
        releaseTunnel(instanceId);
        if (gwWs) try { gwWs.close(); } catch {}
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ instanceId, error: msg }, "Chat proxy: setup failed");
      try {
        socket.send(JSON.stringify({ type: "otto:error", error: msg }));
        socket.close();
      } catch {}
      if (gwWs) try { gwWs.close(); } catch {}
      releaseTunnel(instanceId);
    }
  });

  logger.info("Chat proxy routes registered");
}
