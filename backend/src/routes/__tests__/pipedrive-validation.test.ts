import { describe, it, expect } from "vitest";
import { z } from "zod";

// ── Re-declare schemas here (same as crm.ts) to test in isolation ──

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

// ── Re-declare domain validator ──

function isValidPipedriveDomain(domain: string): boolean {
  const normalized = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!normalized.endsWith(".pipedrive.com")) return false;
  if (!/^[a-zA-Z0-9-]+\.pipedrive\.com$/.test(normalized)) return false;
  return true;
}

// ── Re-declare error sanitizer ──

function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/api_token=[^&\s]+/gi, "api_token=***")
    .replace(/token[=:]\s*[^\s&]+/gi, "token=***")
    .replace(/[Aa]uthorization[=:]\s*[Bb]earer\s+[^\s]+/g, "Authorization: Bearer ***")
    .replace(/[Aa]pi[-_]?[Kk]ey[=:]\s*[^\s&]+/g, "api_key=***")
    .replace(/[0-9a-f]{32,}/gi, "[REDACTED]")
    .slice(0, 300);
}

// ============================================================
// Zod Schema Tests
// ============================================================

describe("updateDealSchema", () => {
  it("accepts valid update with title", () => {
    const r = updateDealSchema.safeParse({ id: "123", data: { title: "New deal" } });
    expect(r.success).toBe(true);
  });

  it("rejects empty data object", () => {
    const r = updateDealSchema.safeParse({ id: "123", data: {} });
    expect(r.success).toBe(false);
  });

  it("rejects missing id", () => {
    const r = updateDealSchema.safeParse({ data: { title: "Test" } });
    expect(r.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const r = updateDealSchema.safeParse({ id: "1", data: { amount: -100 } });
    expect(r.success).toBe(false);
  });

  it("accepts amount + stageId together", () => {
    const r = updateDealSchema.safeParse({ id: "1", data: { amount: 500, stageId: "5" } });
    expect(r.success).toBe(true);
  });
});

describe("createContactSchema", () => {
  it("accepts valid contact with name only", () => {
    const r = createContactSchema.safeParse({ firstName: "Jean", lastName: "Dupont" });
    expect(r.success).toBe(true);
  });

  it("rejects missing firstName", () => {
    const r = createContactSchema.safeParse({ lastName: "Dupont" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const r = createContactSchema.safeParse({ firstName: "A", lastName: "B", email: "not-email" });
    expect(r.success).toBe(false);
  });

  it("accepts full contact", () => {
    const r = createContactSchema.safeParse({
      firstName: "Jean", lastName: "Dupont",
      email: "jean@example.com", phone: "+33612345678",
      city: "Paris", country: "France",
    });
    expect(r.success).toBe(true);
  });
});

describe("createActivitySchema", () => {
  it("accepts valid activity", () => {
    const r = createActivitySchema.safeParse({
      type: "call", subject: "Follow-up", activityDate: "2026-04-01",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const r = createActivitySchema.safeParse({
      type: "invalid", subject: "Test", activityDate: "2026-04-01",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid date format", () => {
    const r = createActivitySchema.safeParse({
      type: "call", subject: "Test", activityDate: "01/04/2026",
    });
    expect(r.success).toBe(false);
  });
});

describe("addNoteSchema", () => {
  it("accepts note with body and dealId", () => {
    const r = addNoteSchema.safeParse({ body: "Note content", dealId: "42" });
    expect(r.success).toBe(true);
  });

  it("rejects empty body", () => {
    const r = addNoteSchema.safeParse({ body: "" });
    expect(r.success).toBe(false);
  });
});

// ============================================================
// Domain Validation Tests
// ============================================================

describe("isValidPipedriveDomain", () => {
  it("accepts standard domain", () => {
    expect(isValidPipedriveDomain("company.pipedrive.com")).toBe(true);
  });

  it("accepts domain with https prefix", () => {
    expect(isValidPipedriveDomain("https://company.pipedrive.com")).toBe(true);
  });

  it("accepts api.pipedrive.com", () => {
    expect(isValidPipedriveDomain("api.pipedrive.com")).toBe(true);
  });

  it("rejects non-pipedrive domain (SSRF)", () => {
    expect(isValidPipedriveDomain("evil.com")).toBe(false);
  });

  it("rejects localhost", () => {
    expect(isValidPipedriveDomain("localhost")).toBe(false);
  });

  it("rejects domain with path traversal", () => {
    expect(isValidPipedriveDomain("evil.com/.pipedrive.com")).toBe(false);
  });

  it("rejects subdomain injection", () => {
    expect(isValidPipedriveDomain("pipedrive.com.evil.com")).toBe(false);
  });

  it("rejects IP address", () => {
    expect(isValidPipedriveDomain("127.0.0.1")).toBe(false);
  });
});

// ============================================================
// Error Sanitization Tests
// ============================================================

// ============================================================
// Auth Mode Auto-Detection Tests
// ============================================================

function detectAuthMode(token: string): "api_token" | "oauth" {
  return token.length > 60 || token.includes(".") ? "oauth" : "api_token";
}

describe("auth mode detection", () => {
  it("detects short hex as api_token", () => {
    expect(detectAuthMode("abc123def456")).toBe("api_token");
  });

  it("detects long token as oauth", () => {
    expect(detectAuthMode("a".repeat(61))).toBe("oauth");
  });

  it("detects JWT-like token (with dots) as oauth", () => {
    expect(detectAuthMode("eyJhbGciOiJIUzI1NiJ9.payload.signature")).toBe("oauth");
  });

  it("detects standard Pipedrive API key as api_token", () => {
    expect(detectAuthMode("9tnf5zrrzt3kfqvlzg5ypw")).toBe("api_token");
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts api_token in query string", () => {
    const msg = sanitizeErrorMessage("Error at https://api.pipedrive.com?api_token=abc123def456");
    expect(msg).not.toContain("abc123def456");
    expect(msg).toContain("api_token=***");
  });

  it("redacts Bearer token", () => {
    const msg = sanitizeErrorMessage("Authorization: Bearer sk-1234567890abcdef");
    expect(msg).toContain("Authorization: Bearer ***");
  });

  it("redacts long hex strings (potential tokens)", () => {
    const hex = "a".repeat(40);
    const msg = sanitizeErrorMessage(`Error with token ${hex}`);
    expect(msg).toContain("[REDACTED]");
    expect(msg).not.toContain(hex);
  });

  it("truncates long messages", () => {
    const msg = sanitizeErrorMessage("x".repeat(500));
    expect(msg.length).toBeLessThanOrEqual(300);
  });

  it("leaves safe messages untouched", () => {
    const msg = sanitizeErrorMessage("Deal not found");
    expect(msg).toBe("Deal not found");
  });
});
