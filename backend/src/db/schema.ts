import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  uuid,
  index,
} from "drizzle-orm/pg-core";

// ============================================================
// Enums
// ============================================================

export const instanceStatusEnum = pgEnum("instance_status", [
  "provisioning",
  "installing",
  "ready",
  "assigning",
  "active",
  "error",
  "recycling",
]);

export const vpsProviderEnum = pgEnum("vps_provider", [
  "hetzner",
  "digitalocean",
]);

export const aiModelEnum = pgEnum("ai_model", [
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "gpt-5.2",
  "gemini-3-flash",
]);

export const channelEnum = pgEnum("channel", [
  "whatsapp",
  "telegram",
  "discord",
]);

export const subPlanEnum = pgEnum("sub_plan", ["free", "starter", "pro", "ultra"]);

export const subStatusEnum = pgEnum("sub_status", [
  "active",
  "cancelled",
  "past_due",
  "trialing",
]);

// ============================================================
// Tables
// ============================================================

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  google_id: text("google_id").unique(),
  password_hash: text("password_hash"),  // bcrypt hash, nullable (Google-only users won't have one)
  whatsapp_number: text("whatsapp_number"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  stripe_customer_id: text("stripe_customer_id").unique(),
});

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    provider: vpsProviderEnum("provider").notNull(),
    provider_instance_id: text("provider_instance_id").notNull(),
    ip_address: text("ip_address").notNull(),
    // SSH private key — encrypted at rest
    ssh_private_key_enc: text("ssh_private_key_enc"),
    status: instanceStatusEnum("status").notNull().default("provisioning"),
    model: aiModelEnum("model"),
    channel: channelEnum("channel"),
    // OpenClaw gateway token — encrypted at rest
    gateway_token_enc: text("gateway_token_enc"),
    // OpenClaw gateway port (random 20000-60000, loopback only)
    gateway_port: integer("gateway_port"),
    openrouter_key_hash: text("openrouter_key_hash"),
    // Proxy auth token — unused, VPS instances talk directly to OpenRouter
    proxy_token: text("proxy_token"),
    openclaw_version: text("openclaw_version"),
    region: text("region").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    last_health_check: timestamp("last_health_check", { withTimezone: true }),
    health_ok: boolean("health_ok").default(true),
    // Agent hierarchy — JSON: { "agentId": { "reports_to": "otherAgentId" }, ... }
    agent_hierarchy: jsonb("agent_hierarchy").default("{}"),
    // Error tracking
    last_error: text("last_error"),
    error_count: integer("error_count").default(0),
  },
  (table) => [
    index("idx_instances_status").on(table.status),
    index("idx_instances_user").on(table.user_id),
    index("idx_instances_health").on(table.health_ok),
  ]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instance_id: uuid("instance_id").references(() => instances.id, {
      onDelete: "set null",
    }),
    stripe_subscription_id: text("stripe_subscription_id").unique(),
    plan: subPlanEnum("plan").notNull(),
    status: subStatusEnum("status").notNull().default("trialing"),
    ai_credits_used: integer("ai_credits_used").notNull().default(0),
    ai_credits_limit: integer("ai_credits_limit").notNull(),
    // Bonus credits purchased via top-ups (in cents)
    ai_credits_bonus: integer("ai_credits_bonus").notNull().default(0),
    // Extra agent slots purchased via top-ups
    extra_agent_slots: integer("extra_agent_slots").notNull().default(0),
    current_period_start: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    current_period_end: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_subs_user").on(table.user_id),
    index("idx_subs_stripe").on(table.stripe_subscription_id),
  ]
);

// ============================================================
// Credit top-ups — one-time purchases for extra AI credits
// ============================================================

export const creditTopups = pgTable(
  "credit_topups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subscription_id: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    stripe_payment_id: text("stripe_payment_id").notNull(),
    amount_paid_cents: integer("amount_paid_cents").notNull(),    // What they paid ($5 = 500)
    credits_granted_cents: integer("credits_granted_cents").notNull(), // Credits they got
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_topups_user").on(table.user_id),
  ]
);

// ============================================================
// Setup sessions — tracks the multi-step setup flow per user
// ============================================================

// ============================================================
// CRM connections — encrypted API tokens for external CRMs
// ============================================================

export const crmProviderEnum = pgEnum("crm_provider", [
  "pipedrive",
  "hubspot",
  "salesforce",
]);

