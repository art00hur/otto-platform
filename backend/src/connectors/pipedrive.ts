import { logger } from "../utils/logger.js";
import type {
  CRMConnector,
  Deal,
  Contact,
  Organization,
  Activity,
  Note,
  Pipeline,
  Stage,
  DealFilters,
  OrgFilters,
  NewContact,
  NewActivity,
  ChangeEvent,
} from "./types.js";

const BASE_URL = "https://api.pipedrive.com/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 15_000; // 15s timeout on all API calls
const MAX_LIMIT = 500; // Max items per request

/**
 * Validate an entity ID to prevent path traversal.
 * Pipedrive IDs are always positive integers.
 */
function validateEntityId(id: string): string {
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid entity ID: must be a positive integer`);
  }
  return id;
}

/**
 * Clamp a limit value to prevent excessive API calls
 */
function clampLimit(limit: number | undefined, defaultVal = 100): number {
  const n = limit ?? defaultVal;
  return Math.max(1, Math.min(n, MAX_LIMIT));
}

/**
 * Safe set of allowed custom property key patterns.
 * Pipedrive custom fields use hex hashes like "abc123def..."
 * Block anything that looks like a standard field override.
 */
const BLOCKED_CUSTOM_KEYS = new Set([
  "api_token", "api_key", "access_token", "token",
  "password", "secret", "authorization",
]);

/**
 * Pipedrive API Response wrapper (all responses follow this pattern)
 */
interface PipedriveResponse<T> {
  success: boolean;
  data: T;
  additional_data?: unknown;
  error?: string;
}

/**
 * Helper to sleep for a given duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitize error messages to prevent token/credential leaks in logs or responses.
 */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/api_token=[^&\s]+/gi, "api_token=***")
    .replace(/token[=:]\s*[^\s&]+/gi, "token=***")
    .replace(/[Aa]uthorization[=:]\s*[Bb]earer\s+[^\s]+/g, "Authorization: Bearer ***")
    .replace(/[Aa]pi[-_]?[Kk]ey[=:]\s*[^\s&]+/g, "api_key=***")
    .replace(/[0-9a-f]{32,}/gi, "[REDACTED]")
    .slice(0, 300);
}

/**
 * PipedriveConnector implements CRMConnector using Pipedrive API v1
 */
export class PipedriveConnector implements CRMConnector {
  private token: string;
  private authMode: "api_token" | "oauth";

  /**
   * @param token - API token or OAuth access token
   * @param authMode - "api_token" sends token as query param, "oauth" sends as Bearer header.
   *                   Default: auto-detect (tokens starting with common OAuth prefixes use Bearer).
   */
  constructor(token: string, authMode?: "api_token" | "oauth") {
    this.token = token;
    // Auto-detect: OAuth access tokens are typically long base64/JWT strings,
    // API tokens are shorter hex strings. If explicitly provided, use that.
    this.authMode = authMode ?? (token.length > 60 || token.includes(".") ? "oauth" : "api_token");
  }

  /**
   * Make HTTP request to Pipedrive API with rate limit handling
   */
  private async request<T>(
    endpoint: string,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: unknown
  ): Promise<T> {
    let retries = 0;

    while (retries < MAX_RETRIES) {
      try {
        const url = new URL(`${BASE_URL}${endpoint}`);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (this.authMode === "oauth") {
          headers["Authorization"] = `Bearer ${this.token}`;
        } else {
          url.searchParams.append("api_token", this.token);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body && (method === "POST" || method === "PUT")) {
          fetchOptions.body = JSON.stringify(body);
        }

        let response: Response;
        try {
          response = await fetch(url.toString(), fetchOptions);
        } finally {
          clearTimeout(timeout);
        }

        // Handle rate limiting (429)
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY_MS;
          logger.warn(
            { endpoint, retries, delayMs },
            "Rate limited by Pipedrive, retrying"
          );
          await sleep(delayMs);
          retries++;
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Pipedrive API error (${response.status}): ${sanitizeErrorMessage(text || response.statusText)}`
          );
        }

        let data: PipedriveResponse<T>;
        try {
          data = (await response.json()) as PipedriveResponse<T>;
        } catch (parseError) {
          throw new Error(`Pipedrive returned invalid JSON for ${endpoint}`);
        }

        if (!data.success) {
          throw new Error(`Pipedrive API returned success: false - ${data.error || "Unknown error"}`);
        }

        return data.data;
      } catch (error) {
        if (retries < MAX_RETRIES - 1) {
          retries++;
          await sleep(RETRY_DELAY_MS);
        } else {
          logger.error({ endpoint, method, error }, "Pipedrive request failed");
          throw error;
        }
      }
    }

    throw new Error("Max retries exceeded for Pipedrive API request");
  }

  /**
   * Initialize connector (validate token)
   */
  async initialize(): Promise<void> {
    try {
      await this.request("/users/me");
      logger.info("Pipedrive connector initialized successfully");
    } catch (error) {
      logger.error({ error }, "Failed to initialize Pipedrive connector");
      throw error;
    }
  }

  /**
   * List pipelines with stages
   */
  async listPipelines(): Promise<Pipeline[]> {
    try {
      // Get all pipelines
      const pipelines = await this.request<PipedrivePipeline[]>("/pipelines");

      // Get all stages
      const stages = await this.request<PipedriveStage[]>("/stages");

      // Map to normalized format
      return pipelines.map((p) => ({
        id: String(p.id),
        name: p.name,
        archived: p.archived ?? false,
        stages: stages
          .filter((s) => String(s.pipeline_id) === String(p.id))
          .map((s) => ({
            id: String(s.id),
            name: s.name,
            order: s.order_nr ?? 0,
            archived: s.archived ?? false,
          })),
      }));
    } catch (error) {
      logger.error({ error }, "Failed to list pipelines");
      throw error;
    }
  }

  /**
   * List deals with optional filters
   */
  async listDeals(filters?: DealFilters): Promise<Deal[]> {
    try {
      const params = new URLSearchParams();

      if (filters?.stageId) params.append("stage_id", filters.stageId);
      if (filters?.pipelineId) params.append("pipeline_id", filters.pipelineId);
      if (filters?.ownerId) params.append("user_id", filters.ownerId);
      if (filters?.organizationId) params.append("org_id", filters.organizationId);
      if (filters?.searchText) params.append("filter_name", filters.searchText);

      // Default sorting
      params.append("sort", "add_time DESC");

      const limit = clampLimit(filters?.limit);
      const start = Math.max(0, filters?.offset ?? 0);

      params.append("limit", String(limit));
      params.append("start", String(start));

      const queryString = params.toString();
      const endpoint = `/deals?${queryString}`;

      const deals = await this.request<PipedriveDeal[]>(endpoint);
      return deals.map((d) => this.normalizeDeal(d));
    } catch (error) {
      logger.error({ error }, "Failed to list deals");
      throw error;
    }
  }

  /**
   * Get a single deal by ID
   */
  async getDeal(dealId: string): Promise<Deal | null> {
    try {
      const safeId = validateEntityId(dealId);
      const deal = await this.request<PipedriveDeal>(`/deals/${safeId}`);
      return this.normalizeDeal(deal);
    } catch (error) {
      logger.warn({ dealId, error }, "Failed to get deal");
      return null;
    }
  }

  /**
   * Update deal fields
   */
  async updateDeal(dealId: string, updates: Partial<Deal>): Promise<Deal> {
    try {
      const body: Record<string, unknown> = {};

      if (updates.title) body.title = updates.title;
      if (updates.amount !== undefined) body.value = updates.amount;
      if (updates.stageId) body.stage_id = updates.stageId;
      if (updates.ownerId) body.user_id = updates.ownerId;
      if (updates.closeDate) body.expected_close_time = updates.closeDate;
      if (updates.description) body.notes = updates.description;

      const safeId = validateEntityId(dealId);
      const deal = await this.request<PipedriveDeal>(
        `/deals/${safeId}`,
        "PUT",
        body
      );
      return this.normalizeDeal(deal);
    } catch (error) {
      logger.error({ dealId, error }, "Failed to update deal");
      throw error;
    }
  }

  /**
   * Search contacts by name, email, or phone
   */
  async searchContacts(query: string, limit: number = 20): Promise<Contact[]> {
    try {
      const params = new URLSearchParams();
      params.append("term", query);
      params.append("limit", String(limit));

      const response = await this.request<{
        items: Array<{ item: PipedrivePerson }>;
      }>(`/persons/search?${params.toString()}`);

      if (!response.items || !Array.isArray(response.items)) {
        return [];
      }

      return response.items.map((item) => this.normalizeContact(item.item));
    } catch (error) {
      logger.warn({ query, error }, "Failed to search contacts");
      return [];
    }
  }

  /**
   * Get a single contact by ID
   */
  async getContact(contactId: string): Promise<Contact | null> {
    try {
      const safeId = validateEntityId(contactId);
      const contact = await this.request<PipedrivePerson>(`/persons/${safeId}`);
      return this.normalizeContact(contact);
    } catch (error) {
      logger.warn({ contactId, error }, "Failed to get contact");
      return null;
    }
  }

  /**
   * Create a new contact
   */
  async createContact(input: NewContact): Promise<Contact> {
    try {
      const body: Record<string, unknown> = {
        name: `${input.firstName} ${input.lastName}`.trim(),
        first_name: input.firstName,
        last_name: input.lastName,
      };

      if (input.email) body.email = [{ value: input.email, primary: true }];
      if (input.phone) body.phone = [{ value: input.phone, primary: true }];
      if (input.title) body.job_title = input.title;
      if (input.organizationId) body.org_id = input.organizationId;
      if (input.address) body.address = input.address;
      if (input.city) body.city = input.city;
      if (input.country) body.country = input.country;
      if (input.postalCode) body.postal_code = input.postalCode;
      if (input.description) body.notes = input.description;

      // Add custom properties (filter out dangerous keys)
      if (input.customProperties) {
        for (const [key, value] of Object.entries(input.customProperties)) {
          if (!BLOCKED_CUSTOM_KEYS.has(key.toLowerCase()) && value !== undefined) {
            body[key] = value;
          }
        }
      }

      const contact = await this.request<PipedrivePerson>("/persons", "POST", body);
      return this.normalizeContact(contact);
    } catch (error) {
      logger.error({ input, error }, "Failed to create contact");
      throw error;
    }
  }

  /**
   * List organizations
   */
  async listOrganizations(filters?: OrgFilters): Promise<Organization[]> {
    try {
      const params = new URLSearchParams();

      if (filters?.searchText) params.append("filter_name", filters.searchText);

      const limit = clampLimit(filters?.limit);
      const start = Math.max(0, filters?.offset ?? 0);

      params.append("limit", String(limit));
      params.append("start", String(start));

      const endpoint = `/organizations?${params.toString()}`;
      const orgs = await this.request<PipedriveOrganization[]>(endpoint);

      return orgs.map((o) => this.normalizeOrganization(o));
    } catch (error) {
      logger.error({ error }, "Failed to list organizations");
      throw error;
    }
  }

  /**
   * Create a new activity
   */
  async createActivity(input: NewActivity): Promise<Activity> {
    try {
      const typeMap: Record<string, string> = {
        call: "call",
        email: "email",
        meeting: "meeting",
        task: "task",
        note: "note",
        other: "other",
      };

      const body: Record<string, unknown> = {
        type: typeMap[input.type] || "other",
        subject: input.subject,
        due_date: input.activityDate,
      };

      if (input.body) body.note = input.body;
      if (input.ownerId) body.user_id = input.ownerId;
      if (input.duration) body.duration = input.duration;

      // Add related entities
      if (input.contactIds && input.contactIds.length > 0) {
        body.person_id = input.contactIds[0];
      }
      if (input.dealIds && input.dealIds.length > 0) {
        body.deal_id = input.dealIds[0];
      }
      if (input.organizationIds && input.organizationIds.length > 0) {
        body.org_id = input.organizationIds[0];
      }

      // Add custom properties (filter out dangerous keys)
      if (input.customProperties) {
        for (const [key, value] of Object.entries(input.customProperties)) {
          if (!BLOCKED_CUSTOM_KEYS.has(key.toLowerCase()) && value !== undefined) {
            body[key] = value;
          }
        }
      }

      const activity = await this.request<PipedriveActivity>("/activities", "POST", body);
      return this.normalizeActivity(activity);
    } catch (error) {
      logger.error({ input, error }, "Failed to create activity");
      throw error;
    }
  }

  /**
   * Add a note to a deal, contact, or organization
   */
  async addNote(
    body: string,
    options: { dealId?: string; contactId?: string; organizationId?: string }
  ): Promise<Note> {
    try {
      const requestBody: Record<string, unknown> = {
        content: body,
      };

      if (options.dealId) requestBody.deal_id = options.dealId;
      if (options.contactId) requestBody.person_id = options.contactId;
      if (options.organizationId) requestBody.org_id = options.organizationId;

      const note = await this.request<PipedriveNote>("/notes", "POST", requestBody);
      return this.normalizeNote(note);
    } catch (error) {
      logger.error({ options, error }, "Failed to add note");
      throw error;
    }
  }

  /**
   * Get recent changes to CRM data
   */
  async getRecentChanges(since: string, limit: number = 100): Promise<ChangeEvent[]> {
    try {
      const params = new URLSearchParams();
      params.append("since_timestamp", since);
      params.append("limit", String(limit));
      params.append("items", "deal,person,organization");

      const response = await this.request<{
        data: PipedriveRecent[];
      }>(`/recents?${params.toString()}`);

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map((r) => this.normalizeChangeEvent(r));
    } catch (error) {
      logger.warn({ since, error }, "Failed to get recent changes");
      return [];
    }
  }

  // =========================================================================
  // NORMALIZATION HELPERS
  // =========================================================================

  private normalizeDeal(d: PipedriveDeal): Deal {
    return {
      id: String(d.id),
      title: d.title || "",
      amount: d.value ?? 0,
      currency: d.currency || "USD",
      pipelineId: String(d.pipeline_id),
      stageId: String(d.stage_id),
      stageName: d.stage?.name || "",
      ownerId: d.user_id ? String(d.user_id) : null,
      ownerName: d.user?.name || null,
      organizationId: d.org_id ? String(d.org_id) : null,
      organizationName: d.org_name || null,
      description: d.notes || null,
      closeDate: d.expected_close_time || null,
      probability: d.probability ?? 0,
      source: d.source || null,
      customProperties: this.extractCustomProperties(d),
      createdAt: d.add_time || new Date().toISOString(),
      updatedAt: d.update_time || new Date().toISOString(),
      archivedAt: d.archived_at || null,
    };
  }

  private normalizeContact(p: PipedrivePerson): Contact {
    const email =
      Array.isArray(p.email) && p.email.length > 0
        ? typeof p.email[0] === "string"
          ? p.email[0]
          : (p.email[0] as any).value
        : typeof p.email === "string"
          ? p.email
          : null;

    const phone =
      Array.isArray(p.phone) && p.phone.length > 0
        ? typeof p.phone[0] === "string"
          ? p.phone[0]
          : (p.phone[0] as any).value
        : typeof p.phone === "string"
          ? p.phone
          : null;

    return {
      id: String(p.id),
      firstName: p.first_name || "",
      lastName: p.last_name || "",
      email: email,
      phone: phone,
      title: p.job_title || null,
      organizationId: p.org_id ? String(p.org_id) : null,
      organizationName: p.org_name || null,
      address: p.address || null,
      city: p.city || null,
      country: p.country || null,
      postalCode: p.postal_code || null,
      description: p.notes || null,
      customProperties: this.extractCustomProperties(p),
      createdAt: p.add_time || new Date().toISOString(),
      updatedAt: p.update_time || new Date().toISOString(),
      archivedAt: p.active_flag === false ? new Date().toISOString() : null,
    };
  }

  private normalizeOrganization(o: PipedriveOrganization): Organization {
    return {
      id: String(o.id),
      name: o.name || "",
      domain: o.cc_email || null,
      industry: null, // Pipedrive doesn't have standard industry field
      employees: o.people_count ?? null,
      annualRevenue: null, // Not in standard Pipedrive API
      description: o.notes || null,
      customProperties: this.extractCustomProperties(o),
      createdAt: o.add_time || new Date().toISOString(),
      updatedAt: o.update_time || new Date().toISOString(),
      archivedAt: o.active_flag === false ? new Date().toISOString() : null,
    };
  }

  private normalizeActivity(a: PipedriveActivity): Activity {
    const typeMap: Record<string, Activity["type"]> = {
      call: "call",
      email: "email",
      meeting: "meeting",
      task: "task",
      note: "note",
      other: "other",
    };

    return {
      id: String(a.id),
      type: (typeMap[a.type] || "other") as Activity["type"],
      subject: a.subject || "",
      body: a.note || null,
      activityDate: a.due_date || new Date().toISOString(),
      duration: a.duration ?? null,
      ownerId: a.user_id ? String(a.user_id) : null,
      ownerName: a.user?.name || null,
      contactIds: a.person_id ? [String(a.person_id)] : [],
      dealIds: a.deal_id ? [String(a.deal_id)] : [],
      organizationIds: a.org_id ? [String(a.org_id)] : [],
      customProperties: this.extractCustomProperties(a),
      createdAt: a.add_time || new Date().toISOString(),
      updatedAt: a.update_time || new Date().toISOString(),
    };
  }

  private normalizeNote(n: PipedriveNote): Note {
    return {
      id: String(n.id),
      body: n.content || "",
      authorId: n.user_id ? String(n.user_id) : null,
      authorName: n.user?.name || null,
      dealId: n.deal_id ? String(n.deal_id) : null,
      contactId: n.person_id ? String(n.person_id) : null,
      organizationId: n.org_id ? String(n.org_id) : null,
      createdAt: n.add_time || new Date().toISOString(),
      updatedAt: n.update_time || new Date().toISOString(),
    };
  }

  private normalizeChangeEvent(r: PipedriveRecent): ChangeEvent {
    const typeMap: Record<string, ChangeEvent["entityType"]> = {
      deal: "deal",
      person: "contact",
      organization: "organization",
      activity: "activity",
      note: "note",
    };

    return {
      id: String(r.id),
      entityType: (typeMap[r.type] || "deal") as ChangeEvent["entityType"],
      entityId: String(r.data?.id || 0),
      action: (r.data?.action || "updated") as ChangeEvent["action"],
      changedFields: {}, // Pipedrive doesn't provide field-level changes in recents
      changedBy: null,
      changedAt: r.timestamp || new Date().toISOString(),
    };
  }

  /**
   * Extract custom properties (fields not in standard normalized schema)
   */
  private extractCustomProperties(
    obj: Record<string, unknown>
  ): Record<string, unknown> {
    const standardFields = new Set([
      "id",
      "name",
      "title",
      "first_name",
      "last_name",
      "email",
      "phone",
      "org_id",
      "org_name",
      "address",
      "city",
      "country",
      "postal_code",
      "notes",
      "value",
      "currency",
      "pipeline_id",
      "stage_id",
      "user_id",
      "expected_close_time",
      "probability",
      "source",
      "add_time",
      "update_time",
      "archived_at",
      "active_flag",
      "job_title",
      "subject",
      "note",
      "type",
      "due_date",
      "duration",
      "deal_id",
      "person_id",
      "content",
      "people_count",
      "cc_email",
    ]);

    const custom: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!standardFields.has(key) && value !== null && value !== undefined) {
        custom[key] = value;
      }
    }

    return custom;
  }
}

