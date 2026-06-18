import type { FastifyInstance } from "fastify";
import { relayQR, type QRRelayMessage } from "../services/qr-relay.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";

export async function qrRoutes(app: FastifyInstance) {
  app.get(
    "/qr/:instanceId",
    { websocket: true },
    async (socket, request) => {
      const { instanceId } = request.params as { instanceId: string };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid instance ID" }));
        socket.close(4002, "invalid_id");
        return;
      }

      // Auth: verify JWT from query param
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get("token");
      if (!token) {
        socket.send(JSON.stringify({ type: "error", message: "Missing auth token" }));
        socket.close(4001, "unauthorized");
        return;
      }
      const jwt = verifyJWT(token);
      if (!jwt) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid token" }));
        socket.close(4001, "unauthorized");
        return;
      }

      logger.info({ instanceId, userId: jwt.userId }, "QR WebSocket opened (authenticated)");

      // Verify instance exists and belongs to user
      const [instance] = await db
        .select()
        .from(schema.instances)
        .where(eq(schema.instances.id, instanceId));

      if (!instance || instance.user_id !== jwt.userId) {
        socket.send(
          JSON.stringify({
            type: "status",
            status: "error",
            message: "Instance not found",
            timestamp: Date.now(),
          })
        );
        socket.close();
        return;
      }

      let cancelled = false;

      // Handle messages from browser
      socket.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.action === "cancel") {
            logger.info({ instanceId }, "QR relay cancelled by user");
            cancelled = true;
            socket.close();
          }

          if (msg.action === "ping") {
            socket.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          }
        } catch {
          // Ignore invalid messages
        }
      });

      socket.on("close", () => {
        cancelled = true;
        logger.info({ instanceId }, "QR WebSocket closed");
      });

      // Start the QR relay
      try {
        for await (const message of relayQR(instanceId)) {
          if (cancelled) break;

          socket.send(JSON.stringify(message));

          // If connected, update the setup session and close
          if (message.type === "status" && message.status === "connected") {
            // Also update setup_session if one exists
            await updateSetupSession(instanceId, message);
            // Give client a moment to process before closing
            setTimeout(() => socket.close(), 2000);
            break;
          }

          // If fatal error or timeout, close
          if (
            message.type === "status" &&
            (message.status === "error" || message.status === "timeout")
          ) {
            setTimeout(() => socket.close(), 1000);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ instanceId, error: msg }, "QR relay stream error");

        if (!cancelled) {
          try {
            socket.send(
              JSON.stringify({
                type: "status",
                status: "error",
                message: `Relay error: ${msg}`,
                timestamp: Date.now(),
              })
            );
          } catch {}
        }
      }
    }
  );

  /**
   * GET /api/qr/:instanceId/status
   *
   * Non-WebSocket fallback: check the current QR/connection status.
   * Used as a polling alternative if WebSocket isn't available.
   */
  app.get("/qr/:instanceId/status", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)) return reply.status(400).send({ error: "Invalid instance ID" });

    const [instance] = await db
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, instanceId));

    if (!instance) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    return {
      instance_id: instance.id,
      status: instance.status,
      health_ok: instance.health_ok,
      channel: instance.channel,
    };
  });
}

/**
 * Update the setup session when WhatsApp connects.
 */
async function updateSetupSession(
  instanceId: string,
  message: QRRelayMessage
) {
  try {
    // Find the setup session for this instance
    const sessions = await db
      .select()
      .from(schema.setupSessions)
      .where(eq(schema.setupSessions.instance_id, instanceId));

    for (const session of sessions) {
      if (!session.completed_at) {
        await db
          .update(schema.setupSessions)
          .set({
            current_step: "verify_connection",
            steps_completed: [
              ...(session.steps_completed || []),
              "generate_qr",
              "verify_connection",
            ],
            completed_at: new Date(),
          })
          .where(eq(schema.setupSessions.id, session.id));
      }
    }
  } catch (err) {
    logger.error({ instanceId, err }, "Failed to update setup session on QR connect");
  }
}
