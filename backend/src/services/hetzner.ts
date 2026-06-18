import { generateKeyPairSync } from "node:crypto";
import { logger } from "../utils/logger.js";
import type { VpsProvider } from "../shared-types.js";

const API_BASE = "https://api.hetzner.cloud/v1";

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  public_net: {
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
}

interface CreateServerResult {
  provider_instance_id: string;
  ip_address: string;
  ssh_private_key: string;
  ssh_public_key: string;
  ssh_key_id: string;
}

function getToken(): string {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error("HETZNER_API_TOKEN is required");
  return token;
}

async function hetznerFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hetzner API ${res.status}: ${body}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Generate an ED25519 SSH key pair for a new server.
 */
function generateSSHKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Convert PEM public key to OpenSSH format for Hetzner
  // We'll use ssh-keygen style, but for simplicity use the raw approach
  return { publicKey, privateKey };
}

/**
 * Upload an SSH key to Hetzner and return the key ID.
 */
async function uploadSSHKey(
  name: string,
  publicKey: string
): Promise<number> {
  const data = await hetznerFetch<{ ssh_key: { id: number } }>("/ssh_keys", {
    method: "POST",
    body: JSON.stringify({ name, public_key: publicKey }),
  });
  return data.ssh_key.id;
}

/**
 * Create a new Hetzner Cloud server.
 */
export async function createServer(options: {
  name: string;
  serverType?: string;
  location?: string;
  image?: string;
  sshPublicKey: string;
}): Promise<{ server: HetznerServer; sshKeyId: number }> {
  const {
    name,
    serverType = "cx23",
    location = "nbg1",
    image = "ubuntu-24.04",
    sshPublicKey,
  } = options;

  // Upload SSH key
  const sshKeyId = await uploadSSHKey(`claw-${name}`, sshPublicKey);
  logger.info({ sshKeyId, name }, "SSH key uploaded to Hetzner");

  // Create server
  const data = await hetznerFetch<{ server: HetznerServer }>("/servers", {
    method: "POST",
    body: JSON.stringify({
      name,
      server_type: serverType,
      location,
      image,
      ssh_keys: [sshKeyId],
      // Cloud-init: basic setup that runs on first boot
      user_data: getCloudInitScript(),
    }),
  });

  logger.info(
    { serverId: data.server.id, ip: data.server.public_net.ipv4.ip },
    "Hetzner server created"
  );

  return { server: data.server, sshKeyId };
}

/**
 * Delete a Hetzner server.
 */
export async function deleteServer(serverId: string): Promise<void> {
  await hetznerFetch(`/servers/${serverId}`, { method: "DELETE" });
  logger.info({ serverId }, "Hetzner server deleted");
}

/**
 * Get server status.
 */
export async function getServer(
  serverId: string
): Promise<HetznerServer> {
  const data = await hetznerFetch<{ server: HetznerServer }>(
    `/servers/${serverId}`
  );
  return data.server;
}

/**
 * Wait for server to be running.
 */
export async function waitForServer(
  serverId: string,
  maxAttempts = 30,
  interval = 5000
): Promise<HetznerServer> {
  for (let i = 1; i <= maxAttempts; i++) {
    const server = await getServer(serverId);
    if (server.status === "running") {
      logger.info({ serverId, attempts: i }, "Server is running");
      return server;
    }
    logger.debug({ serverId, status: server.status, attempt: i }, "Waiting for server");
    if (i < maxAttempts) {
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error(`Server ${serverId} did not reach running state`);
}

/**
 * Delete an SSH key from Hetzner.
 */
export async function deleteSSHKey(keyId: number): Promise<void> {
  await hetznerFetch(`/ssh_keys/${keyId}`, { method: "DELETE" });
}

/**
 * Cloud-init script: installs Docker + basic hardening on first boot.
 * This runs automatically when the VPS starts, saving us SSH setup time.
 */
function getCloudInitScript(): string {
  return `#!/bin/bash
set -euo pipefail

# Update system
apt-get update -qq
apt-get upgrade -y -qq

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Node.js 22 (for OpenClaw)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Create non-root user for OpenClaw
useradd -m -s /bin/bash openclaw
usermod -aG docker openclaw

# Basic firewall: only SSH + OpenClaw gateway port
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 18789/tcp comment 'OpenClaw Gateway'
ufw --force enable

# Rate limit SSH
ufw limit 22/tcp

# Disable password auth
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd

# Signal that cloud-init is done
touch /var/lib/cloud/instance/claw-ready
`;
}

export const provider: VpsProvider = "hetzner";
