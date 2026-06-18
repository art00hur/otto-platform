import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { NodeSSH } from "node-ssh";
import { db } from "../db/index.js";
import { integrations, crmConnections, instances, subscriptions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/encryption.js";
import { resolveSSHKey } from "../services/ssh.js";
import { createJWT, verifyJWT } from "./auth.js";
import { exchangeCodeForTokens, refreshTokenIfNeeded, revokeToken, registerWebhooks } from "../services/pipedrive-oauth.js";
import { logger } from "../utils/logger.js";

/**
 * Validate that a Pipedrive API domain is legitimate.
 * Pipedrive domains follow the pattern: <company>.pipedrive.com or api.pipedrive.com
 */
function isValidPipedriveDomain(domain: string): boolean {
  const normalized = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  // Must end with .pipedrive.com
  if (!normalized.endsWith(".pipedrive.com")) return false;
  // Must not contain path traversal or weird characters
  if (!/^[a-zA-Z0-9-]+\.pipedrive\.com$/.test(normalized)) return false;
  return true;
}

export async function pipedriveRoutes(app: FastifyInstance) {

  /**
   * GET /api/integrations/pipedrive/connect
   * Generates Pipedrive OAuth authorize URL.
   */
  app.get("/integrations/pipedrive/connect", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    // Block free users from CRM
    const [sub] = await db
      .select({ plan: subscriptions.plan })
      .from(subscriptions)
      .where(and(eq(subscriptions.user_id, decoded.userId), eq(subscriptions.status, "active")))
      .limit(1);
    if (!sub || sub.plan === "free") {
      return reply.code(403).send({ error: "CRM integration requires a paid plan. Please upgrade." });
    }

    const clientId = process.env.PIPEDRIVE_CLIENT_ID;
    const redirectUri = process.env.PIPEDRIVE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return reply.code(500).send({ error: "Pipedrive OAuth not configured" });
    }

    // State token: JWT with userId + timestamp, expires in 10 min
    const state = createJWT({ userId: decoded.userId, purpose: "pipedrive_oauth" }, 1 / 6);

    const url = new URL("https://oauth.pipedrive.com/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    return { url: url.toString() };
  });

  /**
   * GET /api/integrations/pipedrive/callback
   * OAuth callback — NO JWT auth (user comes from Pipedrive redirect).
   */
  app.get("/integrations/pipedrive/callback", async (request, reply) => {
    const { code, state } = request.query as { code?: string; state?: string };

    if (!code || !state) {
      return reply.code(400).send({ error: "Missing code or state" });
    }

    // Validate state token
    const decoded = verifyJWT(state);
    if (!decoded || decoded.purpose !== "pipedrive_oauth") {
      return reply.code(403).send({ error: "Invalid or expired state token" });
    }

    const userId = decoded.userId;
    const redirectUri = process.env.PIPEDRIVE_REDIRECT_URI;
    if (!redirectUri) {
      return reply.code(500).send({ error: "Pipedrive redirect URI not configured" });
    }

    try {
      const tokens = await exchangeCodeForTokens(code, redirectUri);
      const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

      // Upsert integration
      const [existing] = await db
        .select({ id: integrations.id })
        .from(integrations)
        .where(and(eq(integrations.user_id, userId), eq(integrations.provider, "pipedrive")))
        .limit(1);

      if (existing) {
        await db
          .update(integrations)
          .set({
            access_token_enc: encrypt(tokens.accessToken),
            refresh_token_enc: encrypt(tokens.refreshToken),
            token_expires_at: expiresAt,
            provider_data: { api_domain: tokens.apiDomain },
            updated_at: new Date(),
          })
          .where(eq(integrations.id, existing.id));
      } else {
        await db.insert(integrations).values({
          user_id: userId,
          provider: "pipedrive",
          access_token_enc: encrypt(tokens.accessToken),
          refresh_token_enc: encrypt(tokens.refreshToken),
          token_expires_at: expiresAt,
          provider_data: { api_domain: tokens.apiDomain },
        });
      }

      logger.info({ userId, domain: tokens.apiDomain }, "Pipedrive OAuth connected");

      // Auto-bridge: create a crm_connections entry so agents can access CRM
      // via the existing x-agent-crm-key mechanism without separate API token setup.
      try {
        const [sub] = await db
          .select({ instance_id: subscriptions.instance_id })
          .from(subscriptions)
          .where(and(eq(subscriptions.user_id, userId), eq(subscriptions.status, "active")))
          .limit(1);

        if (sub?.instance_id) {
          const agentKey = randomBytes(32).toString("hex");
          const encAgentKey = encrypt(agentKey);
          // Store placeholder — actual token comes from OAuth refresh via refreshTokenIfNeeded
          const encToken = encrypt("[oauth]");

          const [existingConn] = await db
            .select({ id: crmConnections.id })
            .from(crmConnections)
            .where(and(
              eq(crmConnections.instance_id, sub.instance_id),
              eq(crmConnections.provider, "pipedrive")
            ))
            .limit(1);

          if (existingConn) {
            await db.update(crmConnections).set({
              api_token_enc: encToken,
              metadata: { agentKey: encAgentKey, source: "oauth", oauthUserId: userId },
              enabled: true,
              last_error: null,
              updated_at: new Date(),
            }).where(eq(crmConnections.id, existingConn.id));
          } else {
            await db.insert(crmConnections).values({
              instance_id: sub.instance_id,
              provider: "pipedrive",
              api_token_enc: encToken,
              metadata: { agentKey: encAgentKey, source: "oauth", oauthUserId: userId },
              enabled: true,
            });
          }

          logger.info({ userId, instanceId: sub.instance_id }, "CRM auto-bridged from OAuth");

          // Deploy TOOLS.md + update MCP server config with real agent key
          deployCRMToolsToAgents(sub.instance_id, agentKey).catch((deployErr) => {
            logger.warn({ instanceId: sub.instance_id, err: deployErr.message }, "CRM TOOLS.md deploy failed (non-blocking)");
          });
          updateMCPConfig(sub.instance_id, agentKey).catch((mcpErr) => {
            logger.warn({ instanceId: sub.instance_id, err: mcpErr.message }, "MCP config update failed (non-blocking)");
          });
        }
      } catch (bridgeErr: any) {
        logger.warn({ userId, err: bridgeErr.message }, "CRM auto-bridge failed (non-blocking)");
      }

      // Register webhooks (best-effort, don't block on failure)
      const webhookUrl = `${process.env.API_URL || "https://api.otto-ai.co"}/api/integrations/pipedrive/webhook`;
      registerWebhooks(tokens.accessToken, tokens.apiDomain, webhookUrl).catch((err) => {
        logger.warn({ userId, err }, "Webhook registration failed (non-blocking)");
      });

      // Redirect to dashboard with success
      const dashboardUrl = `${process.env.API_URL || "https://app.otto-ai.co"}/dashboard?integration=pipedrive&status=connected`;
      return reply.redirect(dashboardUrl);
    } catch (err: any) {
      logger.error({ userId, error: err.message }, "Pipedrive OAuth callback failed");
      const dashboardUrl = `${process.env.API_URL || "https://app.otto-ai.co"}/dashboard?integration=pipedrive&status=error`;
      return reply.redirect(dashboardUrl);
    }
  });

  /**
   * GET /api/integrations/pipedrive/status
   * Check connection status.
   */
  app.get("/integrations/pipedrive/status", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    const [integration] = await db
      .select({
        id: integrations.id,
        token_expires_at: integrations.token_expires_at,
        provider_data: integrations.provider_data,
        updated_at: integrations.updated_at,
      })
      .from(integrations)
      .where(and(eq(integrations.user_id, decoded.userId), eq(integrations.provider, "pipedrive")))
      .limit(1);

    if (!integration) {
      return { connected: false };
    }

    const providerData = integration.provider_data as any || {};
    return {
      connected: true,
      expires_at: integration.token_expires_at,
      company_domain: providerData.api_domain,
      updated_at: integration.updated_at,
    };
  });

  /**
   * DELETE /api/integrations/pipedrive/disconnect
   * Remove the integration.
   */
  app.delete("/integrations/pipedrive/disconnect", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    // Revoke the OAuth token at Pipedrive (best-effort, don't block on failure)
    await revokeToken(decoded.userId);

    await db
      .delete(integrations)
      .where(and(eq(integrations.user_id, decoded.userId), eq(integrations.provider, "pipedrive")));

    // Clean up auto-bridged crm_connections (source: "oauth")
    try {
      const allConns = await db.select({ id: crmConnections.id, metadata: crmConnections.metadata })
        .from(crmConnections)
        .where(eq(crmConnections.provider, "pipedrive"));
      for (const c of allConns) {
        const m = (c.metadata || {}) as Record<string, unknown>;
        if (m.source === "oauth" && m.oauthUserId === decoded.userId) {
          await db.delete(crmConnections).where(eq(crmConnections.id, c.id));
        }
      }
    } catch (cleanupErr: any) {
      logger.warn({ userId: decoded.userId, err: cleanupErr.message }, "CRM bridge cleanup failed");
    }

    logger.info({ userId: decoded.userId }, "Pipedrive OAuth disconnected (token revoked, bridge cleaned)");
    return { ok: true };
  });

  /**
   * GET /api/integrations/pipedrive/proxy/*
   * Read-only proxy to Pipedrive API.
   */
  app.get("/integrations/pipedrive/proxy/*", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded) return reply.code(401).send({ error: "Invalid token" });

    // Extract the endpoint path after /proxy/
    const fullPath = (request.params as any)["*"];
    if (!fullPath) {
      return reply.code(400).send({ error: "Missing endpoint path" });
    }

    // Validate path: only alphanumeric, slashes, hyphens, underscores
    if (!/^[a-zA-Z0-9/_-]+$/.test(fullPath)) {
      return reply.code(400).send({ error: "Invalid endpoint path" });
    }

    try {
      const { accessToken, domain } = await refreshTokenIfNeeded(decoded.userId);

      // Validate domain to prevent SSRF via compromised DB data
      if (!isValidPipedriveDomain(domain)) {
        logger.error({ userId: decoded.userId, domain }, "Invalid Pipedrive domain detected");
        return reply.code(500).send({ error: "Invalid Pipedrive domain configuration" });
      }

      // Determine API version: v2 for main entities, v1 for others
      const v2Endpoints = ["deals", "persons", "organizations", "activities"];
      const firstSegment = fullPath.split("/")[0];
      const version = v2Endpoints.includes(firstSegment) ? "v2" : "v1";

      const base = domain.startsWith("http") ? domain : `https://${domain}`;
      const url = new URL(`/api/${version}/${fullPath}`, base);

      // Forward safe query params (exclude auth-related ones)
      const query = request.query as Record<string, string>;
      const blockedParams = new Set(["api_token", "access_token", "authorization"]);
      for (const [k, v] of Object.entries(query)) {
        if (!blockedParams.has(k.toLowerCase())) {
          url.searchParams.set(k, v);
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const body = await res.json();
      return reply.status(res.status).send(body);
    } catch (err: any) {
      logger.error({ userId: decoded.userId, endpoint: fullPath, error: err.message }, "Pipedrive proxy error");
      return reply.code(502).send({ error: "Failed to reach Pipedrive API" });
    }
  });

  // Block non-GET methods on proxy
  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/integrations/pipedrive/proxy/*",
    handler: async (_request, reply) => {
      return reply.code(403).send({ error: "Read-only: only GET requests are allowed" });
    },
  });

  /**
   * POST /api/integrations/pipedrive/webhook
   * Receive Pipedrive webhook events. Stores events for agent polling.
   * Auth: Pipedrive sends events to registered callback URLs.
   * We verify the event has a valid structure but don't require auth
   * (Pipedrive doesn't sign webhooks with HMAC, only Basic Auth which
   * we don't use yet). Rate limited to prevent abuse.
   */
  app.post(
    "/integrations/pipedrive/webhook",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = request.body as {
        v?: number;
        current?: Record<string, unknown>;
        previous?: Record<string, unknown>;
        event?: string;
        retry?: number;
        meta?: { action?: string; object?: string; id?: number; [key: string]: unknown };
      };

      // Basic structure validation
      if (!body || !body.meta || !body.meta.action || !body.meta.object) {
        return reply.code(400).send({ error: "Invalid webhook payload" });
      }

      const eventType = `${body.meta.action}.${body.meta.object}`;
      const entityId = body.meta.id ? String(body.meta.id) : undefined;

      logger.info(
        { event: eventType, entityId, retry: body.retry },
        "Pipedrive webhook received"
      );

      // Webhook events are logged (structured JSON) for audit trail.
      // Agents use getRecentChanges polling, not webhook data directly.
      // TODO: When pipedrive_events table exists (Phase 2), store here for agent polling.

      return { ok: true, event: eventType };
    }
  );

  logger.info("Pipedrive OAuth routes registered");
}

