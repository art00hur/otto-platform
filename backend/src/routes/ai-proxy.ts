import Fastify from "fastify";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { subscriptions, instances } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import {
  preFlightCheck,
  recordSpend,
  validateRequestCost,
  cacheUserCredits,
} from "../services/spending-guard.js";

// ============================================================
// AI Proxy — OpenAI-compatible endpoint for cost tracking
// ============================================================
//
// STATUS: NOT CURRENTLY USED BY VPS INSTANCES.
//
// VPS instances talk directly to OpenRouter using per-customer
// API keys created by the pool worker. Credit tracking is done
// via the usage-sync service polling OpenRouter's provisioning API.
//
// This proxy route exists for future use if we need finer-grained
// control (per-request cost tracking, model overrides, etc).
// The proxy_token column in the instances table is unused.
// ============================================================

const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_KEY = process.env.OPENROUTER_MASTER_KEY || process.env.OPENROUTER_API_KEY || "";

// Per-user rate limiting — sliding window
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_PLAN: Record<string, number> = {
  free: 5,
  starter: 10,
  pro: 20,
  ultra: 40,
};

// Credit limits per plan (in cents) — these are the monthly API cost caps
export const PLAN_CREDITS: Record<string, number> = {
  free: 100,       // €1 (~50 messages with cheap models)
  starter: 1500,   // €15
  pro: 6000,       // €60
  ultra: 10000,    // €100
};

// Threshold at which we switch to cheap models (95% of credit limit)
const ECONOMY_MODE_THRESHOLD = 0.95;

// Cheap fallback model — fast and very low cost (~$0.10/1M tokens)
const ECONOMY_MODEL = "google/gemini-2.0-flash-lite-001";

// Models that are allowed even in economy mode (all very cheap)
const ECONOMY_ALLOWED_MODELS = new Set([
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.1-8b-instruct",
  "meta-llama/llama-3.2-3b-instruct",
  "mistralai/mistral-small-2501",
  "openrouter/auto",  // auto will route to cheap models when we override
]);

// Free tier: only allow cheap models
const FREE_TIER_ALLOWED_MODELS = new Set([
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.5-flash-preview",
  "anthropic/claude-haiku-4-5",
  "meta-llama/llama-3.1-8b-instruct",
  "meta-llama/llama-3.2-3b-instruct",
  "mistralai/mistral-small-2501",
  "openrouter/auto",
]);

const FREE_TIER_DEFAULT_MODEL = "google/gemini-2.0-flash-001";

interface ProxyAuthResult {
  instanceId: string;
  userId: string;
  subscriptionId: string;
  plan: string;
  creditsUsedCents: number;
  creditsLimitCents: number;
}

function parseClawToken(authHeader: string | undefined): { instanceId: string; authToken: string } | null {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith("claw_")) return null;
  const parts = token.split("_");
  if (parts.length < 3) return null;
  return { instanceId: parts[1], authToken: parts.slice(2).join("_") };
}

async function authenticateRequest(authHeader: string | undefined): Promise<ProxyAuthResult | null> {
  const parsed = parseClawToken(authHeader);
  if (!parsed) return null;

  const result = await db
    .select({
      instanceId: instances.id,
      userId: instances.user_id,
      proxyToken: instances.proxy_token,
      subId: subscriptions.id,
      plan: subscriptions.plan,
      creditsUsed: subscriptions.ai_credits_used,
      creditsLimit: subscriptions.ai_credits_limit,
      creditsBonus: subscriptions.ai_credits_bonus,
      subStatus: subscriptions.status,
    })
    .from(instances)
    .innerJoin(subscriptions, and(
      eq(subscriptions.instance_id, instances.id),
      eq(subscriptions.status, "active")
    ))
    .where(and(eq(instances.id, parsed.instanceId), eq(instances.status, "active")))
    .limit(1);

  if (result.length === 0) return null;
  const row = result[0];

  if (row.proxyToken !== parsed.authToken) return null;
  if (row.subStatus !== "active" && row.subStatus !== "trialing") return null;

  // Total credits = plan limit + any purchased bonus credits
  const totalCredits = row.creditsLimit + (row.creditsBonus || 0);

  return {
    instanceId: row.instanceId,
    userId: row.userId!,
    subscriptionId: row.subId,
    plan: row.plan,
    creditsUsedCents: row.creditsUsed,
    creditsLimitCents: totalCredits,
  };
}

