import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramProvider } from "../messaging/telegram.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(data: unknown = {}) {
  return new Response(JSON.stringify({ ok: true, result: data }), { status: 200 });
}

function errorResponse(status: number, text: string) {
  return new Response(text, { status });
}

describe("TelegramProvider", () => {
  let provider: TelegramProvider;

  beforeEach(() => {
    provider = new TelegramProvider("test-bot-token");
    mockFetch.mockReset();
  });

  describe("sendMessage", () => {
    it("sends a text message", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await provider.sendMessage("123", "Hello");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/bot" + "test-bot-token" + "/sendMessage");
      const body = JSON.parse(opts.body);
      expect(body.chat_id).toBe("123");
      expect(body.text).toBe("Hello");
    });

    it("splits messages longer than 4096 chars", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(okResponse()));

      const longText = "A".repeat(5000);
      await provider.sendMessage("123", longText);

      expect(mockFetch.mock.calls.length).toBe(2);
    });

    it("falls back to no markdown on parse error", async () => {
      // First call fails (markdown parse error), second succeeds
      mockFetch
        .mockResolvedValueOnce(errorResponse(400, "Bad Request: can't parse"))
        .mockResolvedValueOnce(okResponse());

      await provider.sendMessage("123", "**bad markdown");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Second call should not have parse_mode
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body2.parse_mode).toBeUndefined();
    });
  });

  describe("sendTypingAction", () => {
    it("sends typing action", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await provider.sendTypingAction("123");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("sendChatAction");
    });

    it("does not throw on failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      // Should not throw
      await provider.sendTypingAction("123");
    });
  });

  describe("parseWebhook", () => {
    it("parses a text message", () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 456, type: "private" },
          text: "Hello agent",
          date: 1234567890,
        },
      };

      const result = provider.parseWebhook(update);
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe("456");
      expect(result!.text).toBe("Hello agent");
      expect(result!.provider).toBe("telegram");
    });

    it("returns null for non-text messages", () => {
      const update = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 456, type: "private" },
          photo: [{ file_id: "abc" }],
          date: 1234567890,
        },
      };

      expect(provider.parseWebhook(update)).toBeNull();
    });

    it("returns null for empty body", () => {
      expect(provider.parseWebhook(null)).toBeNull();
      expect(provider.parseWebhook(undefined)).toBeNull();
      expect(provider.parseWebhook({})).toBeNull();
    });
  });

  describe("getMe", () => {
    it("returns bot info", async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ username: "OttoBot", first_name: "Otto" }));

      const info = await provider.getMe();
      expect(info.username).toBe("OttoBot");
      expect(info.firstName).toBe("Otto");
    });
  });

  describe("setWebhook", () => {
    it("registers webhook URL", async () => {
      mockFetch.mockResolvedValueOnce(okResponse());

      await provider.setWebhook("https://example.com/webhook");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.url).toBe("https://example.com/webhook");
    });
  });
});
