import { NodeSSH } from "node-ssh";
import { eq } from "drizzle-orm";
import net from "net";
import { db } from "../db/index.js";
import { instances } from "../db/schema.js";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { resolveSSHKey } from "./ssh.js";

// ============================================================
// SSH Tunnel Manager
//
// Shared module for creating and managing SSH tunnels to
// customer VPS instances. Used by chat-proxy (WebSocket)
// and messaging (Telegram/WhatsApp) to reach the OpenClaw
// gateway on each VPS.
//
// Flow:
//   Otto Backend → SSH tunnel → VPS → ws://127.0.0.1:{gatewayPort}
// ============================================================

export interface TunnelEntry {
  ssh: NodeSSH;
  localPort: number;
  gatewayPort: number;
  gatewayToken: string;
  lastActivity: number;
  refCount: number;
}

// Active SSH tunnels cache (instanceId → tunnel info)
const tunnelCache = new Map<string, TunnelEntry>();

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
 * The tunnel is cached and reused across chat-proxy and messaging.
 */
export async function getOrCreateTunnel(instanceId: string): Promise<TunnelEntry> {
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

  const privateKey = resolveSSHKey(instance.ssh_private_key_enc!);
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

  const entry: TunnelEntry = {
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

/**
 * Release a tunnel reference. When refCount hits 0 and the tunnel is idle
 * for 15 minutes, the cleanup interval will dispose it.
 */
export function releaseTunnel(instanceId: string): void {
  const t = tunnelCache.get(instanceId);
  if (t) {
    t.refCount = Math.max(0, t.refCount - 1);
    t.lastActivity = Date.now();
  }
}