export const crmConnections = pgTable(
  "crm_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instance_id: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    provider: crmProviderEnum("provider").notNull(),
    // API token — encrypted at rest with AES-256-GCM (same as SSH keys)
    api_token_enc: text("api_token_enc").notNull(),
    // Base URL for self-hosted CRM instances (e.g., custom Salesforce domain)
    api_base_url: text("api_base_url"),
    // Provider-specific config (e.g., OAuth refresh token, company domain)
    metadata: jsonb("metadata").default("{}"),
    enabled: boolean("enabled").notNull().default(true),
    last_sync_at: timestamp("last_sync_at", { withTimezone: true }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_crm_instance").on(table.instance_id),
    index("idx_crm_provider").on(table.instance_id, table.provider),
  ]
);

// ============================================================
// CRM audit log — tracks all CRM operations for security
// ============================================================

export const crmAuditLog = pgTable(
  "crm_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instance_id: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: crmProviderEnum("provider").notNull(),
    action: text("action").notNull(), // e.g., "listDeals", "updateDeal", "createContact"
    entity_type: text("entity_type"), // e.g., "deal", "contact"
    entity_id: text("entity_id"), // CRM entity ID
    success: boolean("success").notNull(),
    error_message: text("error_message"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_crm_audit_instance").on(table.instance_id),
    index("idx_crm_audit_created").on(table.created_at),
  ]
);

// ============================================================
// Messaging channels — Telegram/WhatsApp per-instance connections
// ============================================================

export const messagingChannels = pgTable(
  "messaging_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instance_id: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    provider: channelEnum("provider").notNull(),
    token_enc: text("token_enc").notNull(),
    config: jsonb("config").default("{}"),
    enabled: boolean("enabled").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_msg_channel_instance").on(table.instance_id),
    index("idx_msg_channel_provider").on(table.instance_id, table.provider),
  ]
);

export const messagingLinks = pgTable(
  "messaging_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel_id: uuid("channel_id")
      .notNull()
      .references(() => messagingChannels.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instance_id: uuid("instance_id")
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    external_chat_id: text("external_chat_id").notNull(),
    link_code: text("link_code"),
    link_code_expires_at: timestamp("link_code_expires_at", { withTimezone: true }),
    linked_at: timestamp("linked_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_msg_link_channel").on(table.channel_id),
    index("idx_msg_link_external").on(table.external_chat_id),
    index("idx_msg_link_instance").on(table.instance_id),
  ]
);

// ============================================================
// OAuth integrations — stores OAuth2 tokens for external services
// ============================================================

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "pipedrive", "hubspot", etc.
    access_token_enc: text("access_token_enc").notNull(), // AES-256-GCM encrypted
    refresh_token_enc: text("refresh_token_enc").notNull(), // AES-256-GCM encrypted
    token_expires_at: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    provider_data: jsonb("provider_data").default("{}"), // company_domain, user name, etc.
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_integrations_user").on(table.user_id),
    index("idx_integrations_user_provider").on(table.user_id, table.provider),
  ]
);

// ============================================================
// Setup sessions — tracks the multi-step setup flow per user
// ============================================================

export const setupSessions = pgTable("setup_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  instance_id: uuid("instance_id").references(() => instances.id),
  current_step: text("current_step").notNull().default("assign_instance"),
  steps_completed: text("steps_completed").array().notNull().default([]),
  error_message: text("error_message"),
  qr_code_data: text("qr_code_data"), // Base64 QR for WhatsApp linking
  started_at: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completed_at: timestamp("completed_at", { withTimezone: true }),
});

// ============================================================
// Prospects — Mini CRM for tracking contacted clients
// ============================================================

export const prospectStatusEnum = pgEnum("prospect_status", [
  "new",
  "contacted",
  "demo_scheduled",
  "demo_done",
  "negotiating",
  "won",
  "lost",
  "churned",
]);

export const prospectSourceEnum = pgEnum("prospect_source", [
  "inbound",
  "outbound",
  "referral",
  "linkedin",
  "website",
  "event",
  "other",
]);

export const prospects = pgTable(
  "prospects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    company: text("company"),
    email: text("email"),
    phone: text("phone"),
    linkedin: text("linkedin"),
    status: prospectStatusEnum("status").notNull().default("new"),
    source: prospectSourceEnum("source").notNull().default("inbound"),
    // Pipeline tracking
    deal_value: integer("deal_value"), // Monthly value in cents
    next_action: text("next_action"),
    next_action_date: timestamp("next_action_date", { withTimezone: true }),
    last_contact_date: timestamp("last_contact_date", { withTimezone: true }),
    // Link to user if they signed up
    user_id: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    // Notes (JSON array of timestamped notes)
    notes: jsonb("notes").default("[]"),
    // Metadata
    tags: text("tags").array().default([]),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_prospects_status").on(table.status),
    index("idx_prospects_source").on(table.source),
    index("idx_prospects_next_action").on(table.next_action_date),
  ]
);
