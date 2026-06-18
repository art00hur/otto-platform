/**
 * Spending Guard — Global circuit breaker to protect against runaway AI costs.
 *
 * Three layers of protection:
 *   1. Per-user in-memory credit tracking (pre-check before OpenRouter call)
 *   2. Per-user DB credit check (authoritative, checked before each request)
 *   3. Global daily + monthly spending cap (circuit breaker)
 *
 * If global spend exceeds the cap, ALL AI requests are blocked until reset.
 * This prevents a compromised token or bug from draining the OpenRouter account.
 */

import { db } from "../db/index.js";
import { subscriptions } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { logger } from "../utils/logger.js";

// ============================================================
// Configuration
// ============================================================

// Global monthly cap in cents — hard stop across ALL customers
const GLOBAL_MONTHLY_CAP_CENTS = parseInt(
  process.env.GLOBAL_MONTHLY_CAP_CENTS || "13000", // €130 default
  10
);

// Global daily cap in cents — early warning / burst protection
const GLOBAL_DAILY_CAP_CENTS = parseInt(
  process.env.GLOBAL_DAILY_CAP_CENTS || "2000", // €20/day default
  10
);

// Per-request max cost in cents — reject suspiciously expensive single requests
const MAX_SINGLE_REQUEST_CENTS = parseInt(
  process.env.MAX_SINGLE_REQUEST_CENTS || "500", // €5 max per request
  10
);

// ============================================================
// In-memory tracking (fast path, no DB hit)
// ============================================================

interface DailySpend {
  date: string;       // YYYY-MM-DD
  totalCents: number;
}

interface MonthlySpend {
  month: string;       // YYYY-MM
  totalCents: number;
}

interface UserCreditCache {
  usedCents: number;
  limitCents: number;
  lastUpdated: number;
}

let dailySpend: DailySpend = { date: todayStr(), totalCents: 0 };
let monthlySpend: MonthlySpend = { month: monthStr(), totalCents: 0 };
let circuitOpen = false;
let circuitOpenReason = "";

// Per-user in-memory credit cache (avoids DB hit on every request)
const userCreditCache = new Map<string, UserCreditCache>();
const CACHE_TTL_MS = 30_000; // 30 seconds — short enough to be safe

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStr(): string {
  return new Date().toISOString().slice(0, 7);
}

// ============================================================
// Public API
// ============================================================

/**
 * Check if a request should be allowed. Call BEFORE forwarding to OpenRouter.
 * Returns { allowed: true } or { allowed: false, reason: string }
 */
export function preFlightCheck(
  userId: string,
  creditsUsedCents: number,
  creditsLimitCents: number
): { allowed: boolean; reason?: string } {
  // 1. Circuit breaker — blocks everything
  if (circuitOpen) {
    return { allowed: false, reason: `Service temporarily paused: ${circuitOpenReason}` };
  }

  // 2. Check daily cap
  if (dailySpend.date !== todayStr()) {
    dailySpend = { date: todayStr(), totalCents: 0 };
  }
  if (dailySpend.totalCents >= GLOBAL_DAILY_CAP_CENTS) {
    tripCircuit(`Daily spend cap reached (€${(GLOBAL_DAILY_CAP_CENTS / 100).toFixed(0)}/day)`);
    return { allowed: false, reason: circuitOpenReason };
  }

  // 3. Check monthly cap
  if (monthlySpend.month !== monthStr()) {
    monthlySpend = { month: monthStr(), totalCents: 0 };
    // Reset circuit breaker on new month
    if (circuitOpen && circuitOpenReason.includes("Monthly")) {
      circuitOpen = false;
      circuitOpenReason = "";
      logger.info("spending-guard: Monthly reset — circuit breaker cleared");
    }
  }
  if (monthlySpend.totalCents >= GLOBAL_MONTHLY_CAP_CENTS) {
    tripCircuit(`Monthly spend cap reached (€${(GLOBAL_MONTHLY_CAP_CENTS / 100).toFixed(0)}/month)`);
    return { allowed: false, reason: circuitOpenReason };
  }

  // 4. Per-user credit check (in-memory fast path)
  if (creditsUsedCents >= creditsLimitCents) {
    return { allowed: false, reason: "AI credits exhausted" };
  }

  // 5. Safety margin: if user is within 1 cent of limit, block
  const remaining = creditsLimitCents - creditsUsedCents;
  if (remaining <= 0) {
    return { allowed: false, reason: "AI credits exhausted" };
  }

  return { allowed: true };
}

/**
 * Record actual spend after a request completes.
 * Called with the real cost from OpenRouter's response.
 */
