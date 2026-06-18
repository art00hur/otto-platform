import { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  instances,
  subscriptions,
  crmConnections,
  crmAuditLog,
  integrations,
} from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { PipedriveConnector, testConnection as testPipedrive } from "../connectors/pipedrive.js";
import type { CRMConnector } from "../connectors/types.js";
import { refreshTokenIfNeeded } from "../services/pipedrive-oauth.js";

// ============================================================
// Rate limiting config — stricter than global (20 req/min)
// NOTE: Rate limits are in-memory (Fastify plugin). They reset on
// process restart (deploy, pm2 restart). Acceptable at current scale
// (~1-5 active users). If scaling beyond ~50 users, migrate to
// Redis-backed rate limiting.
// ============================================================

const crmRateConfig = {
  config: {
    rateLimit: {
      max: 30,
      timeWindow: "1 minute",
    },
  },
};

const crmWriteRateConfig = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute",
    },
  },
};

// ============================================================
// Input validation helpers
// ============================================================

const VALID_PROVIDERS = ["pipedrive", "hubspot", "salesforce"] as const;
type CRMProvider = (typeof VALID_PROVIDERS)[number];

const VALID_ACTIONS = [
  "listDeals",
  "getDeal",
  "updateDeal",
  "searchContacts",
  "getContact",
  "createContact",
  "listOrganizations",
  "createActivity",
  "addNote",
  "listPipelines",
  "getRecentChanges",
] as const;
type CRMAction = (typeof VALID_ACTIONS)[number];

function isValidProvider(p: string): p is CRMProvider {
  return VALID_PROVIDERS.includes(p as CRMProvider);
}

function isValidAction(a: string): a is CRMAction {
  return VALID_ACTIONS.includes(a as CRMAction);
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Sanitize strings to prevent log injection
function sanitize(s: string, maxLen = 200): string {
  return s.replace(/[\r\n\t]/g, "").slice(0, maxLen);
}

// Validate baseUrl to prevent SSRF (IPv4 + IPv6)
function isValidBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow HTTPS
    if (parsed.protocol !== "https:") return false;
    // Block private/internal IPs and hostnames
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("172.") ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      host === "::1" ||
      host.startsWith("[fc") ||
      host.startsWith("[fd") ||
      host.startsWith("[fe80") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      host.endsWith(".localhost")
    ) return false;
    return true;
  } catch {
    return false;
  }
}

// Sanitize error messages before returning to client
function sanitizeError(msg: string): string {
  // Remove potential token/key leaks from error messages
  return msg
    .replace(/api_token=[^&\s]+/gi, "api_token=***")
    .replace(/token[=:]\s*[^\s&]+/gi, "token=***")
    .replace(/[Aa]uthorization[=:]\s*[Bb]earer\s+[^\s]+/g, "Authorization: Bearer ***")
    .replace(/[Aa]pi[-_]?[Kk]ey[=:]\s*[^\s&]+/g, "api_key=***")
    .replace(/x-agent-crm-key[=:]\s*[^\s&]+/gi, "x-agent-crm-key=***")
    .replace(/[0-9a-f]{32,}/gi, "[REDACTED_HEX]")
    .slice(0, 200);
}

// ============================================================
// Auth + Instance resolution helper
// ============================================================

async function resolveUserInstance(
  request: { headers: { authorization?: string }; params: unknown },
  reply: any
): Promise<{
  userId: string;
  instanceId: string;
  plan: string;
} | null> {
  const { userId } = request.params as { userId: string };

  if (!isValidUUID(userId)) {
    reply.status(400).send({ error: "Invalid user ID" });
    return null;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Unauthorized" });
    return null;
  }

  const jwt = verifyJWT(authHeader.slice(7));
  if (!jwt || jwt.userId !== userId) {
    reply.status(403).send({ error: "Forbidden" });
    return null;
  }

  // Find instance via subscription (multi-user safe)
  const rows = await db
    .select({ instanceId: instances.id, plan: subscriptions.plan })
    .from(subscriptions)
    .innerJoin(
      instances,
      and(eq(instances.id, subscriptions.instance_id), eq(instances.status, "active"))
    )
    .where(
      and(eq(subscriptions.user_id, userId), eq(subscriptions.status, "active"))
    )
    .limit(1);

  if (rows.length === 0) {
    reply.status(404).send({ error: "No active instance found" });
    return null;
  }

  return { userId, instanceId: rows[0].instanceId, plan: rows[0].plan };
}

// ============================================================
// Create connector from provider + decrypted token
// ============================================================

function createConnector(provider: CRMProvider, apiToken: string, authMode?: "api_token" | "oauth"): CRMConnector {
  switch (provider) {
    case "pipedrive":
      return new PipedriveConnector(apiToken, authMode);
    case "hubspot":
      throw new Error("HubSpot connector not yet implemented");
    case "salesforce":
      throw new Error("Salesforce connector not yet implemented");
    default:
      throw new Error(`Unknown CRM provider: ${provider}`);
  }
}