/**
 * Deploy TOOLS.md with CRM instructions to all agents on the VPS.
 * Appends CRM section to existing TOOLS.md (preserves other content).
 */
async function deployCRMToolsToAgents(instanceId: string, agentKey: string): Promise<void> {
  const [inst] = await db
    .select({ ip_address: instances.ip_address, ssh_private_key_enc: instances.ssh_private_key_enc })
    .from(instances)
    .where(eq(instances.id, instanceId));

  if (!inst) throw new Error("Instance not found");

  const privateKey = resolveSSHKey(inst.ssh_private_key_enc);

  const backendUrl = process.env.API_URL || "https://api.otto-ai.co";

  const crmSection = `

## CRM Pipedrive — Accès API

Tu peux interroger et modifier le CRM Pipedrive via l'API interne Otto.

### Endpoint
\`POST ${backendUrl}/api/internal/crm/action\`

### Headers requis
\`\`\`
x-instance-id: ${instanceId}
x-agent-crm-key: ${agentKey}
Content-Type: application/json
\`\`\`

### Actions disponibles

| Action | Description | Params requis |
|--------|-------------|---------------|
| listDeals | Lister les deals | limit?, offset?, stageId?, pipelineId? |
| getDeal | Détail d'un deal | id |
| updateDeal | Modifier un deal | id, data: {title?, amount?, stageId?} |
| searchContacts | Chercher des contacts | query, limit? |
| getContact | Détail d'un contact | id |
| createContact | Créer un contact | firstName, lastName, email?, phone? |
| listOrganizations | Lister les organisations | limit?, offset? |
| createActivity | Créer une activité | type, subject, activityDate |
| addNote | Ajouter une note | body, dealId? ou contactId? |
| listPipelines | Lister les pipelines | — |
| getRecentChanges | Changements récents | since (ISO 8601) |

### Exemple (curl)
\`\`\`bash
curl -X POST ${backendUrl}/api/internal/crm/action \\
  -H "x-instance-id: ${instanceId}" \\
  -H "x-agent-crm-key: ${agentKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"action": "listDeals", "params": {"limit": 10}}'
\`\`\`

### Règles
- Utilise ces outils pour répondre aux questions sur les clients, deals, pipeline
- Pour le brief matinal : utilise listDeals + listPipelines pour la santé du pipeline
- Ne jamais exposer l'agent-crm-key à l'utilisateur
- Les réponses sont au format JSON dans \`data\`
`;

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: inst.ip_address, username: "root", privateKey, readyTimeout: 15_000 });

    // List agents
    const agentList = await ssh.execCommand("ls /home/openclaw/.openclaw/agents/ 2>/dev/null");
    const agents = agentList.stdout.trim().split("\n").filter(a => a && a !== "main");

    const marker = "## CRM Pipedrive";

    for (const agent of agents) {
      const toolsPath = `/home/openclaw/.openclaw/agents/${agent}/workspace/TOOLS.md`;

      // Read existing TOOLS.md
      const existing = await ssh.execCommand(`cat ${toolsPath} 2>/dev/null`);
      let content = existing.stdout || "";

      // Remove old CRM section if present, then append new one
      if (content.includes(marker)) {
        const idx = content.indexOf(marker);
        content = content.substring(0, idx).trimEnd();
      }

      content = content + "\n" + crmSection;

      // Write via base64 encoding to avoid shell escaping issues with apostrophes/backticks
      const b64 = Buffer.from(content, "utf8").toString("base64").replace(/\n/g, "");
      await ssh.execCommand(`printf "%s" "${b64}" | base64 -d > /tmp/tools_${agent}.md && sudo -u openclaw cp /tmp/tools_${agent}.md ${toolsPath} && rm -f /tmp/tools_${agent}.md`);
    }

    logger.info({ instanceId, agentCount: agents.length }, "CRM TOOLS.md deployed to all agents");
  } finally {
    ssh.dispose();
  }
}

