/**
 * CRM Connector Types
 * Normalized interfaces and types for CRM integrations (Hubspot, Pipedrive, etc.)
 */

// ============================================================================
// CORE DOMAIN TYPES
// ============================================================================

/**
 * Normalized stage in a sales pipeline
 */
export interface Stage {
  id: string;
  name: string;
  order: number;
  archived: boolean;
}

/**
 * Normalized sales pipeline
 */
export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
  archived: boolean;
}

/**
 * Normalized deal/opportunity
 */
export interface Deal {
  id: string;
  title: string;
  amount: number;
  currency: string;
  pipelineId: string;
  stageId: string;
  stageName: string;
  ownerId: string | null;
  ownerName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  description: string | null;
  closeDate: string | null; // ISO 8601
  probability: number; // 0-100
  source: string | null;
  customProperties: Record<string, unknown>;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  archivedAt: string | null; // ISO 8601
}

/**
 * Normalized organization/company
 */
export interface Organization {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employees: number | null;
  annualRevenue: number | null;
  description: string | null;
  customProperties: Record<string, unknown>;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  archivedAt: string | null; // ISO 8601
}

/**
 * Normalized contact/person
 */
export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  organizationId: string | null;
  organizationName: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  description: string | null;
  customProperties: Record<string, unknown>;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  archivedAt: string | null; // ISO 8601
}

/**
 * Normalized activity (call, email, meeting, etc.)
 */
export interface Activity {
  id: string;
  type: "call" | "email" | "meeting" | "task" | "note" | "other";
  subject: string;
  body: string | null;
  activityDate: string; // ISO 8601
  duration: number | null; // minutes
  ownerId: string | null;
  ownerName: string | null;
  contactIds: string[];
  dealIds: string[];
  organizationIds: string[];
  customProperties: Record<string, unknown>;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Normalized note attached to deal/contact/org
 */
export interface Note {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  dealId: string | null;
  contactId: string | null;
  organizationId: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Change event for tracking CRM updates
 */
export interface ChangeEvent {
  id: string;
  entityType: "deal" | "contact" | "organization" | "activity" | "note";
  entityId: string;
  action: "created" | "updated" | "deleted" | "merged";
  changedFields: Record<string, { oldValue: unknown; newValue: unknown }>;
  changedBy: string | null;
  changedAt: string; // ISO 8601
}

// ============================================================================
// FILTER TYPES
// ============================================================================

/**
 * Filters for deal listing
 */
export interface DealFilters {
  pipelineId?: string;
  stageId?: string;
  ownerId?: string;
  organizationId?: string;
  minAmount?: number;
  maxAmount?: number;
  searchText?: string;
  closeDateFrom?: string; // ISO 8601
  closeDateTo?: string; // ISO 8601
  archived?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Filters for organization listing
 */
export interface OrgFilters {
  searchText?: string;
  industry?: string;
  minEmployees?: number;
  maxEmployees?: number;
  domain?: string;
  archived?: boolean;
  limit?: number;
  offset?: number;
}

// ============================================================================
// INPUT TYPES
// ============================================================================

/**
 * Input for creating a new contact
 */
export interface NewContact {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  title?: string;
  organizationId?: string;
  address?: string;
  city?: string;
  country?: string;
  postalCode?: string;
  description?: string;
  customProperties?: Record<string, unknown>;
}

/**
 * Input for creating a new activity
 */
export interface NewActivity {
  type: "call" | "email" | "meeting" | "task" | "note" | "other";
  subject: string;
  body?: string;
  activityDate: string; // ISO 8601
  duration?: number; // minutes
  ownerId?: string;
  contactIds?: string[];
  dealIds?: string[];
  organizationIds?: string[];
  customProperties?: Record<string, unknown>;
}

// ============================================================================
// CONNECTOR INTERFACE
// ============================================================================

/**
 * CRM Connector interface
 * Defines standard methods for interacting with any CRM system
 */
export interface CRMConnector {
  /**
   * Authenticate and initialize the connector
   */
  initialize(): Promise<void>;

  /**
   * List all pipelines
   */
  listPipelines(): Promise<Pipeline[]>;

  /**
   * List deals with optional filters
   */
  listDeals(filters?: DealFilters): Promise<Deal[]>;

  /**
   * Get a single deal by ID
   */
  getDeal(dealId: string): Promise<Deal | null>;

  /**
   * Update deal fields
   */
  updateDeal(
    dealId: string,
    updates: Partial<Deal>
  ): Promise<Deal>;

  /**
   * Search contacts by name, email, phone, or custom properties
   */
  searchContacts(
    query: string,
    limit?: number
  ): Promise<Contact[]>;

  /**
   * Get a single contact by ID
   */
  getContact(contactId: string): Promise<Contact | null>;

  /**
   * Create a new contact
   */
  createContact(input: NewContact): Promise<Contact>;

  /**
   * List organizations with optional filters
   */
  listOrganizations(filters?: OrgFilters): Promise<Organization[]>;

  /**
   * Create a new activity (call, email, meeting, etc.)
   */
  createActivity(input: NewActivity): Promise<Activity>;

  /**
   * Add a note to a deal, contact, or organization
   */
  addNote(
    body: string,
    options: {
      dealId?: string;
      contactId?: string;
      organizationId?: string;
    }
  ): Promise<Note>;

  /**
   * Get recent changes to CRM data
   */
  getRecentChanges(
    since: string, // ISO 8601 timestamp
    limit?: number
  ): Promise<ChangeEvent[]>;
}
