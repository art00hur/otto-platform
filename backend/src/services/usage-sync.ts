/**
 * Usage Sync Worker — Polls OpenRouter Provisioning API to track per-customer
 * AI usage and updates ai_credits_used in the subscriptions table.
 *
 * Architecture:
 *   - Each customer VPS gets its own OpenRouter API key (created via Provisioning API)
 *   - The key hash is stored in instances.openrouter_key_hash
 *   - This worker runs every 30 minutes via setInterval (inside the main backend process)
 *   - It fetches usage for each key from OpenRouter → updates subscriptions.ai_credits_used
 *
 * Requires:
 *   - OPENROUTER_PROVISIONING_KEY env var (create at https://openrouter.ai/settings/provisioning-keys)
 *   - instances.openrouter_key_hash column in DB
 *
 * Usage:
 *   import { startUsageSync } from "./services/usage-sync.js";
 *   startUsageSync(); // call once at server startup
 */

import { db } from "../db/index.js";
import { instances, subscriptions } from "../db/schema.js";
import { eq, isNotNull, and } from "drizzle-orm";
import { logger } from "../utils/logger.js";

const OPENROUTER_PROVISIONING_KEY = process.env.OPENROUTER_PROVISIONING_KEY || "";
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const OPENROUTER_KEYS_API = "https://openrouter.ai/api/v1/keys";

interface OpenRouterKeyInfo {
  hash: string;
  name: string;
  usage: number;        // total spend in $ (cumulative)
  usage_monthly: number; // this month's spend in $
  limit: number | null;
  limit_remaining: number | null;
  disabled: boolean;
}

/**
 * Fetch all API keys from OpenRouter Provisioning API.
 * Returns array of key info objects.
 */
async function fetchAllKeys(): Promise<OpenRouterKeyInfo[]> {
  if (!OPENROUTER_PROVISIONING_KEY) {
    logger.warn("usage-sync: OPENROUTER_PROVISIONING_KEY not set, skipping");
    return [];
  }

  const allKeys: OpenRouterKeyInfo[] = [];
  let offset = 0;
  const limit = 100;

  // Paginate through all keys
  while (true) {
    const url = `${OPENROUTER_KEYS_API}?offset=${offset}&limit=${limit}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_PROVISIONING_KEY}`,
      },
    });

    if (!res.ok) {
      logger.error(
        { status: res.status, statusText: res.statusText },
        "usage-sync: Failed to fetch keys from OpenRouter"
      );
      break;
    }

    const body = (await res.json()) as { data: OpenRouterKeyInfo[] };
    if (!body.data || body.data.length === 0) break;

    allKeys.push(...body.data);

    if (body.data.length < limit) break; // last page
    offset += limit;
  }

  return allKeys;
}

/**
 * Fetch a single key's info by hash.
 */
export async function fetchKeyInfo(keyHash: string): Promise<OpenRouterKeyInfo | null> {
  if (!OPENROUTER_PROVISIONING_KEY) return null;

  const res = await fetch(`${OPENROUTER_KEYS_API}/${keyHash}`, {
    headers: {
      Authorization: `Bearer ${OPENROUTER_PROVISIONING_KEY}`,
    },
  });

  if (!res.ok) return null;
  const body = (await res.json()) as { data: OpenRouterKeyInfo };
  return body.data || null;
}

/**
 * Create a new OpenRouter API key for a customer.
 * Returns the key string and hash.
 *
 * @param name - Human-readable name (e.g., "otto-customer-{userId}")
 * @param limitDollars - Credit limit in dollars (matches plan limit)
 */
export async function createCustomerKey(
  name: string,
  limitDollars: number
): Promise<{ key: string; hash: string } | null> {
  if (!OPENROUTER_PROVISIONING_KEY) {
    logger.error("usage-sync: Cannot create key — OPENROUTER_PROVISIONING_KEY not set");
    return null;
  }

  try {
    const res = await fetch(OPENROUTER_KEYS_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_PROVISIONING_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        limit: limitDollars,
        limit_reset: "monthly", // auto-reset monthly at midnight UTC
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error(
        { status: res.status, body: errText },
        "usage-sync: Failed to create OpenRouter key"
      );
      return null;
    }

    const body = (await res.json()) as { data: { key: string; hash: string } };
    logger.info({ name, hash: body.data.hash, limitDollars }, "Created OpenRouter key for customer");
    return { key: body.data.key, hash: body.data.hash };
  } catch (err: any) {
    logger.error({ error: err.message }, "usage-sync: Error creating OpenRouter key");
    return null;
  }
}

/**
 * Delete a customer's OpenRouter key (on subscription cancellation).
 */
export async function deleteCustomerKey(keyHash: string): Promise<boolean> {
  if (!OPENROUTER_PROVISIONING_KEY || !keyHash) return false;

  try {
    const res = await fetch(`${OPENROUTER_KEYS_API}/${keyHash}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${OPENROUTER_PROVISIONING_KEY}`,
      },
    });

    if (res.ok) {
      logger.info({ keyHash }, "Deleted OpenRouter key");
      return true;
    } else {
      logger.warn({ keyHash, status: res.status }, "Failed to delete OpenRouter key");
      return false;
    }
  } catch (err: any) {
    logger.error({ keyHash, error: err.message }, "Error deleting OpenRouter key");
    return false;
  }
}

/**
 * Update a key's credit limit (e.g., on plan upgrade or credit top-up).
 */
