import type { FastifyInstance } from "fastify";
import { db, schema } from "../db/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";

// In-memory store for setup sessions (simple approach)
const setupSessions = new Map<string, {
  user_id: string;
  instance_id?: string;
  status: string;
  error?: string;
}>();

export async function setupRoutes(app: FastifyInstance) {

  /**
   * POST /api/setup — Assign a pool instance to the user.
   */
  app.post("/setup", async (request, reply) => {
    const { user_id } = request.body as { user_id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) return reply.status(400).send({ error: "Invalid user ID" });

    if (!user_id) {
      return reply.status(400).send({ error: "user_id required" });
    }

    // Auth: verify JWT matches the user_id
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    if (!jwt || jwt.userId !== user_id) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    logger.info({ user_id }, "Setup requested");

    try {
      // Find a ready instance from the pool
      const [instance] = await db
        .select()
        .from(schema.instances)
        .where(
          and(
            eq(schema.instances.status, "ready"),
            isNull(schema.instances.user_id)
          )
        )
        .limit(1);

      if (!instance) {
        return reply.status(503).send({
          error: "No instances available. Please try again in a few minutes.",
        });
      }

      // Assign to user
      await db
        .update(schema.instances)
        .set({
          user_id,
          status: "active",
          assigned_at: new Date(),
        })
        .where(eq(schema.instances.id, instance.id));

      // Store session
      const sessionId = instance.id;
      setupSessions.set(sessionId, {
        user_id,
        instance_id: instance.id,
        status: "whatsapp_qr",
      });

      logger.info({ user_id, instanceId: instance.id }, "Instance assigned to user");

      return {
        session_id: sessionId,
        instance_id: instance.id,
        status: "whatsapp_qr",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ user_id, error: msg }, "Setup failed");
      return reply.status(500).send({ error: msg });
    }
  });

  /**
   * GET /api/setup/:sessionId/status — Poll setup progress.
   */
  app.get("/setup/:sessionId/status", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };

    const session = setupSessions.get(sessionId);
    if (session) {
      return {
        current_step: session.status,
        instance_id: session.instance_id,
        error_message: session.error,
      };
    }

    // Check if it's an instance ID directly
    const [instance] = await db
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, sessionId));

    if (instance) {
      return {
        current_step: instance.status === "active" ? "whatsapp_qr" : instance.status,
        instance_id: instance.id,
      };
    }

    return reply.status(404).send({ error: "Session not found" });
  });
}
