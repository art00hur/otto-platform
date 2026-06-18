import { describe, it, expect, vi } from "vitest";
import type { CRMConnector, Deal, Pipeline, Organization } from "../../connectors/types.js";
import {
  getInactiveDeals,
  getRevenueByClient,
  getPipelineHealth,
  getUpcomingCloses,
  getChurnRisk,
  isAnalyticsError,
} from "../crm-analytics.js";

// ============================================================================
// MOCK CONNECTOR
// ============================================================================

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * MS_PER_DAY).toISOString();
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * MS_PER_DAY).toISOString();
}

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "1",
    title: "Test Deal",
    amount: 1000,
    currency: "EUR",
    pipelineId: "1",
    stageId: "1",
    stageName: "Prospect",
    ownerId: "1",
    ownerName: "Jean",
    organizationId: "org-1",
    organizationName: "Restaurant ABC",
    description: null,
    closeDate: null,
    probability: 50,
    source: null,
    customProperties: {},
    createdAt: daysAgo(60),
    updatedAt: daysAgo(1),
    archivedAt: null,
    ...overrides,
  };
}

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "org-1",
    name: "Restaurant ABC",
    domain: null,
    industry: null,
    employees: null,
    annualRevenue: null,
    description: null,
    customProperties: {},
    createdAt: daysAgo(180),
    updatedAt: daysAgo(1),
    archivedAt: null,
    ...overrides,
  };
}

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "1",
    name: "Sales",
    archived: false,
    stages: [
      { id: "1", name: "Prospect", order: 0, archived: false },
      { id: "2", name: "Devis", order: 1, archived: false },
      { id: "3", name: "Gagné", order: 2, archived: false },
    ],
    ...overrides,
  };
}

function mockConnector(overrides: Partial<CRMConnector> = {}): CRMConnector {
  return {
    initialize: vi.fn(),
    listPipelines: vi.fn().mockResolvedValue([makePipeline()]),
    listDeals: vi.fn().mockResolvedValue([]),
    getDeal: vi.fn(),
    updateDeal: vi.fn(),
    searchContacts: vi.fn(),
    getContact: vi.fn(),
    createContact: vi.fn(),
    listOrganizations: vi.fn().mockResolvedValue([makeOrg()]),
    createActivity: vi.fn(),
    addNote: vi.fn(),
    getRecentChanges: vi.fn(),
    ...overrides,
  };
}

// ============================================================================
// getInactiveDeals
// ============================================================================

