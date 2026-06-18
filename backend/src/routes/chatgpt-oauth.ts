import type { FastifyInstance } from "fastify";
import { NodeSSH } from "node-ssh";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { resolveSSHKey } from "../services/ssh.js";

/**
 * ChatGPT OAuth Routes
 *
 * Allows users to connect their ChatGPT Plus/Pro/Max subscription
 * via OpenAI's Codex OAuth flow. When connected, GPT model requests
 * are routed through the user's subscription instead of Otto's OpenRouter credits.
 *
 * Routes:
 *   GET    /api/agents/:instanceId/chatgpt-oauth  — Check OAuth status
 *   POST   /api/agents/:instanceId/chatgpt-oauth  — Initiate OAuth flow
 *   DELETE /api/agents/:instanceId/chatgpt-oauth  — Disconnect OAuth
 */

export async function chatgptOAuthRoutes(app: FastifyInstance) {
  // ── Auth helper ──
  async function authenticate(request: any, reply: any) {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      reply.code(401).send({ error: "Missing token" });
      return null;
    }
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) {
      reply.code(401).send({ error: "Invalid token" });
      return null;
    }

    const instanceId = (request.params as any).instanceId;
    const [instance] = await db
      .select()
      .from(instances)
      .where(eq(instances.id, instanceId));

    if (!instance || instance.user_id !== decoded.userId) {
      reply.code(404).send({ error: "Instance not found" });
      return null;
    }

    return { userId: decoded.userId, instanceId, instance };
  }

  async function sshToInstance(instance: any): Promise<NodeSSH> {
    const privateKey = resolveSSHKey(instance.ssh_private_key_enc);

    const ssh = new NodeSSH();
    await ssh.connect({
      host: instance.ip_address,
      port: 22,
      username: "root",
      privateKey,
      readyTimeout: 15_000,
    });
    return ssh;
  }

  /**
   * GET /api/agents/:instanceId/chatgpt-oauth
   * Check if ChatGPT OAuth is connected on this instance.
   */
  app.get("/agents/:instanceId/chatgpt-oauth", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    let ssh: NodeSSH | null = null;
    try {
      ssh = await sshToInstance(auth.instance);

      // Check if OpenClaw has OpenAI auth configured — try multiple locations
      const result = await ssh.execCommand(
        `sudo -u openclaw sh -c '
          cat /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null ||
          cat /home/openclaw/.openclaw/auth-profiles.json 2>/dev/null ||
          echo "{}"
        '`
      );

      // Also try `openclaw models auth status` for a more reliable check
      const statusResult = await ssh.execCommand(
        "sudo -u openclaw openclaw models auth status --json 2>/dev/null || echo '{}'"
      );

      let hasOpenAI = false;
      try {
        const profiles = JSON.parse(result.stdout || "{}");
        hasOpenAI =
          !!profiles.openai?.access_token ||
          !!profiles["openai-codex"]?.access_token ||
          !!profiles["openai-chat"]?.access_token;
      } catch {}

      if (!hasOpenAI) {
        try {
          const statusData = JSON.parse(statusResult.stdout || "{}");
          hasOpenAI = !!(statusData.openai || statusData["openai-codex"] || statusData["openai-chat"]);
        } catch {}
      }

      return {
        connected: !!hasOpenAI,
        provider: hasOpenAI ? "openai-codex" : null,
      };
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "Failed to check ChatGPT OAuth status"
      );
      return { connected: false, error: e.message };
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  /**
   * POST /api/agents/:instanceId/chatgpt-oauth
   * Initiate the Codex OAuth flow on the VPS.
   *
   * This runs `openclaw onboard --auth openai-codex` on the VPS,
   * which generates an OAuth URL. We return that URL to the frontend
   * so the user can authenticate in a popup window.
   */
  app.post("/agents/:instanceId/chatgpt-oauth", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    let ssh: NodeSSH | null = null;
    try {
      ssh = await sshToInstance(auth.instance);

      // `openclaw models auth login --provider <id>` — provider plugin OAuth flow
      // Try openai, openai-chat, openai-codex as potential provider IDs
      const commands = [
        "sudo -u openclaw timeout 30 openclaw models auth login --provider openai --json 2>&1",
        "sudo -u openclaw timeout 30 openclaw models auth login --provider openai-chat --json 2>&1",
        "sudo -u openclaw timeout 30 openclaw models auth login --provider openai-codex --json 2>&1",
        "sudo -u openclaw timeout 30 openclaw models auth login --provider openai --set-default 2>&1",
      ];

      let oauthUrl: string | null = null;
      let lastOutput = "";

      for (const cmd of commands) {
        logger.info({ instanceId: auth.instanceId, cmd }, "Trying OAuth command");
        const result = await ssh.execCommand(cmd);
        const output = (result.stdout + "\n" + result.stderr).trim();
        lastOutput = output;

        logger.info(
          { instanceId: auth.instanceId, output: output.substring(0, 300) },
          "ChatGPT OAuth command output"
        );

        // Skip if command not found or unknown
        if (
          output.includes("unknown command") ||
          output.includes("not found") ||
          output.includes("unrecognized") ||
          output.includes("invalid") ||
          output.includes("Usage:")
        ) {
          continue;
        }

        // Try JSON parse for URL
        for (const line of output.split("\n")) {
          try {
            const parsed = JSON.parse(line);
            oauthUrl =
              parsed.url ||
              parsed.auth_url ||
              parsed.oauth_url ||
              parsed.authorization_url ||
              parsed.login_url ||
              null;
            if (oauthUrl) break;
          } catch {}
        }

        // Fallback: look for any OpenAI URL
        if (!oauthUrl) {
          const urlMatch = output.match(
            /https:\/\/(?:auth|accounts|chat|platform)\.openai\.com[^\s"'<>)]+/
          );
          if (urlMatch) oauthUrl = urlMatch[0];
        }

        // Also check for any generic OAuth URL
        if (!oauthUrl) {
          const genericMatch = output.match(
            /https:\/\/[^\s"'<>)]+(?:oauth|authorize|login|auth)[^\s"'<>)]+/i
          );
          if (genericMatch) oauthUrl = genericMatch[0];
        }

        if (oauthUrl) break;
      }

      if (oauthUrl) {
        return { ok: true, oauth_url: oauthUrl };
      }

      // If no URL found, check if already connected
      const checkResult = await ssh.execCommand(
        "sudo -u openclaw cat /home/openclaw/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || echo '{}'"
      );
      const profiles = JSON.parse(checkResult.stdout || "{}");
      if (
        profiles.openai?.access_token ||
        profiles["openai-codex"]?.access_token
      ) {
        return { ok: true, connected: true, message: "Already connected" };
      }

      // Check what auth commands are actually available
      const helpResult = await ssh.execCommand(
        "sudo -u openclaw openclaw models auth --help 2>&1"
      );

      return reply.code(500).send({
        error:
          "Could not generate OAuth URL. The OpenClaw version on this VPS may not support Codex OAuth yet.",
        debug: lastOutput.substring(0, 300),
        available_commands: helpResult.stdout.substring(0, 500),
      });
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "ChatGPT OAuth initiation failed"
      );
      return reply
        .code(502)
        .send({ error: "Failed to start OAuth: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });

  /**
   * DELETE /api/agents/:instanceId/chatgpt-oauth
   * Disconnect ChatGPT OAuth — remove stored tokens from VPS.
   */
  app.delete("/agents/:instanceId/chatgpt-oauth", async (request, reply) => {
    const auth = await authenticate(request, reply);
    if (!auth) return;

    let ssh: NodeSSH | null = null;
    try {
      ssh = await sshToInstance(auth.instance);

      // Remove the OpenAI auth profile via CLI, then fallback to manual cleanup
      await ssh.execCommand(
        "sudo -u openclaw openclaw models auth remove openai 2>&1 || sudo -u openclaw openclaw models auth delete openai 2>&1 || sudo -u openclaw openclaw models auth remove --provider openai 2>&1 || true"
      );

      // Also manually clean auth-profiles.json as fallback
      await ssh.execCommand(
        `sudo -u openclaw python3 -c "
import json, os
path = '/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json'
if os.path.exists(path):
    with open(path) as f:
        d = json.load(f)
    d.pop('openai', None)
    d.pop('openai-codex', None)
    with open(path, 'w') as f:
        json.dump(d, f, indent=2)
    print('cleaned')
else:
    print('no file')
" 2>&1`
      );

      logger.info(
        { instanceId: auth.instanceId },
        "ChatGPT OAuth disconnected"
      );

      return { ok: true, disconnected: true };
    } catch (e: any) {
      logger.error(
        { instanceId: auth.instanceId, error: e.message },
        "ChatGPT OAuth disconnect failed"
      );
      return reply
        .code(502)
        .send({ error: "Failed to disconnect: " + e.message });
    } finally {
      if (ssh) try { ssh.dispose(); } catch {}
    }
  });
}
