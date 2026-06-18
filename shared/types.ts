// ============================================================
// Claw — Shared Types
// ============================================================

// ----- Enums -----

export type InstanceStatus =
  | "provisioning"  // VPS being created by pool worker
  | "installing"    // OpenClaw being installed
  | "ready"         // In pool, waiting to be assigned
  | "assigning"     // Being configured for a specific user
  | "active"        // Live, user is using it
  | "error"         // Something broke
  | "recycling";    // Being wiped for return to pool or destruction

export type VpsProvider = "hetzner" | "digitalocean";

export type AiModel =
  | "claude-sonnet-4-5"
  | "claude-opus-4-5"
  | "gpt-5.2"
  | "gemini-3-flash";

export type Channel = "whatsapp" | "telegram" | "discord";

export type SubPlan = "starter" | "pro";
export type SubStatus = "active" | "cancelled" | "past_due" | "trialing";

// ----- Database Models -----

export interface User {
  id: string;
  email: string;
  google_id: string | null;
  whatsapp_number: string | null;
  created_at: Date;
  stripe_customer_id: string | null;
}

export interface Instance {
  id: string;
  user_id: string | null;           // null = in pool, assigned = active
  provider: VpsProvider;
  provider_instance_id: string;     // Hetzner server ID, DO droplet ID
  ip_address: string;
  ssh_key_id: string | null;        // Reference to SSH key used
  status: InstanceStatus;
  model: AiModel | null;
  channel: Channel | null;
  gateway_token: string | null;     // Encrypted
  openclaw_version: string | null;
  region: string;
  created_at: Date;
  assigned_at: Date | null;
  last_health_check: Date | null;
  health_ok: boolean;
}

export interface Subscription {
  id: string;
  user_id: string;
  instance_id: string | null;
  stripe_subscription_id: string;
  plan: SubPlan;
  status: SubStatus;
  ai_credits_used: number;         // Tokens used this period
  ai_credits_limit: number;        // Token limit for the plan
  current_period_start: Date;
  current_period_end: Date;
  created_at: Date;
}

// ----- API Request/Response Types -----

export interface SetupRequest {
  email: string;
  whatsapp_number: string;
  model: AiModel;
  channel: Channel;
}

export interface ProvisionResponse {
  instance_id: string;
  status: InstanceStatus;
  estimated_seconds: number;
}

export interface SetupProgress {
  step: SetupStep;
  status: "pending" | "running" | "done" | "error";
  message: string;
  timestamp: number;
}

export type SetupStep =
  | "assign_instance"
  | "configure_model"
  | "configure_channel"
  | "harden_security"
  | "start_gateway"
  | "generate_qr"
  | "verify_connection";

export const SETUP_STEPS: SetupStep[] = [
  "assign_instance",
  "configure_model",
  "configure_channel",
  "harden_security",
  "start_gateway",
  "generate_qr",
  "verify_connection",
];

// ----- Config Types -----

export interface OpenClawConfig {
  channels: {
    whatsapp?: {
      selfChatMode: boolean;
      dmPolicy: "allowlist" | "pairing";
      allowFrom: string[];
      groupPolicy: "deny" | "allowlist";
      configWrites: boolean;
    };
    telegram?: {
      enabled: boolean;
    };
  };
  tools: {
    elevated: string[];
    sandbox: boolean;
  };
  skills: {
    autoInstall: boolean;
    requireApproval: boolean;
  };
  privacy: {
    telemetry: boolean;
    localStorageOnly: boolean;
  };
}

// ----- Pool Worker Types -----

export interface PoolConfig {
  target_ready_count: number;    // How many ready instances to maintain
  provider: VpsProvider;
  region: string;
  instance_type: string;         // e.g. "cx23" for Hetzner
  max_provision_concurrent: number;
}

export const DEFAULT_POOL_CONFIG: PoolConfig = {
  target_ready_count: 10,
  provider: "hetzner",
  region: "nbg1",               // Nuremberg, cheapest
  instance_type: "cx23",         // 2 vCPU, 4GB RAM, €3.49/mo
  max_provision_concurrent: 3,
};
