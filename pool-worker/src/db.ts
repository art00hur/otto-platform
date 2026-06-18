import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// We import the schema source directly since both packages share it
import {
  pgTable, text, timestamp, boolean, integer, pgEnum, uuid, index,
} from "drizzle-orm/pg-core";

// ---- Re-declare schema inline to avoid cross-package import issues ----
// In production, extract to a shared DB package. For MVP, duplication is fine.

export const instanceStatusEnum = pgEnum("instance_status", [
  "provisioning", "installing", "ready", "assigning", "active", "error", "recycling",
]);
export const vpsProviderEnum = pgEnum("vps_provider", ["hetzner", "digitalocean"]);
export const aiModelEnum = pgEnum("ai_model", [
  "claude-sonnet-4-5", "claude-opus-4-5", "gpt-5.2", "gemini-3-flash",
]);
export const channelEnum = pgEnum("channel", ["whatsapp", "telegram", "discord"]);

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id"),
    provider: vpsProviderEnum("provider").notNull(),
    provider_instance_id: text("provider_instance_id").notNull(),
    ip_address: text("ip_address").notNull(),
    ssh_private_key_enc: text("ssh_private_key_enc"),
    status: instanceStatusEnum("status").notNull().default("provisioning"),
    model: aiModelEnum("model"),
    channel: channelEnum("channel"),
    gateway_token_enc: text("gateway_token_enc"),
    gateway_port: integer("gateway_port"),
    openrouter_key_hash: text("openrouter_key_hash"),
    openclaw_version: text("openclaw_version"),
    region: text("region").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    assigned_at: timestamp("assigned_at", { withTimezone: true }),
    last_health_check: timestamp("last_health_check", { withTimezone: true }),
    health_ok: boolean("health_ok").default(true),
    last_error: text("last_error"),
    error_count: integer("error_count").default(0),
  },
  (table) => [
    index("idx_instances_status").on(table.status),
    index("idx_instances_user").on(table.user_id),
  ]
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id"),
    instance_id: uuid("instance_id"),
    plan: text("plan"),
    status: text("status"),
  }
);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = postgres(connectionString, { max: 5 });
export const db = drizzle(client, { schema: { instances, subscriptions } });