// ============================================================================
// TYPE DEFINITIONS FOR PIPEDRIVE API RESPONSES
// ============================================================================

interface PipedrivePipeline extends Record<string, unknown> {
  id: number;
  name: string;
  archived?: boolean;
}

interface PipedriveStage extends Record<string, unknown> {
  id: number;
  name: string;
  pipeline_id: number;
  order_nr?: number;
  archived?: boolean;
}

interface PipedriveDeal extends Record<string, unknown> {
  id: number;
  title?: string;
  value?: number;
  currency?: string;
  pipeline_id: number;
  stage_id: number;
  stage?: { name: string };
  user_id?: number;
  user?: { name: string };
  org_id?: number;
  org_name?: string;
  notes?: string;
  expected_close_time?: string;
  probability?: number;
  source?: string;
  add_time?: string;
  update_time?: string;
  archived_at?: string;
}

interface PipedrivePerson extends Record<string, unknown> {
  id: number;
  first_name?: string;
  last_name?: string;
  email?: string | Array<string | { value: string; primary?: boolean }>;
  phone?: string | Array<string | { value: string; primary?: boolean }>;
  job_title?: string;
  org_id?: number;
  org_name?: string;
  address?: string;
  city?: string;
  country?: string;
  postal_code?: string;
  notes?: string;
  add_time?: string;
  update_time?: string;
  active_flag?: boolean;
}