export async function updateKeyLimit(
  keyHash: string,
  newLimitDollars: number
): Promise<boolean> {
  if (!OPENROUTER_PROVISIONING_KEY || !keyHash) return false;

  try {
    const res = await fetch(`${OPENROUTER_KEYS_API}/${keyHash}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${OPENROUTER_PROVISIONING_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: newLimitDollars }),
    });

    if (res.ok) {
      logger.info({ keyHash, newLimitDollars }, "Updated OpenRouter key limit");
      return true;
    } else {
      logger.warn({ keyHash, status: res.status }, "Failed to update OpenRouter key limit");
      return false;
    }
  } catch (err: any) {
    logger.error({ keyHash, error: err.message }, "Error updating OpenRouter key limit");
    return false;
  }
}

/**
 * Refresh usage for a single instance — called after each chat message.
 * Fetches the key's current usage from OpenRouter and updates the DB.
 * Returns the updated usage in cents, or null on failure.
 */
export async function refreshInstanceUsage(
  instanceId: string
): Promise<{ usageCents: number; limitCents: number; bonusCents: number } | null> {
  if (!OPENROUTER_PROVISIONING_KEY) return null;

  try {
    // 1. Get the instance's key hash
    const [inst] = await db
      .select({
        openrouter_key_hash: instances.openrouter_key_hash,
        user_id: instances.user_id,
      })
      .from(instances)
      .where(eq(instances.id, instanceId));

    if (!inst?.openrouter_key_hash || !inst.user_id) return null;

    // 2. Fetch key info from OpenRouter
    const keyInfo = await fetchKeyInfo(inst.openrouter_key_hash);
    if (!keyInfo) return null;

    // 3. Convert monthly usage from dollars to cents
    const usageCents = Math.round(keyInfo.usage_monthly * 100);

    // 4. Update DB
    await db
      .update(subscriptions)
      .set({ ai_credits_used: usageCents })
      .where(
        and(
          eq(subscriptions.user_id, inst.user_id),
          eq(subscriptions.instance_id, instanceId),
          eq(subscriptions.status, "active")
        )
      );

    // 5. Get the full subscription info to return
    const [sub] = await db
      .select({
        ai_credits_limit: subscriptions.ai_credits_limit,
        ai_credits_bonus: subscriptions.ai_credits_bonus,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.user_id, inst.user_id),
          eq(subscriptions.instance_id, instanceId),
          eq(subscriptions.status, "active")
        )
      );

    return {
      usageCents,
      limitCents: sub?.ai_credits_limit || 0,
      bonusCents: sub?.ai_credits_bonus || 0,
    };
  } catch (err: any) {
    logger.error(
      { instanceId, error: err.message },
      "usage-sync: Failed to refresh instance usage"
    );
    return null;
  }
}

/**
 * Main sync function: fetch all keys, match to instances, update DB.
 * Called every 30 minutes.
 */
async function syncUsage(): Promise<void> {
  logger.info("usage-sync: Starting usage sync cycle");

  try {
    // 1. Get all active instances that have an OpenRouter key hash
    const activeInstances = await db
      .select({
        id: instances.id,
        user_id: instances.user_id,
        openrouter_key_hash: instances.openrouter_key_hash,
      })
      .from(instances)
      .where(
        and(
          eq(instances.status, "active"),
          isNotNull(instances.openrouter_key_hash)
        )
      );

    if (activeInstances.length === 0) {
      logger.info("usage-sync: No active instances with OpenRouter keys");
      return;
    }

    // 2. Build a map of keyHash → instanceId
    const hashToInstance = new Map<string, { id: string; user_id: string | null }>();
    for (const inst of activeInstances) {
      if (inst.openrouter_key_hash) {
        hashToInstance.set(inst.openrouter_key_hash, {
          id: inst.id,
          user_id: inst.user_id,
        });
      }
    }

    // 3. Fetch all keys from OpenRouter
    const keys = await fetchAllKeys();
    if (keys.length === 0) {
      logger.info("usage-sync: No keys returned from OpenRouter");
      return;
    }

    // 4. Match keys to instances and update usage
    let updated = 0;
    for (const key of keys) {
      const inst = hashToInstance.get(key.hash);
      if (!inst || !inst.user_id) continue;

      // Convert usage_monthly from dollars to cents
      const usageCents = Math.round(key.usage_monthly * 100);

      // Update the subscription's ai_credits_used
      await db
        .update(subscriptions)
        .set({ ai_credits_used: usageCents })
        .where(
          and(
            eq(subscriptions.user_id, inst.user_id),
            eq(subscriptions.instance_id, inst.id),
            eq(subscriptions.status, "active")
          )
        );

      updated++;
    }

    logger.info(
      { totalKeys: keys.length, matchedInstances: activeInstances.length, updated },
      "usage-sync: Sync cycle complete"
    );
  } catch (err: any) {
    logger.error({ error: err.message, stack: err.stack }, "usage-sync: Sync cycle failed");
  }
}

/**
 * Start the usage sync worker.
 * Call once from server.ts at startup.
 */
export function startUsageSync(): void {
  if (!OPENROUTER_PROVISIONING_KEY) {
    logger.warn("usage-sync: OPENROUTER_PROVISIONING_KEY not set — usage sync disabled");
    return;
  }

  logger.info({ intervalMs: SYNC_INTERVAL_MS }, "usage-sync: Starting worker");

  // Run immediately on startup (after a short delay to let DB connect)
  setTimeout(() => {
    syncUsage().catch((err) =>
      logger.error({ error: err.message }, "usage-sync: Initial sync failed")
    );
  }, 10_000);

  // Then every 30 minutes
  setInterval(() => {
    syncUsage().catch((err) =>
      logger.error({ error: err.message }, "usage-sync: Periodic sync failed")
    );
  }, SYNC_INTERVAL_MS);
}
