import { logger } from "../../utils/logger.js";
import type { ChannelProvider, IncomingMessage } from "./types.js";

// ============================================================
// Telegram Bot API Provider
//
// Implements ChannelProvider for Telegram.
// Each Otto client instance has its own bot (white-label).
// The bot token is stored encrypted in messaging_channels.
// ============================================================

const TELEGRAM_API = "https://api.telegram.org";

export class TelegramProvider implements ChannelProvider {
  readonly name = "telegram" as const;
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  private async apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${TELEGRAM_API}/bot${this.botToken}/${method}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      logger.error({ method, status: response.status, text }, "Telegram API error");
      throw new Error(`Telegram API ${method} failed: ${response.status}`);
    }

    return response.json();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    // Strip heavy Markdown that Telegram often chokes on (tables, triple backticks)
    // Keep basic formatting (bold, italic) which Telegram handles well
    const cleaned = text
      .replace(/\|[^\n]+\|/g, (match) => match.replace(/\|/g, " ").replace(/[-:]+/g, "").trim())
      .replace(/```[a-z]*\n?/g, "")
      .replace(/```/g, "");

    // Split conservatively (3500 chars) to leave room for Telegram parsing overhead
    const chunks = splitMessage(cleaned, 3500);

    for (const chunk of chunks) {
      // Try with Markdown first
      const sent = await this.apiCall("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "Markdown",
      }).catch(() => null);

      if (sent) continue;

      // Fallback: strip ALL markdown and send plain
      const plain = chunk
        .replace(/\*\*/g, "").replace(/\*/g, "")
        .replace(/`/g, "").replace(/#{1,3}\s/g, "");

      const subChunks = splitMessage(plain, 4000);
      for (const sub of subChunks) {
        await this.apiCall("sendMessage", {
          chat_id: chatId,
          text: sub,
        }).catch((err) => {
          logger.error({ chatId, len: sub.length, err: (err as Error).message }, "Failed to send Telegram message");
        });
      }
    }
  }

  async sendTypingAction(chatId: string): Promise<void> {
    await this.apiCall("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    }).catch((err) => {
      logger.warn({ err, chatId }, "Failed to send typing action");
    });
  }

  parseWebhook(body: unknown): IncomingMessage | null {
    const update = body as TelegramUpdate;
    const message = update?.message;
    if (!message?.text || !message?.chat?.id) return null;

    return {
      chatId: String(message.chat.id),
      text: message.text,
      provider: "telegram",
      raw: body,
    };
  }

  /**
   * Register the webhook URL with Telegram.
   * Called once when the bot is set up.
   */
  async setWebhook(url: string): Promise<void> {
    await this.apiCall("setWebhook", { url });
    logger.info({ url }, "Telegram webhook registered");
  }

  /**
   * Get bot info (username, etc.)
   */
  async getMe(): Promise<{ username: string; firstName: string }> {
    const result = await this.apiCall("getMe", {}) as any;
    return {
      username: result.result?.username || "",
      firstName: result.result?.first_name || "",
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen; // No good newline, hard split
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

// ============================================================
// Telegram Types (minimal, what we need)
// ============================================================

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}