describe("getInactiveDeals", () => {
  it("returns deals inactive for more than N days", async () => {
    const connector = mockConnector({
      listDeals: vi.fn().mockResolvedValue([
        makeDeal({ id: "1", title: "Active", updatedAt: daysAgo(2) }),
        makeDeal({ id: "2", title: "Stale", updatedAt: daysAgo(20) }),
        makeDeal({ id: "3", title: "Very Stale", updatedAt: daysAgo(45) }),
      ]),
    });

    const result = await getInactiveDeals(connector, 14);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBe(2);
    expect(result.items[0].deal.title).toBe("Very Stale");
    expect(result.items[1].deal.title).toBe("Stale");
  });

  it("returns empty when no deals exist", async () => {
    const connector = mockConnector();
    const result = await getInactiveDeals(connector, 14);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("respects top-N limit", async () => {
    const deals = Array.from({ length: 50 }, (_, i) =>
      makeDeal({ id: String(i), title: `Deal ${i}`, updatedAt: daysAgo(20 + i) })
    );
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getInactiveDeals(connector, 14, 5);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBe(50);
    expect(result.items.length).toBe(5);
  });

  it("returns fallback error when API fails", async () => {
    const connector = mockConnector({
      listDeals: vi.fn().mockRejectedValue(new Error("API timeout")),
    });

    const result = await getInactiveDeals(connector, 14);
    expect(isAnalyticsError(result)).toBe(true);
    if (!isAnalyticsError(result)) return;

    expect(result.error).toContain("inactive deals");
    expect(result.fallback).toBe(true);
  });
});

// ============================================================================
// getPipelineHealth
// ============================================================================

describe("getPipelineHealth", () => {
  it("calculates health score green when few inactive deals", async () => {
    const deals = [
      makeDeal({ id: "1", updatedAt: daysAgo(1), stageName: "Prospect", pipelineId: "1" }),
      makeDeal({ id: "2", updatedAt: daysAgo(2), stageName: "Devis", pipelineId: "1" }),
      makeDeal({ id: "3", updatedAt: daysAgo(3), stageName: "Prospect", pipelineId: "1" }),
    ];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getPipelineHealth(connector, 14);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.healthScore).toBe("green");
    expect(result.totalDeals).toBe(3);
    expect(result.inactivePercent).toBe(0);
  });

  it("calculates health score red when many inactive deals", async () => {
    const deals = [
      makeDeal({ id: "1", updatedAt: daysAgo(30), pipelineId: "1" }),
      makeDeal({ id: "2", updatedAt: daysAgo(25), pipelineId: "1" }),
      makeDeal({ id: "3", updatedAt: daysAgo(20), pipelineId: "1" }),
      makeDeal({ id: "4", updatedAt: daysAgo(1), pipelineId: "1" }),
    ];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getPipelineHealth(connector, 14);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.healthScore).toBe("red");
    expect(result.inactivePercent).toBe(75);
  });

  it("handles zero deals gracefully", async () => {
    const connector = mockConnector();
    const result = await getPipelineHealth(connector);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.healthScore).toBe("green");
    expect(result.totalDeals).toBe(0);
  });

  it("returns fallback on API error", async () => {
    const connector = mockConnector({
      listDeals: vi.fn().mockRejectedValue(new Error("timeout")),
      listPipelines: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    const result = await getPipelineHealth(connector);
    expect(isAnalyticsError(result)).toBe(true);
  });
});

// ============================================================================
// getUpcomingCloses
// ============================================================================

describe("getUpcomingCloses", () => {
  it("returns deals closing within N days", async () => {
    const deals = [
      makeDeal({ id: "1", closeDate: daysFromNow(3), amount: 5000 }),
      makeDeal({ id: "2", closeDate: daysFromNow(10), amount: 3000 }),
      makeDeal({ id: "3", closeDate: null }),
    ];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getUpcomingCloses(connector, 7);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBe(1);
    expect(result.items[0].deal.id).toBe("1");
    expect(result.items[0].value).toBe(5000);
  });

  it("returns empty when no deals have close dates", async () => {
    const deals = [makeDeal({ closeDate: null }), makeDeal({ closeDate: null })];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getUpcomingCloses(connector, 7);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBe(0);
  });
});

// ============================================================================
// getRevenueByClient
// ============================================================================

describe("getRevenueByClient", () => {
  it("returns empty with reason when no deals have amounts", async () => {
    const deals = [makeDeal({ amount: 0 }), makeDeal({ amount: 0 })];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getRevenueByClient(connector, 30);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.items).toEqual([]);
    expect(result.reason).toBe("no value field");
  });

  it("calculates revenue trends by organization", async () => {
    const deals = [
      makeDeal({ organizationId: "org-1", amount: 2000, createdAt: daysAgo(10) }),
      makeDeal({ organizationId: "org-1", amount: 1500, createdAt: daysAgo(45) }),
      makeDeal({ organizationId: "org-2", amount: 500, createdAt: daysAgo(5) }),
    ];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getRevenueByClient(connector, 30);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBeGreaterThan(0);
    const org1 = result.items.find((i) => i.org.id === "org-1");
    expect(org1).toBeDefined();
    expect(org1!.currentPeriodValue).toBe(2000);
  });
});

// ============================================================================
// getChurnRisk
// ============================================================================

describe("getChurnRisk", () => {
  it("returns empty with reason when insufficient history", async () => {
    const deals = [makeDeal({ createdAt: daysAgo(30) })];
    const connector = mockConnector({ listDeals: vi.fn().mockResolvedValue(deals) });

    const result = await getChurnRisk(connector);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.items).toEqual([]);
    expect(result.reason).toBe("insufficient history");
  });

  it("identifies at-risk orgs with long gaps", async () => {
    const deals = [
      makeDeal({ organizationId: "org-1", createdAt: daysAgo(120) }),
      makeDeal({ organizationId: "org-1", createdAt: daysAgo(100) }),
      makeDeal({ organizationId: "org-1", createdAt: daysAgo(80) }),
      // Last deal 80 days ago, avg frequency ~20 days, gap is 4x avg
    ];
    const connector = mockConnector({
      listDeals: vi.fn().mockResolvedValue(deals),
    });

    const result = await getChurnRisk(connector);
    expect(isAnalyticsError(result)).toBe(false);
    if (isAnalyticsError(result)) return;

    expect(result.total).toBeGreaterThan(0);
    expect(result.items[0].org.id).toBe("org-1");
    expect(result.items[0].daysSinceLastDeal).toBeGreaterThan(70);
  });
});

// ============================================================================
// isAnalyticsError
// ============================================================================

describe("isAnalyticsError", () => {
  it("returns true for error objects", () => {
    expect(isAnalyticsError({ error: "fail", fallback: true })).toBe(true);
  });

  it("returns false for result objects", () => {
    expect(isAnalyticsError({ items: [], total: 0 })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isAnalyticsError(null)).toBe(false);
    expect(isAnalyticsError(undefined)).toBe(false);
  });
});
