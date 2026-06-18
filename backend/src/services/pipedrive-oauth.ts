import { db } from "../db/index.js";
import { integrations } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/encryption.js";
import { logger } from "../utils/logger.js";

const TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";
const API_BASE = "https://api.pipedrive.com";
const TOKEN_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const MAX_RETRIES = 3;

// Per-user refresh lock to prevent concurrent token refresh race conditions.
// If two requests arrive while the token is expired, only one performs the refresh.
const refreshLocks = new Map<string, Promise<{ accessToken: string; domain: string }>>();

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PIPEDRIVE_CLIENT_ID;
  const clientSecret = process.env.PIPEDRIVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PIPEDRIVE_CLIENT_ID and PIPEDRIVE_CLIENT_SECRET are required");
  }
  return { clientId, clientSecret };
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  apiDomain: string;
}> {
  const { clientId, clientSecret } = getClientCredentials();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "Pipedrive token exchange failed");
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  const data = await res.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    apiDomain: data.api_domain || "api.pipedrive.com",
  };
}

/**
 * Refresh tokens if needed. Returns a valid access token.
 * Uses a per-user lock to prevent concurrent refresh race conditions.
 */
export async function refreshTokenIfNeeded(userId: string): Promise<{ accessToken: string; domain: string }> {
  // If a refresh is already in progress for this user, wait for it
  const existing = refreshLocks.get(userId);
  if (existing) {
    return existing;
  }

  const promise = refreshTokenIfNeededInternal(userId).finally(() => {
    refreshLocks.delete(userId);
  });
  refreshLocks.set(userId, promise);
  return promise;
}

async function refreshTokenIfNeededInternal(userId: string): Promise<{ accessToken: string; domain: string }> {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.user_id, userId), eq(integrations.provider, "pipedrive")))
    .limit(1);

  if (!integration) {
    throw new Error("No Pipedrive integration found");
  }

  const providerData = integration.provider_data as any || {};
  const domain = providerData.api_domain || "api.pipedrive.com";

  // Check if token is still valid (with 5 min buffer)
  if (integration.token_expires_at.getTime() > Date.now() + TOKEN_BUFFER_MS) {
    return { accessToken: decrypt(integration.access_token_enc), domain };
  }

  // Refresh the token
  const { clientId, clientSecret } = getClientCredentials();
  const refreshToken = decrypt(integration.refresh_token_enc);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, userId }, "Pipedrive token refresh failed");
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = await res.json() as any;
  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000);

  await db
    .update(integrations)
    .set({
      access_token_enc: encrypt(data.access_token),
      refresh_token_enc: encrypt(data.refresh_token),
      token_expires_at: newExpiresAt,
      updated_at: new Date(),
    })
    .where(eq(integrations.id, integration.id));

  logger.info({ userId }, "Pipedrive token refreshed");
  return { accessToken: data.access_token, domain: data.api_domain || domain };
}

/**
 * Make a GET request to the Pipedrive API with automatic token refresh and retry.
 */
export async function getPipedriveData(
  userId: string,
  endpoint: string,
  params?: Record<string, string>
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { accessToken, domain } = await refreshTokenIfNeeded(userId);

    const version = endpoint.match(/^(deals|persons|organizations|activities)/) ? "v2" : "v1";
    const base = domain.startsWith("http") ? domain : `https://${domain}`;
    const url = new URL(`/api/${version}/${endpoint}`, base);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
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

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "2", 10);
      logger.warn({ userId, endpoint, retryAfter, attempt }, "Pipedrive rate limited");
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      lastError = new Error(`Pipedrive API ${res.status}: ${await res.text()}`);
      if (res.status >= 500) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw lastError;
    }

    return await res.json();
  }

  throw lastError || new Error("Max retries exceeded");
}

/**
 * Register Pipedrive webhooks after OAuth connect.
 * Best-effort — failure is logged but doesn't block the OAuth flow.
 * Events: deal updates, person updates, activity updates.
 *
 * LIMITATION (multi-user): Currently uses a single webhook callback URL
 * for all users. For multi-user support, use per-user unique URLs or
 * per-user Basic Auth credentials on the webhook endpoint.
 *
 * IDEMPOTENCE CONTRACT: Webhook events may be delivered more than once
 * (e.g. on reconnect, retry). Consuming agents MUST be idempotent —
 * processing the same event twice should produce the same result.
 */
export async function registerWebhooks(
  accessToken: string,
  domain: string,
  callbackUrl: string
): Promise<void> {
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  const events = [
    { event_action: "updated", event_object: "deal" },
    { event_action: "updated", event_object: "person" },
    { event_action: "added", event_object: "activity" },
    { event_action: "updated", event_object: "activity" },
  ];

  for (const event of events) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${base}/api/v1/webhooks`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subscription_url: callbackUrl,
            event_action: event.event_action,
            event_object: event.event_object,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          logger.warn({ status: res.status, event, text: text.slice(0, 200) }, "Pipedrive webhook registration failed");
        } else {
          logger.info({ event }, "Pipedrive webhook registered");
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      logger.warn({ err, event }, "Pipedrive webhook registration error");
    }
  }
}

/**
 * Revoke a Pipedrive OAuth token. Best-effort — errors are logged but not thrown.
 * Called during disconnect to properly clean up the OAuth grant.
 */
export async function revokeToken(userId: string): Promise<void> {
  try {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.user_id, userId), eq(integrations.provider, "pipedrive")))
      .limit(1);

    if (!integration) return;

    const { clientId, clientSecret } = getClientCredentials();
    const refreshToken = decrypt(integration.refresh_token_enc);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch("https://oauth.pipedrive.com/oauth/revoke", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: refreshToken }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ userId, status: res.status }, "Pipedrive token revocation returned non-200");
      } else {
        logger.info({ userId }, "Pipedrive OAuth token revoked");
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn({ userId, err }, "Pipedrive token revocation failed (best-effort)");
  }
}
