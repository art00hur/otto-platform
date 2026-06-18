-- Migration 003: CRM Connections + Audit Log
-- Run on Neon: psql $DATABASE_URL -f 003_crm_connections.sql

-- Enum for CRM providers
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'crm_provider') THEN
    CREATE TYPE crm_provider AS ENUM ('pipedrive', 'hubspot', 'salesforce');
  END IF;
END$$;

-- CRM connections table — stores encrypted API tokens
CREATE TABLE IF NOT EXISTS crm_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  provider crm_provider NOT NULL,
  api_token_enc TEXT NOT NULL,           -- AES-256-GCM encrypted
  api_base_url TEXT,                     -- For self-hosted / custom domain CRM instances
  metadata JSONB DEFAULT '{}',           -- Provider-specific config
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(instance_id, provider)          -- One connection per provider per instance
);

CREATE INDEX IF NOT EXISTS idx_crm_instance ON crm_connections(instance_id);
CREATE INDEX IF NOT EXISTS idx_crm_provider ON crm_connections(instance_id, provider);

-- CRM audit log — tracks all CRM operations for security compliance
CREATE TABLE IF NOT EXISTS crm_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider crm_provider NOT NULL,
  action TEXT NOT NULL,                  -- e.g., "listDeals", "updateDeal", "connect"
  entity_type TEXT,                      -- e.g., "deal", "contact", "organization"
  entity_id TEXT,                        -- CRM entity ID
  success BOOLEAN NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_audit_instance ON crm_audit_log(instance_id);
CREATE INDEX IF NOT EXISTS idx_crm_audit_created ON crm_audit_log(created_at);

-- Auto-cleanup: audit logs older than 90 days (optional, run periodically)
-- DELETE FROM crm_audit_log WHERE created_at < now() - INTERVAL '90 days';