function checkRateLimit(userId: string, plan: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const maxReqs = RATE_LIMIT_MAX_PER_PLAN[plan] || 12;
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count >= maxReqs) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

function extractCostCents(responseBody: any, responseHeaders: Headers): number {
  // OpenRouter's x-openrouter-cost header gives exact cost in dollars
  const costHeader = responseHeaders.get("x-openrouter-cost");
  if (costHeader) {
    const costDollars = parseFloat(costHeader);
    if (!isNaN(costDollars)) {
      return Math.max(1, Math.ceil(costDollars * 100));
    }
  }

  // Fallback: estimate from token counts
  const usage = responseBody?.usage;
  if (usage) {
    const totalTokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    const estimatedCost = (totalTokens / 1_000_000) * 5; // ~$5/1M blended avg
    return Math.max(1, Math.ceil(estimatedCost * 100));
  }

  return 1; // Minimum 1 cent per request
}

/**
 * Register AI proxy routes.
 */
export function registerAIProxyRoutes(app: ReturnType<typeof Fastify>) {

  // ============================================================
  // POST /api/ai/v1/chat/completions — OpenAI-compatible endpoint
  // This is the main route OpenClaw hits via OpenRouter provider
  // ============================================================
  app.post("/api/ai/v1/chat/completions", async (request, reply) => {
    const auth = await authenticateRequest(request.headers.authorization);

    if (!auth) {
      return reply.status(401).send({
        error: { message: "Invalid or expired API key.", type: "authentication_error", code: "invalid_api_key" },
      });
    }

    const rateCheck = checkRateLimit(auth.userId, auth.plan);
    if (!rateCheck.allowed) {
      reply.header("Retry-After", Math.ceil(rateCheck.retryAfterMs / 1000));
      return reply.status(429).send({
        error: { message: `Rate limit exceeded (${RATE_LIMIT_MAX_PER_PLAN[auth.plan] || 12}/min on ${auth.plan} plan). Retry in ${Math.ceil(rateCheck.retryAfterMs / 1000)}s.`, type: "rate_limit_error" },
      });
    }

    // Cache user credits for fast-path checks
    cacheUserCredits(auth.userId, auth.creditsUsedCents, auth.creditsLimitCents);

    // Spending guard: global circuit breaker + per-user credit check
    const spendCheck = preFlightCheck(auth.userId, auth.creditsUsedCents, auth.creditsLimitCents);
    if (!spendCheck.allowed) {
      const statusCode = spendCheck.reason?.includes("credits exhausted") ? 402 : 503;
      return reply.status(statusCode).send({
        error: {
          message: spendCheck.reason === "AI credits exhausted"
            ? `AI credits exhausted ($${(auth.creditsLimitCents / 100).toFixed(2)} used). Buy more credits at ${process.env.FRONTEND_URL || "https://claw.so"}/dashboard?topup=true or upgrade your plan.`
            : `AI service temporarily unavailable: ${spendCheck.reason}. Please try again later.`,
          type: spendCheck.reason === "AI credits exhausted" ? "insufficient_credits" : "service_unavailable",
          credits_used: (auth.creditsUsedCents / 100).toFixed(2),
          credits_limit: (auth.creditsLimitCents / 100).toFixed(2),
          topup_url: `${process.env.FRONTEND_URL || "https://claw.so"}/dashboard?topup=true`,
        },
      });
    }

    const body = request.body as any;

    // ── Free tier: restrict to cheap models only ──
    if (auth.plan === "free") {
      const requestedModel = body.model || "openrouter/auto";
      if (!FREE_TIER_ALLOWED_MODELS.has(requestedModel)) {
        body.model = FREE_TIER_DEFAULT_MODEL;
        logger.info({
          userId: auth.userId,
          originalModel: requestedModel,
          forcedModel: FREE_TIER_DEFAULT_MODEL,
        }, "Free tier: forced cheap model");
      }
    }

    // ── Economy mode: if user is at 95%+ of their credit limit, force cheap models ──
    const usagePercent = auth.creditsLimitCents > 0
      ? auth.creditsUsedCents / auth.creditsLimitCents
      : 0;
    let modelOverridden = false;
    let originalModel = body.model;

    if (usagePercent >= ECONOMY_MODE_THRESHOLD) {
      const requestedModel = body.model || "openrouter/auto";

      if (!ECONOMY_ALLOWED_MODELS.has(requestedModel)) {
        body.model = ECONOMY_MODEL;
        modelOverridden = true;
        logger.info({
          userId: auth.userId,
          originalModel: requestedModel,
          forcedModel: ECONOMY_MODEL,
          usagePercent: Math.round(usagePercent * 100),
        }, "Economy mode: forced cheap model (95%+ credit usage)");
      }

      // Inject a system message warning the user
      if (!body._economyWarningInjected) {
        const warningMsg = {
          role: "system",
          content: `[SYSTEM NOTICE] This customer has used ${Math.round(usagePercent * 100)}% of their monthly AI credits. You are now running on a lightweight model to conserve remaining credits. Keep responses concise and efficient. If the customer needs full-power models, they should upgrade their plan or purchase more credits.`,
        };
        if (Array.isArray(body.messages)) {
          // Insert after first system message, or at start
          const firstSysIdx = body.messages.findIndex((m: any) => m.role === "system");
          if (firstSysIdx >= 0) {
            body.messages.splice(firstSysIdx + 1, 0, warningMsg);
          } else {
            body.messages.unshift(warningMsg);
          }
        }
        body._economyWarningInjected = true;
      }
    }

    try {
      // Clean internal flags before forwarding to OpenRouter
      const forwardBody = { ...body };
      delete forwardBody._economyWarningInjected;

      const orResponse = await fetch(`${OPENROUTER_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "HTTP-Referer": process.env.FRONTEND_URL || "https://claw.so",
          "X-Title": "Claw",
          "X-OpenRouter-User-Id": auth.userId,
        },
        body: JSON.stringify(forwardBody),
      });

      // --- Non-streaming ---
      if (!body.stream) {
        const responseBody = await orResponse.json() as any;
        const costCents = extractCostCents(responseBody, orResponse.headers);

        if (costCents > 0) {
          // Validate cost isn't suspiciously high (e.g., a $50 single request)
          if (!validateRequestCost(costCents)) {
            logger.error({ costCents, userId: auth.userId, model: body.model }, "Blocked suspiciously expensive request");
            // Still return the response (already generated) but don't charge more than the cap
            const cappedCost = parseInt(process.env.MAX_SINGLE_REQUEST_CENTS || "500", 10);
            recordSpend(auth.userId, cappedCost);
            db.update(subscriptions)
              .set({ ai_credits_used: sql`${subscriptions.ai_credits_used} + ${cappedCost}` })
              .where(eq(subscriptions.id, auth.subscriptionId))
              .execute()
              .catch((err) => logger.error({ err, userId: auth.userId }, "Credit update failed"));
          } else {
            recordSpend(auth.userId, costCents);
            db.update(subscriptions)
              .set({ ai_credits_used: sql`${subscriptions.ai_credits_used} + ${costCents}` })
              .where(eq(subscriptions.id, auth.subscriptionId))
              .execute()
              .catch((err) => logger.error({ err, userId: auth.userId }, "Credit update failed"));
          }
        }

        logger.info({
          userId: auth.userId,
          model: responseBody?.model || body.model,
          originalModel: modelOverridden ? originalModel : undefined,
          economyMode: modelOverridden,
          promptTokens: responseBody?.usage?.prompt_tokens,
          completionTokens: responseBody?.usage?.completion_tokens,
          costCents,
          plan: auth.plan,
          usagePercent: Math.round(usagePercent * 100),
        }, modelOverridden ? "AI request completed (economy mode)" : "AI request completed");

        return reply.status(orResponse.status).send(responseBody);
      }

      // --- Streaming ---
      reply.raw.writeHead(orResponse.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      const reader = orResponse.body?.getReader();
      if (!reader) {
        return reply.status(502).send({ error: { message: "No response body" } });
      }

      const decoder = new TextDecoder();
      let streamCostUpdated = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          reply.raw.write(chunk);

          // Look for usage data in stream (OpenRouter sends it in final chunk)
          if (!streamCostUpdated && chunk.includes('"usage"')) {
            try {
              const lines = chunk.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ") && line.includes('"usage"')) {
                  const data = JSON.parse(line.slice(6));
                  if (data.usage) {
                    let costCents = extractCostCents(data, orResponse.headers);
                    // Validate and cap if suspiciously high
                    if (!validateRequestCost(costCents)) {
                      costCents = parseInt(process.env.MAX_SINGLE_REQUEST_CENTS || "500", 10);
                    }
                    if (costCents > 0) {
                      recordSpend(auth.userId, costCents);
                      db.update(subscriptions)
                        .set({ ai_credits_used: sql`${subscriptions.ai_credits_used} + ${costCents}` })
                        .where(eq(subscriptions.id, auth.subscriptionId))
                        .execute()
                        .catch((err) => logger.error({ err }, "Stream credit update failed"));
                      streamCostUpdated = true;
                    }
                    logger.info({ userId: auth.userId, costCents, streaming: true }, "Streaming AI request completed");
                  }
                }
              }
            } catch { /* best effort */ }
          }
        }
      } finally {
        reader.releaseLock();
        // Safety net: if streaming finished without recording cost, charge minimum
        if (!streamCostUpdated) {
          const fallbackCost = 2; // 2 cents — conservative fallback
          recordSpend(auth.userId, fallbackCost);
          db.update(subscriptions)
            .set({ ai_credits_used: sql`${subscriptions.ai_credits_used} + ${fallbackCost}` })
            .where(eq(subscriptions.id, auth.subscriptionId))
            .execute()
            .catch((err) => logger.error({ err }, "Fallback stream credit update failed"));
          logger.warn({ userId: auth.userId, fallbackCost }, "Stream ended without usage data — charged fallback");
        }
        reply.raw.end();
      }

    } catch (err) {
      logger.error({ err, userId: auth.userId }, "AI proxy error");
      return reply.status(502).send({
        error: { message: "Failed to reach AI provider. Please try again.", type: "proxy_error" },
      });
    }
  });

  // ============================================================
  // GET /api/ai/v1/models — list available models from OpenRouter
  // ============================================================
  app.get("/api/ai/v1/models", async (request, reply) => {
    try {
      const response = await fetch(`${OPENROUTER_URL}/models`, {
        headers: { "Authorization": `Bearer ${OPENROUTER_KEY}` },
      });
      const body = await response.json();
      reply.send(body);
    } catch {
      reply.status(502).send({ error: "Failed to fetch models" });
    }
  });

  // ============================================================
  // GET /api/usage/:instanceId — credit balance
  // ============================================================
  app.get("/api/usage/:instanceId", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };

    const result = await db
      .select({
        plan: subscriptions.plan,
        creditsUsed: subscriptions.ai_credits_used,
        creditsLimit: subscriptions.ai_credits_limit,
        periodEnd: subscriptions.current_period_end,
      })
      .from(instances)
      .innerJoin(subscriptions, eq(subscriptions.user_id, instances.user_id))
      .where(eq(instances.id, instanceId))
      .limit(1);

    if (result.length === 0) {
      return reply.status(404).send({ error: "Instance not found" });
    }

    const row = result[0];
    const remaining = Math.max(0, row.creditsLimit - row.creditsUsed);

    reply.send({
      plan: row.plan,
      credits: {
        used_cents: row.creditsUsed,
        limit_cents: row.creditsLimit,
        remaining_cents: remaining,
        used_dollars: (row.creditsUsed / 100).toFixed(2),
        limit_dollars: (row.creditsLimit / 100).toFixed(2),
        remaining_dollars: (remaining / 100).toFixed(2),
        usage_percent: row.creditsLimit > 0 ? Math.round((row.creditsUsed / row.creditsLimit) * 100) : 0,
      },
      period_ends: row.periodEnd,
    });
  });

  logger.info("AI proxy routes registered (OpenRouter backend)");
}