/**
 * Update the MCP CRM server config on the VPS with the real agent key.
 * Called after OAuth bridge creates the crm_connections entry.
 */
async function updateMCPConfig(instanceId: string, agentKey: string): Promise<void> {
  const [inst] = await db
    .select({ ip_address: instances.ip_address, ssh_private_key_enc: instances.ssh_private_key_enc })
    .from(instances)
    .where(eq(instances.id, instanceId));

  if (!inst) throw new Error("Instance not found");

  const privateKey = resolveSSHKey(inst.ssh_private_key_enc);
  const backendUrl = process.env.API_URL || "https://api.otto-ai.co";

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: inst.ip_address, username: "root", privateKey, readyTimeout: 15_000 });

    // Update MCP config with real agent key via CLI (base64 to avoid shell escaping)
    const mcpConfig = JSON.stringify({
      command: "node",
      args: ["/home/openclaw/.openclaw/mcp-crm-server.mjs"],
      env: {
        OTTO_BACKEND_URL: backendUrl,
        OTTO_INSTANCE_ID: instanceId,
        OTTO_AGENT_KEY: agentKey,
      },
    });

    const b64Config = Buffer.from(mcpConfig).toString("base64");
    await ssh.execCommand(`cd /tmp && sudo -u openclaw openclaw mcp set otto-crm "$(echo '${b64Config}' | base64 -d)" 2>&1`);

    logger.info({ instanceId }, "MCP CRM config updated with agent key");
  } finally {
    ssh.dispose();
  }
}