interface PipedriveOrganization extends Record<string, unknown> {
  id: number;
  name?: string;
  people_count?: number;
  notes?: string;
  add_time?: string;
  update_time?: string;
  active_flag?: boolean;
  cc_email?: string;
}

interface PipedriveActivity extends Record<string, unknown> {
  id: number;
  type: string;
  subject?: string;
  note?: string;
  due_date?: string;
  duration?: number;
  user_id?: number;
  user?: { name: string };
  person_id?: number;
  deal_id?: number;
  org_id?: number;
  add_time?: string;
  update_time?: string;
}

interface PipedriveNote extends Record<string, unknown> {
  id: number;
  content?: string;
  user_id?: number;
  user?: { name: string };
  deal_id?: number;
  person_id?: number;
  org_id?: number;
  add_time?: string;
  update_time?: string;
}

interface PipedriveRecent {
  id: number;
  type: string;
  timestamp?: string;
  data?: {
    id: number;
    action?: string;
  };
}

// ============================================================================
// EXPORT TEST FUNCTION
// ============================================================================

/**
 * Test connection to Pipedrive API with given token.
 * @param token - API token or OAuth access token
 * @param authMode - "api_token" (query param) or "oauth" (Bearer header). Default: auto-detect.
 */
export async function testConnection(token: string, authMode?: "api_token" | "oauth"): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    const mode = authMode ?? (token.length > 60 || token.includes(".") ? "oauth" : "api_token");
    const url = new URL(`${BASE_URL}/users/me`);
    const headers: Record<string, string> = {};

    if (mode === "oauth") {
      headers["Authorization"] = `Bearer ${token}`;
    } else {
      url.searchParams.append("api_token", token);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url.toString(), { method: "GET", headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as PipedriveResponse<unknown>;

    if (!data.success) {
      return {
        ok: false,
        error: data.error || "API returned success: false",
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
