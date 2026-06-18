/**
 * Usage Routes — Real-time AI usage tracking endpoints.
 *
 * GET /api/usage/:instanceId/refresh — Fetch latest usage from OpenRouter
 *   and update the DB. Called by the dashboard after each AI response.
 *   Returns { ok, usage: { used_cents, limit_cents, bonus_cents, total_limit_cents, usage_percent } }
 */

import type { FastifyInstance } from "fastify";
import { verifyJWT } from "./auth.js";
import { db } from "../db/index.js";
import { subscriptions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { refreshInstanceUsage } from "../services/usage-sync.js";
import { logger } from "../utils/logger.js";

export default async function usageRoutes(app: FastifyInstance) {
  app.get("/api/usage/:instanceId/refresh", async (request, reply) => {
    // Auth
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing token" });
    }
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) {
      return reply.code(401).send({ error: "Invalid token" });
    }

    const instanceId = (request.params as any).instanceId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        instanceId
      )
    ) {
      return reply.code(400).send({ error: "Invalid instance ID" });
    }

    // Verify ownership
    const userId = decoded.userId;
    const [sub] = await db
      .select({ instance_id: subscriptions.instance_id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.user_id, userId),
          eq(subscriptions.instance_id, instanceId)
        )
      );

    if (!sub) {
      return reply.code(403).send({ error: "Not authorized for this instance" });
    }

    // Refresh usage from OpenRouter
    const result = await refreshInstanceUsage(instanceId);

    if (!result) {
      // Fallback: return current DB values without refreshing
      const [currentSub] = await db
        .select({
          ai_credits_used: subscriptions.ai_credits_used,
          ai_credits_limit: subscriptions.ai_credits_limit,
          ai_credits_bonus: subscriptions.ai_credits_bonus,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.user_id, userId),
            eq(subscriptions.instance_id, instanceId)
          )
        );

      const used = currentSub?.ai_credits_used || 0;
      const limit = currentSub?.ai_credits_limit || 0;
      const bonus = currentSub?.ai_credits_bonus || 0;
      const total = limit + bonus;

      return {
        ok: true,
        refreshed: false,
        usage: {
          used_cents: used,
          limit_cents: limit,
          bonus_cents: bonus,
          total_limit_cents: total,
          usage_percent: total > 0 ? Math.round((used / total) * 100) : 0,
        },
      };
    }

    const totalLimit = result.limitCents + result.bonusCents;

    return {
      ok: true,
      refreshed: true,
      usage: {
        used_cents: result.usageCents,
        limit_cents: result.limitCents,
        bonus_cents: result.bonusCents,
        total_limit_cents: totalLimit,
        usage_percent:
          totalLimit > 0
            ? Math.round((result.usageCents / totalLimit) * 100)
            : 0,
      },
    };
  });

  logger.info("Usage routes registered");
}
