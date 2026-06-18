import { NodeSSH } from "node-ssh";
import { logger } from "../utils/logger.js";
import { decrypt } from "../utils/encryption.js";

/**
 * Resolve the SSH private key for an instance.
 * Priority: CONTROL_PLANE_SSH_PRIVATE_KEY env var > encrypted key in DB.
 * Single source of truth — all routes should use this instead of inlining the logic.
 */
export function resolveSSHKey(sshPrivateKeyEnc: string | null): string {
  const envKey = process.env.CONTROL_PLANE_SSH_PRIVATE_KEY;
  if (envKey) {
    return envKey.replace(/\\n/g, "\n");
  }
  if (sshPrivateKeyEnc) {
    return decrypt(sshPrivateKeyEnc);
  }
  throw new Error("No SSH key available (neither CONTROL_PLANE_SSH_PRIVATE_KEY env var nor ssh_private_key_enc in DB)");
}

export interface SSHConfig {
  host: string;
  username?: string;
  privateKey: string;
  port?: number;
  readyTimeout?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5_000;

/**
 * Create an SSH connection to a VPS.
 * Retries on connection failure (VPS may still be booting).
 */
export async function connect(config: SSHConfig): Promise<NodeSSH> {
  const ssh = new NodeSSH();
  const { host, username = "root", privateKey, port = 22, readyTimeout = DEFAULT_TIMEOUT } = config;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await ssh.connect({
        host,
        port,
        username,
        privateKey,
        readyTimeout,
        // Ignore host key for newly provisioned servers
        algorithms: {
          serverHostKey: [
            "ssh-ed25519",
            "ecdsa-sha2-nistp256",
            "ssh-rsa",
            "rsa-sha2-256",
            "rsa-sha2-512",
          ],
        },
      });

      logger.info({ host, attempt }, "SSH connected");
      return ssh;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ host, attempt, error: message }, "SSH connection attempt failed");

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * attempt);
      } else {
        throw new Error(`SSH connection failed after ${MAX_RETRIES} attempts: ${message}`);
      }
    }
  }

  throw new Error("Unreachable");
}

/**
 * Execute a command over SSH with timeout.
 */
export async function exec(
  ssh: NodeSSH,
  command: string,
  options: { cwd?: string; timeout?: number; stream?: "stdout" | "stderr" | "both" } = {}
): Promise<CommandResult> {
  const { cwd, timeout = DEFAULT_TIMEOUT } = options;

  logger.debug({ command: command.substring(0, 100) }, "SSH exec");

  const result = await Promise.race([
    ssh.execCommand(command, { cwd }),
    timeoutPromise<never>(timeout, `Command timed out after ${timeout}ms: ${command.substring(0, 50)}`),
  ]);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  };
}

/**
 * Execute a command and throw if it fails (non-zero exit).
 */
export async function execOrFail(
  ssh: NodeSSH,
  command: string,
  options: { cwd?: string; timeout?: number } = {}
): Promise<CommandResult> {
  const result = await exec(ssh, command, options);

  if (result.code !== 0) {
    throw new Error(
      `Command failed (exit ${result.code}): ${command.substring(0, 80)}\n` +
      `stderr: ${result.stderr.substring(0, 500)}`
    );
  }

  return result;
}

/**
 * Upload a string as a file on the remote server.
 */
export async function writeFile(
  ssh: NodeSSH,
  remotePath: string,
  content: string,
  mode?: string
): Promise<void> {
  // Use heredoc to avoid escaping issues
  const escaped = content.replace(/'/g, "'\\''");
  const cmd = mode
    ? `cat > ${remotePath} << 'CLAWEOF'\n${content}\nCLAWEOF\nchmod ${mode} ${remotePath}`
    : `cat > ${remotePath} << 'CLAWEOF'\n${content}\nCLAWEOF`;

  await execOrFail(ssh, cmd);
}

/**
 * Read a file from the remote server.
 */
export async function readFile(ssh: NodeSSH, remotePath: string): Promise<string> {
  const result = await execOrFail(ssh, `cat ${remotePath}`);
  return result.stdout;
}

/**
 * Check if a command/binary exists on the remote server.
 */
export async function commandExists(ssh: NodeSSH, cmd: string): Promise<boolean> {
  const result = await exec(ssh, `which ${cmd}`);
  return result.code === 0;
}

/**
 * Wait for a condition to be true, polling periodically.
 */
export async function waitFor(
  ssh: NodeSSH,
  checkCommand: string,
  options: { maxAttempts?: number; interval?: number; description?: string } = {}
): Promise<void> {
  const { maxAttempts = 30, interval = 2000, description = "condition" } = options;

  for (let i = 1; i <= maxAttempts; i++) {
    const result = await exec(ssh, checkCommand);
    if (result.code === 0) {
      logger.debug({ description, attempts: i }, "Wait condition met");
      return;
    }
    if (i < maxAttempts) await sleep(interval);
  }

  throw new Error(`Timed out waiting for ${description} after ${maxAttempts} attempts`);
}

/**
 * Safely disconnect SSH.
 */
export function disconnect(ssh: NodeSSH): void {
  try {
    ssh.dispose();
    logger.debug("SSH disconnected");
  } catch {
    // Ignore disconnect errors
  }
}

// ----- Helpers -----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}