// ============================================================
// Audit logging helper
// ============================================================

async function logCRMAudit(params: {
  instanceId: string;
  userId: string;
  provider: CRMProvider;
  action: string;
  entityType?: string;
  entityId?: string;
  success: boolean;
  errorMessage?: string;
}): Promise<void> {
  try {
    await db.insert(crmAuditLog).values({
      instance_id: params.instanceId,
      user_id: params.userId,
      provider: params.provider,
      action: params.action,
      entity_type: params.entityType || null,
      entity_id: params.entityId || null,
      success: params.success,
      error_message: params.errorMessage || null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to write CRM audit log");
  }
}

// ============================================================
// CRM Routes
// ============================================================

export async function crmRoutes(app: FastifyInstance) {

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/crm/connect
  // Connect a CRM provider (validate token first, then encrypt & store)
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/crm/connect",
    crmWriteRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      if (ctx.plan === "free") {
        return reply.status(403).send({ error: "CRM integration requires a paid plan. Please upgrade." });
      }

      const { provider, apiToken, baseUrl } = request.body as {
        provider?: string;
        apiToken?: string;
        baseUrl?: string;
      };

      // Validate provider
      if (!provider || !isValidProvider(provider)) {
        return reply
          .status(400)
          .send({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}` });
      }

      // Validate token presence and format
      if (!apiToken || typeof apiToken !== "string" || apiToken.length < 10 || apiToken.length > 500) {
        return reply.status(400).send({ error: "Invalid API token" });
      }

      // Validate baseUrl if provided (SSRF prevention)
      if (baseUrl && !isValidBaseUrl(baseUrl)) {
        return reply.status(400).send({ error: "Invalid base URL. Must be HTTPS and a public domain." });
      }

      // Test the token before storing
      let testResult: { ok: boolean; error?: string };
      try {
        if (provider === "pipedrive") {
          testResult = await testPipedrive(apiToken);
        } else {
          return reply.status(400).send({ error: `${provider} not yet supported` });
        }
      } catch (err: any) {
        return reply.status(502).send({ error: `Failed to test CRM connection: ${err.message}` });
      }

      if (!testResult.ok) {
        await logCRMAudit({
          instanceId: ctx.instanceId,
          userId: ctx.userId,
          provider,
          action: "connect",
          success: false,
          errorMessage: testResult.error,
        });
        return reply.status(400).send({
          error: "CRM connection failed",
          detail: testResult.error,
        });
      }

      // Encrypt the token
      const encryptedToken = encrypt(apiToken);

      // Generate per-instance agent CRM key (for server-side agent access)
      const agentKey = randomBytes(32).toString("hex");
      const encryptedAgentKey = encrypt(agentKey);

      // Upsert connection (one per provider per instance)
      const existing = await db
        .select({ id: crmConnections.id })
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, ctx.instanceId),
            eq(crmConnections.provider, provider)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(crmConnections)
          .set({
            api_token_enc: encryptedToken,
            api_base_url: baseUrl || null,
            metadata: { agentKey: encryptedAgentKey },
            enabled: true,
            last_error: null,
            updated_at: new Date(),
          })
          .where(eq(crmConnections.id, existing[0].id));
      } else {
        await db.insert(crmConnections).values({
          instance_id: ctx.instanceId,
          provider,
          api_token_enc: encryptedToken,
          api_base_url: baseUrl || null,
          metadata: { agentKey: encryptedAgentKey },
          enabled: true,
        });
      }

      await logCRMAudit({
        instanceId: ctx.instanceId,
        userId: ctx.userId,
        provider,
        action: "connect",
        success: true,
      });

      logger.info(
        { instanceId: ctx.instanceId, provider },
        "CRM connected"
      );

      return { ok: true, provider };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/crm/test
  // Test existing CRM connection
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/crm/test",
    crmRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const { provider } = request.body as { provider?: string };

      if (!provider || !isValidProvider(provider)) {
        return reply.status(400).send({ error: "Invalid provider" });
      }

      const conn = await db
        .select()
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, ctx.instanceId),
            eq(crmConnections.provider, provider)
          )
        )
        .limit(1);

      if (conn.length === 0) {
        return reply.status(404).send({ error: "No CRM connection found for this provider" });
      }

      const connMeta0 = (conn[0].metadata || {}) as Record<string, unknown>;
      let testResult: { ok: boolean; error?: string };

      if (connMeta0.source === "oauth" && connMeta0.oauthUserId) {
        // OAuth-bridged: test by refreshing token (Bearer auth)
        try {
          const { accessToken } = await refreshTokenIfNeeded(connMeta0.oauthUserId as string);
          testResult = await testPipedrive(accessToken, "oauth");
        } catch (err: any) {
          testResult = { ok: false, error: `OAuth refresh failed: ${err.message}` };
        }
      } else {
        const apiToken = decrypt(conn[0].api_token_enc);
        if (provider === "pipedrive") {
          testResult = await testPipedrive(apiToken);
        } else {
          testResult = { ok: false, error: `${provider} not yet supported` };
        }
      }

      // Update last_error if test fails
      if (!testResult.ok) {
        await db
          .update(crmConnections)
          .set({ last_error: testResult.error, updated_at: new Date() })
          .where(eq(crmConnections.id, conn[0].id));
      } else {
        await db
          .update(crmConnections)
          .set({ last_error: null, updated_at: new Date() })
          .where(eq(crmConnections.id, conn[0].id));
      }

      return { ok: testResult.ok, error: testResult.error };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/crm/disconnect
  // Remove CRM connection (deletes encrypted token)
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/crm/disconnect",
    crmWriteRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const { provider } = request.body as { provider?: string };

      if (!provider || !isValidProvider(provider)) {
        return reply.status(400).send({ error: "Invalid provider" });
      }

      const deleted = await db
        .delete(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, ctx.instanceId),
            eq(crmConnections.provider, provider)
          )
        )
        .returning({ id: crmConnections.id });

      if (deleted.length === 0) {
        return reply.status(404).send({ error: "No CRM connection found" });
      }

      await logCRMAudit({
        instanceId: ctx.instanceId,
        userId: ctx.userId,
        provider,
        action: "disconnect",
        success: true,
      });

      logger.info({ instanceId: ctx.instanceId, provider }, "CRM disconnected");

      return { ok: true };
    }
  );

  // ──────────────────────────────────────────────────────────
  // GET /api/dashboard/:userId/crm/status
  // Get CRM connection status for all providers
  // ──────────────────────────────────────────────────────────
  app.get(
    "/dashboard/:userId/crm/status",
    crmRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const connections = await db
        .select({
          provider: crmConnections.provider,
          enabled: crmConnections.enabled,
          lastSyncAt: crmConnections.last_sync_at,
          lastError: crmConnections.last_error,
          createdAt: crmConnections.created_at,
          updatedAt: crmConnections.updated_at,
        })
        .from(crmConnections)
        .where(eq(crmConnections.instance_id, ctx.instanceId));

      // NEVER return the encrypted token
      return {
        connections: connections.map((c) => ({
          provider: c.provider,
          enabled: c.enabled,
          connected: true,
          lastSyncAt: c.lastSyncAt,
          lastError: c.lastError,
          connectedAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/crm/action
  // Execute a CRM action (proxy for agents and dashboard)
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/crm/action",
    crmRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const { action, params, provider: requestedProvider } = request.body as {
        action?: string;
        params?: Record<string, unknown>;
        provider?: string;
      };

      // Validate action
      if (!action || !isValidAction(action)) {
        return reply.status(400).send({
          error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}`,
        });
      }

      // Get the CRM connection: try crm_connections first, fallback to OAuth integrations
      let conn;
      if (requestedProvider && isValidProvider(requestedProvider)) {
        const rows = await db
          .select()
          .from(crmConnections)
          .where(
            and(
              eq(crmConnections.instance_id, ctx.instanceId),
              eq(crmConnections.provider, requestedProvider),
              eq(crmConnections.enabled, true)
            )
          )
          .limit(1);
        conn = rows[0] || null;
      } else {
        const rows = await db
          .select()
          .from(crmConnections)
          .where(
            and(
              eq(crmConnections.instance_id, ctx.instanceId),
              eq(crmConnections.enabled, true)
            )
          )
          .limit(1);
        conn = rows[0] || null;
      }

      let provider: CRMProvider;
      let connector: CRMConnector;

      if (conn) {
        provider = conn.provider as CRMProvider;
        const apiToken = decrypt(conn.api_token_enc);
        connector = createConnector(provider, apiToken);
      } else {
        // Fallback: OAuth integration
        const [oauthInteg] = await db
          .select()
          .from(integrations)
          .where(and(eq(integrations.user_id, ctx.userId), eq(integrations.provider, "pipedrive")))
          .limit(1);

        if (!oauthInteg) {
          return reply.status(404).send({ error: "No CRM connected" });
        }

        try {
          const { accessToken } = await refreshTokenIfNeeded(ctx.userId);
          provider = "pipedrive";
          connector = new PipedriveConnector(accessToken, "oauth");
        } catch (err: any) {
          logger.error({ userId: ctx.userId, err: err.message }, "OAuth token refresh failed");
          return reply.status(502).send({ error: "Pipedrive OAuth token expired. Reconnect from dashboard." });
        }
      }

      const entityType = getEntityType(action);
      const entityId = (params?.id as string) || undefined;

      try {
        const result = await executeCRMAction(connector, action, params || {}, reply);
        if (result === null) return; // reply already sent (validation error)

        // Update last_sync_at
        await db
          .update(crmConnections)
          .set({ last_sync_at: new Date(), last_error: null, updated_at: new Date() })
          .where(eq(crmConnections.id, conn.id));

        await logCRMAudit({
          instanceId: ctx.instanceId,
          userId: ctx.userId,
          provider,
          action,
          entityType,
          entityId,
          success: true,
        });

        return { ok: true, data: result };
      } catch (err: any) {
        const rawError = err.message || "Unknown CRM error";
        const safeError = sanitizeError(rawError);

        await db
          .update(crmConnections)
          .set({ last_error: rawError.slice(0, 500), updated_at: new Date() })
          .where(eq(crmConnections.id, conn.id));

        await logCRMAudit({
          instanceId: ctx.instanceId,
          userId: ctx.userId,
          provider,
          action,
          entityType,
          entityId,
          success: false,
          errorMessage: sanitizeError(rawError),
        });

        logger.error(
          { instanceId: ctx.instanceId, provider, action, err: safeError },
          "CRM action failed"
        );

        return reply.status(502).send({ error: "CRM action failed", detail: safeError });
      }
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/internal/crm/action
  // Internal route for AI agents on VPS — auth via instance key
  // Agents use sandbox (Python) to call this endpoint
  // ──────────────────────────────────────────────────────────
  app.post(
    "/internal/crm/action",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const instanceId = request.headers["x-instance-id"] as string;
      const agentCrmKey = request.headers["x-agent-crm-key"] as string;

      if (!instanceId || !isValidUUID(instanceId)) {
        return reply.status(400).send({ error: "Missing or invalid x-instance-id" });
      }
      if (!agentCrmKey || typeof agentCrmKey !== "string" || agentCrmKey.length < 32) {
        return reply.status(401).send({ error: "Missing or invalid x-agent-crm-key" });
      }

      // Verify the agent key matches the stored (encrypted) key for this instance
      const conns = await db
        .select()
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, instanceId),
            eq(crmConnections.enabled, true)
          )
        )
        .limit(1);

      if (conns.length === 0) {
        return reply.status(404).send({ error: "No CRM connected for this instance" });
      }

      const conn = conns[0];
      const connMeta = (conn.metadata || {}) as Record<string, unknown>;
      const storedEncKey = connMeta.agentKey as string | undefined;

      if (!storedEncKey) {
        return reply.status(403).send({ error: "Agent CRM key not configured. Reconnect CRM to generate one." });
      }

      // Decrypt and compare with timing-safe comparison to prevent timing attacks
      let decryptedKey: string;
      try {
        decryptedKey = decrypt(storedEncKey);
      } catch {
        return reply.status(500).send({ error: "Failed to validate agent key" });
      }

      const keyA = Buffer.from(decryptedKey, "utf8");
      const keyB = Buffer.from(agentCrmKey, "utf8");
      if (keyA.length !== keyB.length || !timingSafeEqual(keyA, keyB)) {
        return reply.status(403).send({ error: "Invalid agent CRM key" });
      }

      // Parse action & params (same as dashboard route)
      const { action, params } = request.body as {
        action?: string;
        params?: Record<string, unknown>;
      };

      if (!action || !isValidAction(action)) {
        return reply.status(400).send({
          error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}`,
        });
      }

      const provider = conn.provider as CRMProvider;
      const meta = (conn.metadata || {}) as Record<string, unknown>;
      let connector: CRMConnector;

      // If this connection was auto-bridged from OAuth, use refreshed token with Bearer auth
      if (meta.source === "oauth" && meta.oauthUserId) {
        try {
          const { accessToken } = await refreshTokenIfNeeded(meta.oauthUserId as string);
          connector = createConnector(provider, accessToken, "oauth");
        } catch (refreshErr: any) {
          return reply.status(502).send({ error: "OAuth token refresh failed. User should reconnect Pipedrive." });
        }
      } else {
        const apiToken = decrypt(conn.api_token_enc);
        connector = createConnector(provider, apiToken, "api_token");
      }

      let result: unknown;
      let entityType: string | undefined;
      let entityId: string | undefined;

      try {
        result = await executeCRMAction(connector, action, params || {}, reply);
        if (result === null) return; // reply already sent (validation error)

        entityType = getEntityType(action);
        entityId = (params?.id as string) || undefined;

        // Update last_sync_at
        await db
          .update(crmConnections)
          .set({ last_sync_at: new Date(), last_error: null, updated_at: new Date() })
          .where(eq(crmConnections.id, conn.id));

        // Audit log — use instanceId as userId since agents don't have user context
        await logCRMAudit({
          instanceId,
          userId: instanceId, // agent context, no user
          provider,
          action: `agent:${action}`,
          entityType,
          entityId,
          success: true,
        });

        return { ok: true, data: result };
      } catch (err: any) {
        const rawError = err.message || "Unknown CRM error";
        const safeError = sanitizeError(rawError);

        await db
          .update(crmConnections)
          .set({ last_error: rawError.slice(0, 500), updated_at: new Date() })
          .where(eq(crmConnections.id, conn.id));

        await logCRMAudit({
          instanceId,
          userId: instanceId,
          provider,
          action: `agent:${action}`,
          entityType,
          entityId,
          success: false,
          errorMessage: sanitizeError(rawError),
        });

        return reply.status(502).send({ error: "CRM action failed", detail: safeError });
      }
    }
  );

  // ──────────────────────────────────────────────────────────
  // GET /api/dashboard/:userId/crm/agent-config
  // Returns the agent CRM config (instanceId + agentKey) for TOOLS.md deployment
  // ──────────────────────────────────────────────────────────
  app.get(
    "/dashboard/:userId/crm/agent-config",
    crmRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const conn = await db
        .select()
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, ctx.instanceId),
            eq(crmConnections.enabled, true)
          )
        )
        .limit(1);

      if (conn.length === 0) {
        return reply.status(404).send({ error: "No CRM connected" });
      }

      const meta = (conn[0].metadata || {}) as Record<string, unknown>;
      const encKey = meta.agentKey as string | undefined;

      if (!encKey) {
        return reply.status(404).send({ error: "Agent key not generated. Reconnect CRM." });
      }

      const agentKey = decrypt(encKey);

      return {
        instanceId: ctx.instanceId,
        agentKey,
        provider: conn[0].provider,
        endpoint: "https://api.otto-ai.co/api/internal/crm/action",
      };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/internal/crm/sync/:instanceId
  // Periodic CRM sync — pulls pipeline data, detects stuck deals,
  // generates a digest. Called by OpenClaw cron or admin panel.
  // Auth: same agent CRM key
  // ──────────────────────────────────────────────────────────
  app.post(
    "/internal/crm/sync/:instanceId",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const instanceId = (request.params as { instanceId: string }).instanceId;
      const agentCrmKey = request.headers["x-agent-crm-key"] as string;

      if (!isValidUUID(instanceId)) {
        return reply.status(400).send({ error: "Invalid instance ID" });
      }
      if (!agentCrmKey || agentCrmKey.length < 32) {
        return reply.status(401).send({ error: "Missing agent CRM key" });
      }

      // Verify key
      const conns = await db
        .select()
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, instanceId),
            eq(crmConnections.enabled, true)
          )
        )
        .limit(1);

      if (conns.length === 0) {
        return reply.status(404).send({ error: "No CRM connected" });
      }

      const conn = conns[0];
      const meta = (conn.metadata || {}) as Record<string, unknown>;
      const storedEncKey = meta.agentKey as string | undefined;

      if (!storedEncKey) {
        return reply.status(403).send({ error: "No agent key" });
      }

      try {
        const decrypted = decrypt(storedEncKey);
        const kA = Buffer.from(decrypted, "utf8");
        const kB = Buffer.from(agentCrmKey, "utf8");
        if (kA.length !== kB.length || !timingSafeEqual(kA, kB)) {
          return reply.status(403).send({ error: "Invalid agent key" });
        }
      } catch {
        return reply.status(500).send({ error: "Key validation failed" });
      }

      // Pull CRM data
      const provider = conn.provider as CRMProvider;
      const syncMeta = (conn.metadata || {}) as Record<string, unknown>;
      let connector: CRMConnector;

      if (syncMeta.source === "oauth" && syncMeta.oauthUserId) {
        try {
          const { accessToken } = await refreshTokenIfNeeded(syncMeta.oauthUserId as string);
          connector = createConnector(provider, accessToken, "oauth");
        } catch (refreshErr: any) {
          return reply.status(502).send({ error: "OAuth token refresh failed" });
        }
      } else {
        const apiToken = decrypt(conn.api_token_enc);
        connector = createConnector(provider, apiToken, "api_token");
      }

      try {
        const [pipelines, deals] = await Promise.all([
          connector.listPipelines(),
          connector.listDeals({ limit: 200 }),
        ]);

        // Detect stuck deals (no update in 7+ days)
        const now = new Date();
        const stuckThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
        const stuckDeals = deals.filter((d) => {
          const updated = new Date(d.updatedAt);
          return now.getTime() - updated.getTime() > stuckThreshold;
        });

        // Calculate pipeline stats
        const totalValue = deals.reduce((sum, d) => sum + (d.amount || 0), 0);
        const stageMap: Record<string, { count: number; value: number }> = {};
        for (const d of deals) {
          const key = d.stageName || "Unknown";
          if (!stageMap[key]) stageMap[key] = { count: 0, value: 0 };
          stageMap[key].count++;
          stageMap[key].value += d.amount || 0;
        }

        // Get recent changes (last 2 hours)
        const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
        let recentChanges: any[] = [];
        try {
          recentChanges = await connector.getRecentChanges(twoHoursAgo, 50);
        } catch (err) {
          logger.warn({ err, provider }, "getRecentChanges not available for this CRM");
        }

        // Build digest
        const digest = {
          syncedAt: now.toISOString(),
          provider,
          pipeline: {
            totalDeals: deals.length,
            totalValue,
            stageBreakdown: stageMap,
          },
          stuckDeals: stuckDeals.map((d) => ({
            id: d.id,
            title: d.title,
            amount: d.amount,
            stageName: d.stageName,
            lastUpdate: d.updatedAt,
            daysSinceUpdate: Math.floor((now.getTime() - new Date(d.updatedAt).getTime()) / (24 * 60 * 60 * 1000)),
          })),
          recentChanges: recentChanges.length,
          alerts: [] as string[],
        };

        // Generate alerts
        if (stuckDeals.length > 0) {
          digest.alerts.push(`⚠️ ${stuckDeals.length} deal(s) sans activité depuis +7 jours`);
        }
        const highValueStuck = stuckDeals.filter((d) => d.amount > 5000);
        if (highValueStuck.length > 0) {
          digest.alerts.push(`🔴 ${highValueStuck.length} deal(s) à forte valeur bloqué(s)`);
        }

        // Update last_sync_at
        await db
          .update(crmConnections)
          .set({ last_sync_at: now, last_error: null, updated_at: now })
          .where(eq(crmConnections.id, conn.id));

        await logCRMAudit({
          instanceId,
          userId: instanceId,
          provider,
          action: "sync",
          success: true,
        });

        return { ok: true, digest };
      } catch (err: any) {
        const rawError = err.message || "Sync failed";

        await db
          .update(crmConnections)
          .set({ last_error: rawError.slice(0, 500), updated_at: new Date() })
          .where(eq(crmConnections.id, conn.id));

        await logCRMAudit({
          instanceId,
          userId: instanceId,
          provider,
          action: "sync",
          success: false,
          errorMessage: sanitizeError(rawError),
        });

        return reply.status(502).send({ error: "Sync failed", detail: sanitizeError(rawError) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────
  // CRM ANALYTICS ROUTES
  // ──────────────────────────────────────────────────────────

  const {
    getInactiveDeals,
    getRevenueByClient,
    getPipelineHealth,
    getUpcomingCloses,
    getChurnRisk,
    isAnalyticsError,
  } = await import("../services/crm-analytics.js");

  /**
   * Helper: resolve connector for analytics and CRM routes.
   * Checks crm_connections (API token) first, then falls back to
   * integrations (OAuth) so Pipedrive connected via OAuth automatically
   * works for agents, analytics, and brief matinal.
   */
  async function resolveConnector(
    request: any,
    reply: any
  ): Promise<{ connector: CRMConnector; ctx: { userId: string; instanceId: string }; provider: CRMProvider } | null> {
    const ctx = await resolveUserInstance(request, reply);
    if (!ctx) return null;

    // 1. Try crm_connections (API token flow)
    const conn = await db
      .select()
      .from(crmConnections)
      .where(
        and(
          eq(crmConnections.instance_id, ctx.instanceId),
          eq(crmConnections.enabled, true)
        )
      )
      .limit(1);

    if (conn.length > 0) {
      const provider = conn[0].provider as CRMProvider;
      const apiToken = decrypt(conn[0].api_token_enc);
      const connector = createConnector(provider, apiToken);
      return { connector, ctx, provider };
    }

    // 2. Fallback: check OAuth integrations (e.g. Pipedrive OAuth)
    const [oauthInteg] = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.user_id, ctx.userId),
          eq(integrations.provider, "pipedrive")
        )
      )
      .limit(1);

    if (oauthInteg) {
      try {
        const { accessToken } = await refreshTokenIfNeeded(ctx.userId);
        const connector = new PipedriveConnector(accessToken);
        return { connector, ctx, provider: "pipedrive" };
      } catch (err: any) {
        logger.error({ userId: ctx.userId, err: err.message }, "OAuth token refresh failed for CRM");
        reply.status(502).send({ error: "Pipedrive OAuth token expired or invalid. Reconnect from dashboard." });
        return null;
      }
    }

    reply.status(404).send({ error: "No CRM connected" });
    return null;
  }

  // GET /api/dashboard/:userId/crm/analytics/inactive-deals
  app.get(
    "/dashboard/:userId/crm/analytics/inactive-deals",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const query = request.query as { days?: string; limit?: string };
      const days = Math.max(1, Math.min(365, parseInt(query.days || "14", 10) || 14));
      const topN = Math.max(1, Math.min(100, parseInt(query.limit || "20", 10) || 20));

      const result = await getInactiveDeals(resolved.connector, days, topN);

      await logCRMAudit({
        instanceId: resolved.ctx.instanceId,
        userId: resolved.ctx.userId,
        provider: resolved.provider,
        action: "analytics:inactive-deals",
        success: !isAnalyticsError(result),
        errorMessage: isAnalyticsError(result) ? result.error : undefined,
      });

      return result;
    }
  );

  // GET /api/dashboard/:userId/crm/analytics/pipeline-health
  app.get(
    "/dashboard/:userId/crm/analytics/pipeline-health",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const query = request.query as { stuckDays?: string };
      const stuckDays = Math.max(1, Math.min(365, parseInt(query.stuckDays || "14", 10) || 14));

      const result = await getPipelineHealth(resolved.connector, stuckDays);

      await logCRMAudit({
        instanceId: resolved.ctx.instanceId,
        userId: resolved.ctx.userId,
        provider: resolved.provider,
        action: "analytics:pipeline-health",
        success: !isAnalyticsError(result),
        errorMessage: isAnalyticsError(result) ? result.error : undefined,
      });

      return result;
    }
  );

  // GET /api/dashboard/:userId/crm/analytics/upcoming-closes
  app.get(
    "/dashboard/:userId/crm/analytics/upcoming-closes",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const query = request.query as { days?: string; limit?: string };
      const days = Math.max(1, Math.min(90, parseInt(query.days || "7", 10) || 7));
      const topN = Math.max(1, Math.min(100, parseInt(query.limit || "20", 10) || 20));

      const result = await getUpcomingCloses(resolved.connector, days, topN);

      await logCRMAudit({
        instanceId: resolved.ctx.instanceId,
        userId: resolved.ctx.userId,
        provider: resolved.provider,
        action: "analytics:upcoming-closes",
        success: !isAnalyticsError(result),
        errorMessage: isAnalyticsError(result) ? result.error : undefined,
      });

      return result;
    }
  );

  // GET /api/dashboard/:userId/crm/analytics/revenue-by-client
  app.get(
    "/dashboard/:userId/crm/analytics/revenue-by-client",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const query = request.query as { periodDays?: string; limit?: string };
      const periodDays = Math.max(7, Math.min(365, parseInt(query.periodDays || "30", 10) || 30));
      const topN = Math.max(1, Math.min(100, parseInt(query.limit || "20", 10) || 20));

      const result = await getRevenueByClient(resolved.connector, periodDays, topN);

      await logCRMAudit({
        instanceId: resolved.ctx.instanceId,
        userId: resolved.ctx.userId,
        provider: resolved.provider,
        action: "analytics:revenue-by-client",
        success: !isAnalyticsError(result),
        errorMessage: isAnalyticsError(result) ? result.error : undefined,
      });

      return result;
    }
  );

  // GET /api/dashboard/:userId/crm/analytics/churn-risk
  app.get(
    "/dashboard/:userId/crm/analytics/churn-risk",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const query = request.query as { limit?: string };
      const topN = Math.max(1, Math.min(100, parseInt(query.limit || "20", 10) || 20));

      const result = await getChurnRisk(resolved.connector, topN);

      await logCRMAudit({
        instanceId: resolved.ctx.instanceId,
        userId: resolved.ctx.userId,
        provider: resolved.provider,
        action: "analytics:churn-risk",
        success: !isAnalyticsError(result),
        errorMessage: isAnalyticsError(result) ? result.error : undefined,
      });

      return result;
    }
  );

  // GET /api/dashboard/:userId/crm/analytics/health-score
  app.get(
    "/dashboard/:userId/crm/analytics/health-score",
    crmRateConfig,
    async (request, reply) => {
      const resolved = await resolveConnector(request, reply);
      if (!resolved) return;

      const result = await getPipelineHealth(resolved.connector);

      if (isAnalyticsError(result)) {
        return { score: "red", reason: result.error };
      }

      return {
        score: result.healthScore,
        inactivePercent: result.inactivePercent,
        totalDeals: result.totalDeals,
      };
    }
  );

  // POST /api/dashboard/:userId/crm/token-check
  app.post(
    "/dashboard/:userId/crm/token-check",
    crmRateConfig,
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const conn = await db
        .select()
        .from(crmConnections)
        .where(
          and(
            eq(crmConnections.instance_id, ctx.instanceId),
            eq(crmConnections.enabled, true)
          )
        )
        .limit(1);

      if (conn.length === 0) {
        return { valid: false, reason: "No CRM connected" };
      }

      const provider = conn[0].provider as CRMProvider;
      const tokenCheckMeta = (conn[0].metadata || {}) as Record<string, unknown>;

      // Test the token (OAuth-bridged uses refreshed token)
      let testResult: { ok: boolean; error?: string };
      if (tokenCheckMeta.source === "oauth" && tokenCheckMeta.oauthUserId) {
        try {
          const { accessToken } = await refreshTokenIfNeeded(tokenCheckMeta.oauthUserId as string);
          testResult = await testPipedrive(accessToken, "oauth");
        } catch (err: any) {
          testResult = { ok: false, error: `OAuth refresh failed: ${err.message}` };
        }
      } else {
        const apiToken = decrypt(conn[0].api_token_enc);
        testResult = await testPipedrive(apiToken);
      }

      if (!testResult.ok) {
        await db
          .update(crmConnections)
          .set({ last_error: testResult.error || "Token invalid", updated_at: new Date() })
          .where(eq(crmConnections.id, conn[0].id));

        await logCRMAudit({
          instanceId: ctx.instanceId,
          userId: ctx.userId,
          provider,
          action: "token-check",
          success: false,
          errorMessage: testResult.error,
        });

        return { valid: false, reason: testResult.error };
      }

      await db
        .update(crmConnections)
        .set({ last_error: null, updated_at: new Date() })
        .where(eq(crmConnections.id, conn[0].id));

      await logCRMAudit({
        instanceId: ctx.instanceId,
        userId: ctx.userId,
        provider,
        action: "token-check",
        success: true,
      });

      return { valid: true, provider };
    }
  );
}

// ============================================================
// Shared CRM action executor (used by dashboard & agent routes)
// ============================================================

function getEntityType(action: string): string | undefined {
  const map: Record<string, string> = {
    listDeals: "deal", getDeal: "deal", updateDeal: "deal",
    searchContacts: "contact", getContact: "contact", createContact: "contact",
    listOrganizations: "organization",
    createActivity: "activity",
    addNote: "note",
    listPipelines: "pipeline",
  };
  return map[action];
}

// ============================================================
// Zod schemas for CRM write operations
// ============================================================

const updateDealSchema = z.object({
  id: z.string().min(1),
  data: z.object({
    title: z.string().min(1).max(255).optional(),
    amount: z.number().positive().optional(),
    stageId: z.string().min(1).optional(),
    ownerId: z.string().min(1).optional(),
    closeDate: z.string().optional(),
    description: z.string().max(10000).optional(),
  }).refine(obj => Object.keys(obj).length > 0, { message: "At least one field required" }),
});

const createContactSchema = z.object({
  firstName: z.string().min(1).max(255),
  lastName: z.string().min(1).max(255),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  title: z.string().max(255).optional(),
  organizationId: z.string().optional(),
  address: z.string().max(500).optional(),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  postalCode: z.string().max(20).optional(),
  description: z.string().max(10000).optional(),
});

const createActivitySchema = z.object({
  type: z.enum(["call", "email", "meeting", "task", "note", "other"]),
  subject: z.string().min(1).max(255),
  activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Must be YYYY-MM-DD format"),
  body: z.string().max(10000).optional(),
  ownerId: z.string().optional(),
  duration: z.number().int().positive().optional(),
  contactIds: z.array(z.string()).optional(),
  dealIds: z.array(z.string()).optional(),
  organizationIds: z.array(z.string()).optional(),
});

const addNoteSchema = z.object({
  body: z.string().min(1).max(50000),
  dealId: z.string().optional(),
  contactId: z.string().optional(),
  organizationId: z.string().optional(),
});

async function executeCRMAction(
  connector: CRMConnector,
  action: string,
  params: Record<string, unknown>,
  reply: any
): Promise<unknown> {
  switch (action) {
    case "listDeals":
      return connector.listDeals(params as any);

    case "getDeal":
      if (!params?.id || typeof params.id !== "string") {
        reply.status(400).send({ error: "Missing params.id" });
        return null;
      }
      return connector.getDeal(sanitize(params.id as string));

    case "updateDeal": {
      const parsed = updateDealSchema.safeParse(params);
      if (!parsed.success) {
        reply.status(400).send({ error: "Invalid updateDeal params", details: parsed.error.issues });
        return null;
      }
      return connector.updateDeal(sanitize(parsed.data.id), parsed.data.data);
    }

    case "searchContacts":
      if (!params?.query || typeof params.query !== "string") {
        reply.status(400).send({ error: "Missing params.query" });
        return null;
      }
      return connector.searchContacts(
        sanitize(params.query as string),
        Math.min(Math.max(1, Number(params.limit) || 20), 100)
      );

    case "getContact":
      if (!params?.id || typeof params.id !== "string") {
        reply.status(400).send({ error: "Missing params.id" });
        return null;
      }
      return connector.getContact(sanitize(params.id as string));

    case "createContact": {
      const parsed = createContactSchema.safeParse(params);
      if (!parsed.success) {
        reply.status(400).send({ error: "Invalid createContact params", details: parsed.error.issues });
        return null;
      }
      return connector.createContact(parsed.data);
    }

    case "listOrganizations":
      return connector.listOrganizations(params as any);

    case "createActivity": {
      const parsed = createActivitySchema.safeParse(params);
      if (!parsed.success) {
        reply.status(400).send({ error: "Invalid createActivity params", details: parsed.error.issues });
        return null;
      }
      return connector.createActivity(parsed.data);
    }

    case "addNote": {
      const parsed = addNoteSchema.safeParse(params);
      if (!parsed.success) {
        reply.status(400).send({ error: "Invalid addNote params", details: parsed.error.issues });
        return null;
      }
      return connector.addNote(parsed.data.body, {
        dealId: parsed.data.dealId,
        contactId: parsed.data.contactId,
        organizationId: parsed.data.organizationId,
      });
    }

    case "listPipelines":
      return connector.listPipelines();

    case "getRecentChanges":
      if (!params?.since || typeof params.since !== "string") {
        reply.status(400).send({ error: "Missing params.since (ISO 8601 timestamp)" });
        return null;
      }
      return connector.getRecentChanges(
        params.since as string,
        Math.min(Math.max(1, Number(params.limit) || 100), 500)
      );

    default:
      reply.status(400).send({ error: "Unknown action" });
      return null;
  }
}
