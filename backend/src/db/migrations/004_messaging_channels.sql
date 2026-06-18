-- Migration 004: Messaging channels (Telegram/WhatsApp)

CREATE TABLE IF NOT EXISTS messaging_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  provider channel NOT NULL,
  token_enc TEXT NOT NULL,
  config JSONB DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_channel_instance ON messaging_channels(instance_id);
CREATE INDEX IF NOT EXISTS idx_msg_channel_provider ON messaging_channels(instance_id, provider);

CREATE TABLE IF NOT EXISTS messaging_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES messaging_channels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  external_chat_id TEXT NOT NULL,
  link_code TEXT,
  link_code_expires_at TIMESTAMPTZ,
  linked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_link_channel ON messaging_links(channel_id);
CREATE INDEX IF NOT EXISTS idx_msg_link_external ON messaging_links(external_chat_id);
CREATE INDEX IF NOT EXISTS idx_msg_link_instance ON messaging_links(instance_id);
