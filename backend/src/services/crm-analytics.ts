import { logger } from "../utils/logger.js";
import type { CRMConnector, Deal, Organization, Pipeline } from "../connectors/types.js";

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface AnalyticsError {
  error: string;
  fallback: true;
}

export interface InactiveDeal {
  deal: Deal;
  lastActivityDate: string;
  daysSinceActivity: number;
  owner: string;
}

export interface InactiveDealsResult {
  items: InactiveDeal[];
  total: number;
}

export interface RevenueByClient {
  org: Organization;
  currentPeriodValue: number;
  previousPeriodValue: number;
  trend: "up" | "down" | "stable";
  pctChange: number;
}

export interface RevenueByClientResult {
  items: RevenueByClient[];
  total: number;
  reason?: string;
}

export interface PipelineStageStats {
  name: string;
  dealCount: number;
  totalValue: number;
}

export interface PipelineStats {
  name: string;
  stages: PipelineStageStats[];
  stuckDeals: number;
}

export interface PipelineHealthResult {
  pipelines: PipelineStats[];
  totalDeals: number;
  totalValue: number;
  healthScore: "green" | "yellow" | "red";
  inactivePercent: number;
}

export interface UpcomingClose {
  deal: Deal;
  expectedCloseDate: string;
  daysUntilClose: number;
  value: number;
}

export interface UpcomingClosesResult {
  items: UpcomingClose[];
  total: number;
}

export interface ChurnRiskOrg {
  org: Organization;
  lastDealDate: string;
  daysSinceLastDeal: number;
  previousFrequency: string;
}

