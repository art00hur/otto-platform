// ============================================================
// Multi-Channel Messaging Types
//
// Abstraction layer for Telegram, WhatsApp, and future channels.
// Each provider implements ChannelProvider.
// The router uses these types to bridge incoming messages
// to the OpenClaw agent and send responses back.
// ============================================================

export interface IncomingMessage {
  /** Provider-specific chat/conversation ID */
  chatId: string;
  /** The user's message text */
  text: string;
  /** Provider name */
  provider: "telegram" | "whatsapp";
  /** Raw provider payload (for debugging) */
  raw?: unknown;
}

export interface OutgoingMessage {
  chatId: string;
  text: string;
  provider: "telegram" | "whatsapp";
}

export interface ChannelProvider {
  readonly name: "telegram" | "whatsapp";

  /** Send a text message to a chat */
  sendMessage(chatId: string, text: string): Promise<void>;

  /** Send a "typing" indicator */
  sendTypingAction(chatId: string): Promise<void>;

  /** Parse an incoming webhook payload into an IncomingMessage (or null if not a text message) */
  parseWebhook(body: unknown): IncomingMessage | null;
}

/** Stored in messaging_channels.config (JSONB, encrypted bot token stored separately) */
export interface TelegramChannelConfig {
  botUsername: string;
  webhookUrl: string;
}

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  verifyToken: string;
}

/** Link code for associating a Telegram/WhatsApp chat to an Otto user */
export interface LinkCode {
  code: string;
  userId: string;
  instanceId: string;
  channelId: string;
  createdAt: number; // timestamp ms
}
