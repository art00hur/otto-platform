import { WebSocket as WS } from "ws";
import { logger } from "../../utils/logger.js";
import { getOrCreateTunnel, releaseTunnel } from "../ssh-tunnel.js";
import type { ChannelProvider } from "./types.js";

// ============================================================
// Message Router
//
// Bridges incoming messages from any channel (Telegram, WhatsApp)
// to the OpenClaw agent via SSH tunnel + WebSocket, and sends
// the response back through the same channel.
//
// Flow:
//   Channel webhook → router.handleMessage()
//     → sendTypingAction
//     → getOrCreateTunnel(instanceId)
//     → open WS to gateway → send message → collect response
//     → provider.sendMessage(response)
//     → releaseTunnel
// ============================================================

const AGENT_TIMEOUT_MS = 60_000; // 60s max wait for agent response
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

// Simple in-memory rate limiter per chatId
const rateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(chatId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(chatId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(chatId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Cleanup rate limiter every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of rateLimiter) {
    if (now > entry.resetAt) rateLimiter.delete(id);
  }
}, 5 * 60 * 1000);

/**
 * Send a message to the OpenClaw agent via the SSH tunnel + WebSocket
 * and return the agent's response.
 */
/**
 * Send a message to the OpenClaw agent via SSH tunnel + WebSocket.
 * Protocol:
 *   1. connect.challenge → auth with gateway token
 *   2. hello-ok → sessions.create (get session key)
 *   3. sessions.send with key + message
 *   4. Listen for session.message events → collect final response
 *   5. Detect run completion via session.run.end event
 */
async function sendToAgent(
  instanceId: string,
  agentId: string,
  message: string
): Promise<string> {
  const tunnel = await getOrCreateTunnel(instanceId);

  return new Promise<string>((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${tunnel.localPort}`, {
      headers: { origin: "http://127.0.0.1" },
    });
    let responseText = "";
    let resolved = false;
    let phase: "challenge" | "auth" | "send" | "listen" = "challenge";

    const cleanup = () => {
      try { ws.close(); } catch {}
      releaseTunnel(instanceId);
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        // If we got partial text, return it instead of failing
        if (responseText) {
          resolve(responseText);
        } else {
          reject(new Error("Agent timeout"));
        }
      }
    }, AGENT_TIMEOUT_MS);

    ws.on("error", (err: any) => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    ws.on("close", () => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        releaseTunnel(instanceId);
        resolve(responseText || "(connection closed)");
      }
    });

    ws.on("message", (data: any) => {
      try {
        const msg = JSON.parse(data.toString());

        // Step 1: connect.challenge → auth
        if (phase === "challenge" && msg.type === "event" && msg.event === "connect.challenge") {
          phase = "auth";
          ws.send(JSON.stringify({
            type: "req", id: "c1", method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: "openclaw-control-ui", version: "2026.2.23", platform: "linux", mode: "webchat" },
              role: "operator", scopes: ["operator.admin"],
              caps: [], commands: [], permissions: {},
              auth: { token: tunnel.gatewayToken },
              locale: "fr-FR", userAgent: "otto-messaging/1.0",
            },
          }));
          return;
        }

        // Step 2: hello-ok → sessions.send directly to agent:NAME:main
        // Using the main session (not sessions.create) so the agent is NOT
        // sandboxed and can delegate to other agents via sessions_send.
        if (phase === "auth" && msg.type === "res" && msg.id === "c1") {
          if (!msg.ok) {
            clearTimeout(timeout); resolved = true; cleanup();
            reject(new Error(msg.error?.message || "Gateway auth failed"));
            return;
          }
          phase = "listen";
          ws.send(JSON.stringify({
            type: "req", id: "m1", method: "sessions.send",
            params: { key: `agent:${agentId}:main`, message },
          }));
          return;
        }

        // Step 4: Listen for agent response events
        if (phase === "listen") {
          // Streamed text fragments (event: "agent", stream: "assistant")
          if (msg.type === "event" && msg.event === "agent" && msg.payload?.stream === "assistant") {
            const delta = msg.payload?.data?.delta || msg.payload?.data?.text || "";
            if (delta) responseText += delta;
          }
          // Final chat message (event: "chat", state: "final", role: "assistant")
          if (msg.type === "event" && msg.event === "chat" && msg.payload?.state === "final") {
            const raw = msg.payload?.message?.content || msg.payload?.message?.text || "";
            // content can be a string or an array of {type:"text", text:"..."} objects
            let content = "";
            if (typeof raw === "string") {
              content = raw;
            } else if (Array.isArray(raw)) {
              content = raw
                .filter((c: any) => c?.type === "text" || c?.type === "toolResult")
                .map((c: any) => c.text || c.content || "")
                .join("\n");
            }
            if (content) responseText = content;
          }
          // Run lifecycle end (event: "agent", stream: "lifecycle", phase: "end")
          if (msg.type === "event" && msg.event === "agent"
              && msg.payload?.stream === "lifecycle" && msg.payload?.data?.phase === "end") {
            // Wait a tick for the final chat message to arrive
            setTimeout(() => {
              if (!resolved && responseText) {
                clearTimeout(timeout); resolved = true; cleanup();
                resolve(responseText);
              }
            }, 500);
          }
          // Error during run
          if (msg.type === "event" && msg.event === "agent"
              && msg.payload?.stream === "lifecycle" && msg.payload?.data?.phase === "error") {
            clearTimeout(timeout); resolved = true; cleanup();
            reject(new Error(msg.payload?.data?.error || "Agent run error"));
          }
        }
      } catch (err) {
        logger.warn({ err, data: data.toString().slice(0, 200) }, "Failed to parse gateway message");
      }
    });
  });
}

/**
 * Handle an incoming message from any channel.
 * This is the main entry point called by webhook routes.
 */
export async function handleMessage(
  provider: ChannelProvider,
  chatId: string,
  text: string,
  instanceId: string,
  agentId: string = "marie"
): Promise<void> {
  // Rate limit check
  if (!checkRateLimit(chatId)) {
    await provider.sendMessage(chatId, "Tu vas trop vite, attends quelques secondes.");
    return;
  }

  // Send typing indicator
  await provider.sendTypingAction(chatId);

  try {
    const response = await sendToAgent(instanceId, agentId, text);
    // Ensure response is always a string (guard against object/array leaks)
    const responseStr = typeof response === "string" ? response : JSON.stringify(response);
    await provider.sendMessage(chatId, responseStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, chatId, instanceId, provider: provider.name }, "Message routing failed");

    if (msg.includes("timeout") || msg.includes("Timeout")) {
      await provider.sendMessage(chatId, "Ton agent ne répond pas pour le moment. Réessaie dans quelques instants.");
    } else if (msg.includes("Instance not found") || msg.includes("not active")) {
      await provider.sendMessage(chatId, "Ton serveur est inaccessible. Vérifie qu'il est en ligne.");
    } else if (msg.includes("No SSH key") || msg.includes("SSH")) {
      await provider.sendMessage(chatId, "Ton agent est temporairement indisponible.");
    } else {
      await provider.sendMessage(chatId, "Une erreur est survenue. Réessaie.");
    }
  }
}

/**
 * Send a notification (brief, CRM alert) to a linked chat.
 * Does not expect a response from the agent.
 */
export async function sendNotification(
  provider: ChannelProvider,
  chatId: string,
  text: string
): Promise<void> {
  try {
    await provider.sendMessage(chatId, text);
  } catch (err) {
    logger.error({ err, chatId, provider: provider.name }, "Failed to send notification");
  }
}
