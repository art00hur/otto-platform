import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { logger } from "../logger.js";

const API_BASE = "https://api.hetzner.cloud/v1";

export interface ProvisionResult {
  provider_instance_id: string;
  ip_address: string;
  ssh_private_key: string;
  ssh_public_key: string;
  hetzner_ssh_key_id: number;
}

function getToken(): string {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN is required");
  return token;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hetzner API error ${res.status} on ${path}: ${body.substring(0, 300)}`);
  }

  // DELETE returns 204 with no body
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

/**
 * Generate an ED25519 SSH key pair using pure Node.js crypto.
 * Converts to OpenSSH format which Hetzner and node-ssh both require.
 */
function generateSSHKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey: pubDer, privateKey: privDer } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // === Public key: convert DER to OpenSSH format ===
  // ED25519 SPKI DER: 12 bytes header + 32 bytes key
  const ed25519Pub = pubDer.subarray(12);
  const typeStr = "ssh-ed25519";
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(typeStr.length);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(ed25519Pub.length);
  const pubBlob = Buffer.concat([typeLen, Buffer.from(typeStr), keyLen, ed25519Pub]);
  const opensshPublic = `ssh-ed25519 ${pubBlob.toString("base64")} claw-pool`;

  // === Private key: convert DER to OpenSSH format ===
  // ED25519 PKCS8 DER: 16 bytes header + 32 bytes private seed
  // But the actual private key seed is the last 32 bytes of a 48-byte sequence
  const privSeed = privDer.subarray(privDer.length - 32);

  // OpenSSH private key format (openssh-key-v1)
  const AUTH_MAGIC = "openssh-key-v1\0";
  const checkInt = Math.floor(Math.random() * 0xFFFFFFFF);
  const checkBuf = Buffer.alloc(4);
  checkBuf.writeUInt32BE(checkInt);

  // Build the private section (unencrypted)
  const comment = "claw-pool";
  const privKeyData = Buffer.concat([
    checkBuf, checkBuf,                          // check bytes (repeated)
    typeLen, Buffer.from(typeStr),                // key type string
    keyLen, ed25519Pub,                           // public key
    uint32(64), Buffer.concat([privSeed, ed25519Pub]), // 64-byte ed25519 secret (seed + pub)
    uint32(comment.length), Buffer.from(comment), // comment
  ]);

  // Pad to block size (8 bytes for none cipher)
  const padded = padToBlockSize(privKeyData, 8);

  // Build the full openssh private key blob
  const privBlob = Buffer.concat([
    Buffer.from(AUTH_MAGIC, "ascii"),
    uint32(4), Buffer.from("none"),               // cipher
    uint32(4), Buffer.from("none"),               // kdf
    uint32(0),                                     // kdf options (empty)
    uint32(1),                                     // number of keys
    uint32(pubBlob.length), pubBlob,              // public key blob
    uint32(padded.length), padded,                // private key blob
  ]);

  const lines: string[] = [];
  const b64 = privBlob.toString("base64");
  lines.push("-----BEGIN OPENSSH PRIVATE KEY-----");
  for (let i = 0; i < b64.length; i += 70) {
    lines.push(b64.substring(i, i + 70));
  }
  lines.push("-----END OPENSSH PRIVATE KEY-----");
  lines.push("");

  return { publicKey: opensshPublic, privateKey: lines.join("\n") };
}

function uint32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
}

function padToBlockSize(data: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (data.length % blockSize);
  if (padLen === blockSize) return data;
  const pad = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) pad[i] = i + 1;
  return Buffer.concat([data, pad]);
}

/**
 * Upload an SSH public key to Hetzner.
 */
async function uploadSSHKey(name: string, publicKey: string): Promise<number> {
  const data = await api<{ ssh_key: { id: number } }>("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  });
  return data.ssh_key.id;
}

/**
 * Delete an SSH key from Hetzner.
 */
export async function deleteSSHKey(keyId: number): Promise<void> {
  try {
    await api(`/ssh_keys/${keyId}`, { method: "DELETE" });
  } catch (err) {
    logger.warn({ keyId, err }, "Failed to delete SSH key (may already be gone)");
  }
}

/**
 * Create a new Hetzner Cloud VPS from a pre-built snapshot.
 * Snapshot has Docker, Node.js, OpenClaw, firewall all pre-configured.
 * Boot time: ~30 seconds instead of 10+ minutes with cloud-init.
 */
// Persistent SSH key — created once, reused for all provisions
let _persistentKey: { id: number; publicKey: string; privateKey: string } | null = null;

let _persistentKeyPromise: Promise<{ id: number; publicKey: string; privateKey: string }> | null = null;

async function getOrCreatePersistentKey(): Promise<{ id: number; publicKey: string; privateKey: string }> {
  if (_persistentKey) return _persistentKey;
  // Serialize: if another call is already creating the key, wait for it
  if (_persistentKeyPromise) return _persistentKeyPromise;
  _persistentKeyPromise = _createPersistentKey();
  try { return await _persistentKeyPromise; } finally { _persistentKeyPromise = null; }
}

async function _createPersistentKey(): Promise<{ id: number; publicKey: string; privateKey: string }> {
  if (_persistentKey) return _persistentKey;

  // Check if our key already exists in Hetzner
  const existing = await api<{ ssh_keys: { id: number; name: string }[] }>("/ssh_keys", { method: "GET" });
  const ottoKey = existing.ssh_keys.find(k => k.name === "otto-control-plane");

  if (ottoKey) {
    // Key exists in Hetzner but we need the private key from env or regenerate
    const storedPrivate = process.env.CONTROL_PLANE_SSH_PRIVATE_KEY;
    const storedPublic = process.env.CONTROL_PLANE_SSH_PUBLIC_KEY;
    if (storedPrivate && storedPublic) {
      _persistentKey = { id: ottoKey.id, publicKey: storedPublic, privateKey: storedPrivate };
      logger.info({ keyId: ottoKey.id }, "Using existing persistent SSH key");
      return _persistentKey;
    }
    // Private key lost — delete old and recreate
    await deleteSSHKey(ottoKey.id);
    logger.warn("Persistent key found but private key missing — recreating");
  }

  // Generate new persistent key
  const { publicKey, privateKey } = generateSSHKeyPair();
  const keyId = await uploadSSHKey("otto-control-plane", publicKey);
  _persistentKey = { id: keyId, publicKey, privateKey };
  logger.info({ keyId }, "Created new persistent SSH key — save CONTROL_PLANE_SSH_PRIVATE_KEY and CONTROL_PLANE_SSH_PUBLIC_KEY to .env for persistence across restarts");
  return _persistentKey;
}

// Initialize persistent key early (call once at import time)
let _initPromise: Promise<void> | null = null;
export async function initPersistentKey(): Promise<void> {
  if (_initPromise) return _initPromise;
  _initPromise = getOrCreatePersistentKey().then(() => {}).catch(e => {
    logger.warn({ error: e.message }, "Failed to pre-create persistent SSH key (will retry on first provision)");
  });
  return _initPromise;
}

export async function createInstance(options: {
  name: string;
  serverType?: string;
  location?: string;
}): Promise<ProvisionResult> {
  const {
    name,
    serverType = process.env.POOL_INSTANCE_TYPE || "cpx11",
    location = process.env.POOL_REGION || "ash",
  } = options;

  const snapshotId = process.env.POOL_SNAPSHOT_ID;
  if (!snapshotId) throw new Error("POOL_SNAPSHOT_ID is required");

  // 1. Get or create persistent SSH key (reused across all provisions)
  const persistentKey = await getOrCreatePersistentKey();
  const { publicKey, privateKey } = persistentKey;
  const sshKeyId = persistentKey.id;
  logger.info({ name, sshKeyId }, "Using persistent SSH key");

  // 3. Create server from snapshot
  const data = await api<{
    server: {
      id: number;
      name: string;
      status: string;
      public_net: { ipv4: { ip: string } };
    };
  }>("/servers", {
    method: "POST",
    body: JSON.stringify({
      name: `claw-${name}`,
      server_type: serverType,
      location,
      image: snapshotId,
      ssh_keys: [sshKeyId],
      labels: {
        managed_by: "claw",
        pool: "true",
      },
    }),
  });

  const server = data.server;
  logger.info(
    { serverId: server.id, ip: server.public_net.ipv4.ip, name },
    "Hetzner server created from snapshot"
  );

  return {
    provider_instance_id: String(server.id),
    ip_address: server.public_net.ipv4.ip,
    ssh_private_key: privateKey,
    ssh_public_key: publicKey,
    hetzner_ssh_key_id: sshKeyId,
  };
}

/**
 * Wait for a Hetzner server to reach "running" status.
 */
export async function waitForRunning(
  serverId: string,
  maxAttempts = 40,
  intervalMs = 5000
): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    const data = await api<{ server: { status: string } }>(`/servers/${serverId}`);

    if (data.server.status === "running") {
      logger.info({ serverId, attempts: i }, "Server is running");
      return;
    }

    logger.debug({ serverId, status: data.server.status, attempt: i }, "Waiting for server");

    if (i < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(`Server ${serverId} did not reach running after ${maxAttempts} checks`);
}

/**
 * Delete a Hetzner server.
 */
export async function deleteInstance(serverId: string): Promise<void> {
  await api(`/servers/${serverId}`, { method: "DELETE" });
  logger.info({ serverId }, "Server deleted");
}

/**
 * List all Hetzner servers managed by Claw.
 */
export async function listInstances(): Promise<
  Array<{ id: number; name: string; status: string; ip: string }>
> {
  const data = await api<{
    servers: Array<{
      id: number;
      name: string;
      status: string;
      public_net: { ipv4: { ip: string } };
      labels: Record<string, string>;
    }>;
  }>("/servers?label_selector=managed_by=claw");

  return data.servers.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    ip: s.public_net.ipv4.ip,
  }));
}

// ----- Helpers -----

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cloud-init script that runs on first boot.
 * Installs Docker, Node.js 22, creates openclaw user, hardens firewall.
 * Drops a marker file when complete so we know when to SSH in.
 */
const CLOUD_INIT_SCRIPT = `#!/bin/bash
set -euo pipefail
exec > /var/log/claw-init.log 2>&1

echo "[claw] Starting cloud-init $(date)"

# System updates (skip upgrade — fresh Ubuntu 24.04 is fine)
apt-get update -qq

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Create non-root user for OpenClaw
useradd -m -s /bin/bash openclaw
usermod -aG docker openclaw

# Set up OpenClaw home directory
sudo -u openclaw mkdir -p /home/openclaw/.openclaw

# Basic firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 18789/tcp comment 'OpenClaw Gateway'
ufw --force enable
ufw limit 22/tcp

# Harden SSH
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart sshd

# Install OpenClaw globally
npm install -g openclaw@latest

# Record installed version
CLAW_VERSION=$(openclaw --version 2>/dev/null || echo "unknown")
echo "$CLAW_VERSION" > /home/openclaw/.openclaw/version

# Signal completion
touch /var/lib/cloud/instance/claw-ready
echo "[claw] Cloud-init complete $(date) — OpenClaw $CLAW_VERSION"
`;