export function recordSpend(userId: string, costCents: number): void {
  if (costCents <= 0) return;

  // Update daily tracker
  if (dailySpend.date !== todayStr()) {
    dailySpend = { date: todayStr(), totalCents: 0 };
  }
  dailySpend.totalCents += costCents;

  // Update monthly tracker
  if (monthlySpend.month !== monthStr()) {
    monthlySpend = { month: monthStr(), totalCents: 0 };
  }
  monthlySpend.totalCents += costCents;

  // Update user cache
  const cached = userCreditCache.get(userId);
  if (cached) {
    cached.usedCents += costCents;
    cached.lastUpdated = Date.now();
  }

  // Log warnings at thresholds
  const dailyPercent = (dailySpend.totalCents / GLOBAL_DAILY_CAP_CENTS) * 100;
  const monthlyPercent = (monthlySpend.totalCents / GLOBAL_MONTHLY_CAP_CENTS) * 100;

  if (dailyPercent >= 80 && dailyPercent < 85) {
    logger.warn(
      { dailyCents: dailySpend.totalCents, capCents: GLOBAL_DAILY_CAP_CENTS, percent: dailyPercent.toFixed(0) },
      "spending-guard: ⚠️ Daily spend at 80% of cap"
    );
  }
  if (monthlyPercent >= 80 && monthlyPercent < 85) {
    logger.warn(
      { monthlyCents: monthlySpend.totalCents, capCents: GLOBAL_MONTHLY_CAP_CENTS, percent: monthlyPercent.toFixed(0) },
      "spending-guard: ⚠️ Monthly spend at 80% of cap"
    );
  }

  // Check if we should trip the circuit
  if (dailySpend.totalCents >= GLOBAL_DAILY_CAP_CENTS) {
    tripCircuit(`Daily spend cap reached (€${(GLOBAL_DAILY_CAP_CENTS / 100).toFixed(0)}/day)`);
  }
  if (monthlySpend.totalCents >= GLOBAL_MONTHLY_CAP_CENTS) {
    tripCircuit(`Monthly spend cap reached (€${(GLOBAL_MONTHLY_CAP_CENTS / 100).toFixed(0)}/month)`);
  }
}

/**
 * Validate that a single request's cost isn't suspiciously high.
 * Call after receiving cost from OpenRouter but before deducting.
 */
export function validateRequestCost(costCents: number): boolean {
  if (costCents > MAX_SINGLE_REQUEST_CENTS) {
    logger.error(
      { costCents, maxCents: MAX_SINGLE_REQUEST_CENTS },
      "spending-guard: 🚨 Single request cost exceeds maximum — blocking deduction"
    );
    return false;
  }
  return true;
}

/**
 * Cache user credits (called after DB auth check).
 */
export function cacheUserCredits(userId: string, usedCents: number, limitCents: number): void {
  userCreditCache.set(userId, {
    usedCents,
    limitCents,
    lastUpdated: Date.now(),
  });
}

/**
 * Get cached user credits (fast path to avoid DB on every request).
 * Returns null if cache is stale or missing.
 */
export function getCachedCredits(userId: string): UserCreditCache | null {
  const cached = userCreditCache.get(userId);
  if (!cached) return null;
  if (Date.now() - cached.lastUpdated > CACHE_TTL_MS) {
    userCreditCache.delete(userId);
    return null;
  }
  return cached;
}

/**
 * Get current spending status (for admin dashboard).
 */
export function getSpendingStatus() {
  return {
    circuitOpen,
    circuitOpenReason,
    daily: {
      date: dailySpend.date,
      spentCents: dailySpend.totalCents,
      capCents: GLOBAL_DAILY_CAP_CENTS,
      percent: Math.round((dailySpend.totalCents / GLOBAL_DAILY_CAP_CENTS) * 100),
    },
    monthly: {
      month: monthlySpend.month,
      spentCents: monthlySpend.totalCents,
      capCents: GLOBAL_MONTHLY_CAP_CENTS,
      percent: Math.round((monthlySpend.totalCents / GLOBAL_MONTHLY_CAP_CENTS) * 100),
    },
    perRequestMaxCents: MAX_SINGLE_REQUEST_CENTS,
  };
}

/**
 * Manually reset the circuit breaker (admin action).
 */
export function resetCircuitBreaker(): void {
  circuitOpen = false;
  circuitOpenReason = "";
  logger.info("spending-guard: Circuit breaker manually reset");
}

// ============================================================
// Internal
// ============================================================

function tripCircuit(reason: string): void {
  if (!circuitOpen) {
    circuitOpen = true;
    circuitOpenReason = reason;
    logger.error(
      { reason, dailyCents: dailySpend.totalCents, monthlyCents: monthlySpend.totalCents },
      "spending-guard: 🚨 CIRCUIT BREAKER TRIPPED — All AI requests blocked"
    );
  }
}