export interface ChurnRiskResult {
  items: ChurnRiskOrg[];
  total: number;
  reason?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(date1: Date, date2: Date): number {
  return Math.floor(Math.abs(date1.getTime() - date2.getTime()) / MS_PER_DAY);
}

/**
 * Fetch all deals from the connector (paginated).
 * Returns up to 500 deals (Pipedrive max per request).
 */
async function fetchAllDeals(connector: CRMConnector): Promise<Deal[]> {
  return connector.listDeals({ limit: 500 });
}

// ============================================================================
// ANALYTICAL QUERIES
// ============================================================================

/**
 * Get deals with no activity (update) in the last N days.
 * Returns top-N results sorted by days since activity (most stale first).
 */
export async function getInactiveDeals(
  connector: CRMConnector,
  days: number = 14,
  topN: number = 20
): Promise<InactiveDealsResult | AnalyticsError> {
  try {
    const deals = await fetchAllDeals(connector);
    const now = new Date();
    const threshold = days * MS_PER_DAY;

    const inactive = deals
      .map((d) => {
        const updated = new Date(d.updatedAt);
        const msSinceActivity = now.getTime() - updated.getTime();
        return {
          deal: d,
          lastActivityDate: d.updatedAt,
          daysSinceActivity: Math.floor(msSinceActivity / MS_PER_DAY),
          owner: d.ownerName || "Unknown",
          _msSinceActivity: msSinceActivity,
        };
      })
      .filter((item) => item._msSinceActivity > threshold)
      .sort((a, b) => b._msSinceActivity - a._msSinceActivity);

    const total = inactive.length;
    const items = inactive.slice(0, topN).map(({ _msSinceActivity, ...rest }) => rest);

    return { items, total };
  } catch (err) {
    logger.error({ err }, "getInactiveDeals failed");
    return { error: "Failed to fetch inactive deals from CRM", fallback: true };
  }
}

/**
 * Get revenue by client (organization) with trend comparison.
 * Compares current period vs previous period of same length.
 * CONDITIONAL: returns empty if deals have no amount field.
 */
export async function getRevenueByClient(
  connector: CRMConnector,
  periodDays: number = 30,
  topN: number = 20
): Promise<RevenueByClientResult | AnalyticsError> {
  try {
    const deals = await fetchAllDeals(connector);

    // Check if deals have value data
    const dealsWithAmount = deals.filter((d) => d.amount > 0);
    if (dealsWithAmount.length === 0) {
      return { items: [], total: 0, reason: "no value field" };
    }

    const now = new Date();
    const currentStart = new Date(now.getTime() - periodDays * MS_PER_DAY);
    const previousStart = new Date(currentStart.getTime() - periodDays * MS_PER_DAY);

    // Group deals by organization
    const orgMap = new Map<string, { current: number; previous: number; org: Organization | null }>();

    for (const d of dealsWithAmount) {
      const orgId = d.organizationId || "no-org";
      if (!orgMap.has(orgId)) {
        orgMap.set(orgId, { current: 0, previous: 0, org: null });
      }
      const entry = orgMap.get(orgId)!;

      // Use deal creation date for period assignment
      const dealDate = new Date(d.createdAt);
      if (dealDate >= currentStart) {
        entry.current += d.amount;
      } else if (dealDate >= previousStart) {
        entry.previous += d.amount;
      }
    }

    // Fetch organizations to get names
    let orgs: Organization[] = [];
    try {
      orgs = await connector.listOrganizations({ limit: 500 });
    } catch (orgErr) {
      logger.warn({ orgErr }, "Failed to fetch organizations for revenue analysis, continuing without org details");
    }
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    const results: RevenueByClient[] = [];
    for (const [orgId, data] of orgMap) {
      const org = orgById.get(orgId) || {
        id: orgId,
        name: orgId === "no-org" ? "Sans organisation" : `Org ${orgId}`,
        domain: null,
        industry: null,
        employees: null,
        annualRevenue: null,
        description: null,
        customProperties: {},
        createdAt: "",
        updatedAt: "",
        archivedAt: null,
      };

      const pctChange =
        data.previous > 0
          ? Math.round(((data.current - data.previous) / data.previous) * 100)
          : data.current > 0
            ? 100
            : 0;

      const trend: "up" | "down" | "stable" =
        pctChange > 5 ? "up" : pctChange < -5 ? "down" : "stable";

      results.push({
        org,
        currentPeriodValue: data.current,
        previousPeriodValue: data.previous,
        trend,
        pctChange,
      });
    }

    results.sort((a, b) => b.currentPeriodValue - a.currentPeriodValue);
    const total = results.length;

    return { items: results.slice(0, topN), total };
  } catch (err) {
    logger.error({ err }, "getRevenueByClient failed");
    return { error: "Failed to fetch revenue data from CRM", fallback: true };
  }
}

/**
 * Get pipeline health: deals by stage, stuck deals, health score.
 * Health score: green (<10% inactive), yellow (10-25%), red (>25% or token error).
 */
export async function getPipelineHealth(
  connector: CRMConnector,
  stuckDays: number = 14
): Promise<PipelineHealthResult | AnalyticsError> {
  try {
    const [pipelines, deals] = await Promise.all([
      connector.listPipelines(),
      fetchAllDeals(connector),
    ]);

    const now = new Date();
    const stuckThreshold = stuckDays * MS_PER_DAY;

    const totalDeals = deals.length;
    const totalValue = deals.reduce((sum, d) => sum + (d.amount || 0), 0);

    // Count inactive deals across all pipelines
    const inactiveCount = deals.filter(
      (d) => now.getTime() - new Date(d.updatedAt).getTime() > stuckThreshold
    ).length;

    const inactivePercent = totalDeals > 0 ? Math.round((inactiveCount / totalDeals) * 100) : 0;
    const healthScore: "green" | "yellow" | "red" =
      inactivePercent > 25 ? "red" : inactivePercent > 10 ? "yellow" : "green";

    // Build per-pipeline stats
    const pipelineStats: PipelineStats[] = pipelines.map((p) => {
      const pipelineDeals = deals.filter((d) => d.pipelineId === p.id);

      const stageMap = new Map<string, PipelineStageStats>();
      for (const d of pipelineDeals) {
        const stageName = d.stageName || "Unknown";
        if (!stageMap.has(stageName)) {
          stageMap.set(stageName, { name: stageName, dealCount: 0, totalValue: 0 });
        }
        const stage = stageMap.get(stageName)!;
        stage.dealCount++;
        stage.totalValue += d.amount || 0;
      }

      const stuckDeals = pipelineDeals.filter(
        (d) => now.getTime() - new Date(d.updatedAt).getTime() > stuckThreshold
      ).length;

      return {
        name: p.name,
        stages: Array.from(stageMap.values()),
        stuckDeals,
      };
    });

    return { pipelines: pipelineStats, totalDeals, totalValue, healthScore, inactivePercent };
  } catch (err) {
    logger.error({ err }, "getPipelineHealth failed");
    return { error: "Failed to fetch pipeline health from CRM", fallback: true };
  }
}

/**
 * Get deals with expected close date within the next N days.
 */
export async function getUpcomingCloses(
  connector: CRMConnector,
  days: number = 7,
  topN: number = 20
): Promise<UpcomingClosesResult | AnalyticsError> {
  try {
    const deals = await fetchAllDeals(connector);
    const now = new Date();
    const horizon = days * MS_PER_DAY;

    const upcoming = deals
      .filter((d) => {
        if (!d.closeDate) return false;
        const close = new Date(d.closeDate);
        const diff = close.getTime() - now.getTime();
        return diff >= 0 && diff <= horizon;
      })
      .map((d) => ({
        deal: d,
        expectedCloseDate: d.closeDate!,
        daysUntilClose: daysBetween(new Date(d.closeDate!), now),
        value: d.amount || 0,
      }))
      .sort((a, b) => a.daysUntilClose - b.daysUntilClose);

    const total = upcoming.length;
    return { items: upcoming.slice(0, topN), total };
  } catch (err) {
    logger.error({ err }, "getUpcomingCloses failed");
    return { error: "Failed to fetch upcoming closes from CRM", fallback: true };
  }
}

/**
 * Get organizations at churn risk based on deal activity decline.
 * CONDITIONAL: returns empty if less than 3 months of deal history.
 */
export async function getChurnRisk(
  connector: CRMConnector,
  topN: number = 20
): Promise<ChurnRiskResult | AnalyticsError> {
  try {
    const deals = await fetchAllDeals(connector);
    const now = new Date();
    const threeMonthsAgo = new Date(now.getTime() - 90 * MS_PER_DAY);

    // Check if there's enough history
    const oldestDeal = deals.reduce(
      (oldest, d) => {
        const created = new Date(d.createdAt);
        return created < oldest ? created : oldest;
      },
      now
    );

    if (oldestDeal > threeMonthsAgo) {
      return { items: [], total: 0, reason: "insufficient history" };
    }

    // Group deals by organization
    const orgDeals = new Map<string, Deal[]>();
    for (const d of deals) {
      const orgId = d.organizationId || "no-org";
      if (!orgDeals.has(orgId)) orgDeals.set(orgId, []);
      orgDeals.get(orgId)!.push(d);
    }

    // Fetch organizations
    let orgs: Organization[] = [];
    try {
      orgs = await connector.listOrganizations({ limit: 500 });
    } catch (orgErr) {
      logger.warn({ orgErr }, "Failed to fetch organizations for churn analysis, continuing without org details");
    }
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    const atRisk: ChurnRiskOrg[] = [];

    for (const [orgId, orgDealList] of orgDeals) {
      if (orgId === "no-org") continue;

      // Sort by date
      const sorted = orgDealList.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      const lastDealDate = sorted[0].createdAt;
      const daysSinceLastDeal = daysBetween(new Date(lastDealDate), now);

      // Calculate average frequency (days between deals)
      let avgFrequency = "unknown";
      if (sorted.length >= 2) {
        const intervals: number[] = [];
        for (let i = 0; i < sorted.length - 1; i++) {
          const gap = daysBetween(new Date(sorted[i].createdAt), new Date(sorted[i + 1].createdAt));
          intervals.push(gap);
        }
        const avgDays = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
        avgFrequency = `~${avgDays} jours entre commandes`;
      }

      // At risk if last deal is 2x their average frequency, or 30+ days with no pattern
      const isAtRisk =
        sorted.length >= 2
          ? daysSinceLastDeal > avgDays(sorted) * 2
          : daysSinceLastDeal > 30;

      if (isAtRisk) {
        const org = orgById.get(orgId) || {
          id: orgId,
          name: `Org ${orgId}`,
          domain: null,
          industry: null,
          employees: null,
          annualRevenue: null,
          description: null,
          customProperties: {},
          createdAt: "",
          updatedAt: "",
          archivedAt: null,
        };

        atRisk.push({
          org,
          lastDealDate,
          daysSinceLastDeal,
          previousFrequency: avgFrequency,
        });
      }
    }

    atRisk.sort((a, b) => b.daysSinceLastDeal - a.daysSinceLastDeal);
    const total = atRisk.length;

    return { items: atRisk.slice(0, topN), total };
  } catch (err) {
    logger.error({ err }, "getChurnRisk failed");
    return { error: "Failed to fetch churn risk from CRM", fallback: true };
  }
}

// Helper to calculate average days between deals
function avgDays(sortedDeals: Deal[]): number {
  if (sortedDeals.length < 2) return 30;
  const intervals: number[] = [];
  for (let i = 0; i < sortedDeals.length - 1; i++) {
    intervals.push(
      daysBetween(new Date(sortedDeals[i].createdAt), new Date(sortedDeals[i + 1].createdAt))
    );
  }
  return Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
}

// ============================================================================
// TYPE GUARD
// ============================================================================

export function isAnalyticsError(result: unknown): result is AnalyticsError {
  return typeof result === "object" && result !== null && "fallback" in result;
}
