import { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "../db/index.js";
import { messagingChannels, messagingLinks, instances, subscriptions } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import { verifyJWT } from "./auth.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { TelegramProvider } from "../services/messaging/telegram.js";
import { handleMessage } from "../services/messaging/router.js";

// ============================================================
// Messaging Routes
//
// Webhook endpoints for Telegram/WhatsApp + dashboard setup APIs.
// ============================================================

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function generateLinkCode(): string {
  // 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
// Auth helper (same pattern as CRM routes)
// ============================================================

async function resolveUserInstance(
  request: { headers: { authorization?: string }; params: unknown },
  reply: any
): Promise<{ userId: string; instanceId: string } | null> {
  const { userId } = request.params as { userId: string };
  if (!isValidUUID(userId)) {
    reply.status(400).send({ error: "Invalid user ID" });
    return null;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Unauthorized" });
    return null;
  }

  const jwt = verifyJWT(authHeader.slice(7));
  if (!jwt || jwt.userId !== userId) {
    reply.status(403).send({ error: "Forbidden" });
    return null;
  }

  const rows = await db
    .select({ instanceId: instances.id, plan: subscriptions.plan })
    .from(subscriptions)
    .innerJoin(
      instances,
      and(eq(instances.id, subscriptions.instance_id), eq(instances.status, "active"))
    )
    .where(
      and(eq(subscriptions.user_id, userId), eq(subscriptions.status, "active"))
    )
    .limit(1);

  if (rows.length === 0) {
    reply.status(404).send({ error: "No active instance found" });
    return null;
  }

  return { userId, instanceId: rows[0].instanceId, plan: rows[0].plan };
}

export async function messagingRoutes(app: FastifyInstance) {

  // ──────────────────────────────────────────────────────────
  // POST /api/messaging/telegram/webhook
  // Single endpoint for all Telegram bots. Currently works for
  // single-bot setups. For multi-bot, switch to per-bot webhook
  // URLs (/webhook/{botId}) to avoid chatId collision across bots.
  // TODO: Multi-bot routing when second client activates Telegram.
  // ──────────────────────────────────────────────────────────
  app.post(
    "/messaging/telegram/webhook",
    async (request, reply) => {
      const body = request.body as any;
      if (!body?.message && !body?.callback_query) {
        return reply.status(200).send({ ok: true });
      }

      const chatId = String(body.message?.chat?.id || body.callback_query?.message?.chat?.id);
      const text = body.message?.text || "";

      if (!chatId || !text) {
        return reply.status(200).send({ ok: true });
      }

      // Handle /start command first (before any link lookup)
      if (text.startsWith("/start")) {
        return handleStartCommand(chatId, text, reply);
      }

      // Handle 6-digit link code input (BEFORE link check — unlinked users need this)
      if (/^\d{6}$/.test(text.trim())) {
        // Find a channel to respond through (any enabled Telegram channel)
        const [anyChannel] = await db
          .select()
          .from(messagingChannels)
          .where(and(
            eq(messagingChannels.provider, "telegram"),
            eq(messagingChannels.enabled, true)
          ))
          .limit(1);

        if (anyChannel) {
          const provider = new TelegramProvider(decrypt(anyChannel.token_enc));
          return handleCodeInput(chatId, text.trim(), provider, reply);
        }
        return reply.status(200).send({ ok: true });
      }

      // Find the linked user for this chat
      const [link] = await db
        .select({
          channelId: messagingLinks.channel_id,
          instanceId: messagingLinks.instance_id,
          userId: messagingLinks.user_id,
          linkedAt: messagingLinks.linked_at,
        })
        .from(messagingLinks)
        .where(and(
          eq(messagingLinks.external_chat_id, chatId),
          // Only find fully linked entries
        ))
        .limit(1);

      // Handle /unlink command
      if (text === "/unlink") {
        if (link) {
          await db
            .update(messagingLinks)
            .set({ linked_at: null, external_chat_id: "" })
            .where(eq(messagingLinks.external_chat_id, chatId));

          const ch = await getChannelForLink(link.channelId);
          if (ch) {
            const p = new TelegramProvider(decrypt(ch.token_enc));
            await p.sendMessage(chatId, "Déconnecté. Tu ne recevras plus de messages de ton agent ici.").catch(() => {});
          }
        }
        return reply.status(200).send({ ok: true });
      }

      // Not linked — ignore silently
      if (!link || !link.linkedAt) {
        return reply.status(200).send({ ok: true });
      }

      // Get the channel to find the bot token
      const channel = await getChannelForLink(link.channelId);
      if (!channel || !channel.enabled) {
        return reply.status(200).send({ ok: true });
      }

      const provider = new TelegramProvider(decrypt(channel.token_enc));

      // Route to agent (async — return 200 immediately)
      reply.status(200).send({ ok: true });

      // Process in background
      handleMessage(provider, chatId, text, link.instanceId).catch((err) => {
        logger.error({ err, chatId, instanceId: link.instanceId }, "Background message handling failed");
      });
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/messaging/telegram/setup
  // Register a Telegram bot for the user's instance
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/messaging/telegram/setup",
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      if (ctx.plan === "free") {
        return reply.status(403).send({ error: "Messaging integrations require a paid plan. Please upgrade." });
      }

      const { botToken } = request.body as { botToken?: string };
      if (!botToken || botToken.length < 30) {
        return reply.status(400).send({ error: "Invalid bot token" });
      }

      // Validate the token by calling getMe
      const provider = new TelegramProvider(botToken);
      let botInfo;
      try {
        botInfo = await provider.getMe();
      } catch {
        return reply.status(400).send({ error: "Invalid bot token — could not connect to Telegram" });
      }

      // Set webhook
      const webhookUrl = `https://api.otto-ai.co/api/messaging/telegram/webhook`;
      try {
        await provider.setWebhook(webhookUrl);
      } catch (err) {
        return reply.status(500).send({ error: "Failed to register webhook with Telegram" });
      }

      // Store (upsert)
      const existing = await db
        .select()
        .from(messagingChannels)
        .where(and(
          eq(messagingChannels.instance_id, ctx.instanceId),
          eq(messagingChannels.provider, "telegram")
        ))
        .limit(1);

      const tokenEnc = encrypt(botToken);
      const config = { botUsername: botInfo.username, webhookUrl };

      if (existing.length > 0) {
        await db
          .update(messagingChannels)
          .set({ token_enc: tokenEnc, config, enabled: true, updated_at: new Date() })
          .where(eq(messagingChannels.id, existing[0].id));
      } else {
        await db.insert(messagingChannels).values({
          instance_id: ctx.instanceId,
          provider: "telegram",
          token_enc: tokenEnc,
          config,
        });
      }

      logger.info({ instanceId: ctx.instanceId, botUsername: botInfo.username }, "Telegram bot configured");

      return {
        ok: true,
        botUsername: botInfo.username,
        botFirstName: botInfo.firstName,
      };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/messaging/link
  // Generate a 6-digit link code for Telegram/WhatsApp
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/messaging/link",
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      if (ctx.plan === "free") {
        return reply.status(403).send({ error: "Messaging integrations require a paid plan. Please upgrade." });
      }

      const { provider } = request.body as { provider?: string };
      if (provider !== "telegram" && provider !== "whatsapp") {
        return reply.status(400).send({ error: "Invalid provider" });
      }

      // Find the channel
      const [channel] = await db
        .select()
        .from(messagingChannels)
        .where(and(
          eq(messagingChannels.instance_id, ctx.instanceId),
          eq(messagingChannels.provider, provider),
          eq(messagingChannels.enabled, true)
        ))
        .limit(1);

      if (!channel) {
        return reply.status(404).send({ error: `No ${provider} channel configured` });
      }

      // Generate code
      const code = generateLinkCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

      // Upsert link (one link per user per channel)
      const existingLink = await db
        .select()
        .from(messagingLinks)
        .where(and(
          eq(messagingLinks.channel_id, channel.id),
          eq(messagingLinks.user_id, ctx.userId)
        ))
        .limit(1);

      if (existingLink.length > 0) {
        await db
          .update(messagingLinks)
          .set({
            link_code: code,
            link_code_expires_at: expiresAt,
            linked_at: null,
            external_chat_id: "",
          })
          .where(eq(messagingLinks.id, existingLink[0].id));
      } else {
        await db.insert(messagingLinks).values({
          channel_id: channel.id,
          user_id: ctx.userId,
          instance_id: ctx.instanceId,
          external_chat_id: "",
          link_code: code,
          link_code_expires_at: expiresAt,
        });
      }

      return { ok: true, code, expiresAt: expiresAt.toISOString() };
    }
  );

  // ──────────────────────────────────────────────────────────
  // GET /api/dashboard/:userId/messaging/status
  // Get messaging channel status
  // ──────────────────────────────────────────────────────────
  app.get(
    "/dashboard/:userId/messaging/status",
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const channels = await db
        .select()
        .from(messagingChannels)
        .where(eq(messagingChannels.instance_id, ctx.instanceId));

      const links = await db
        .select()
        .from(messagingLinks)
        .where(eq(messagingLinks.instance_id, ctx.instanceId));

      return {
        channels: channels.map((ch) => ({
          id: ch.id,
          provider: ch.provider,
          enabled: ch.enabled,
          config: ch.config,
          createdAt: ch.created_at,
        })),
        links: links.map((lk) => ({
          id: lk.id,
          provider: channels.find((c) => c.id === lk.channel_id)?.provider,
          externalChatId: lk.external_chat_id,
          linked: !!lk.linked_at,
          linkedAt: lk.linked_at,
        })),
      };
    }
  );

  // ──────────────────────────────────────────────────────────
  // POST /api/dashboard/:userId/messaging/disconnect
  // Disconnect a messaging channel
  // ──────────────────────────────────────────────────────────
  app.post(
    "/dashboard/:userId/messaging/disconnect",
    async (request, reply) => {
      const ctx = await resolveUserInstance(request, reply);
      if (!ctx) return;

      const { provider } = request.body as { provider?: string };
      if (provider !== "telegram" && provider !== "whatsapp") {
        return reply.status(400).send({ error: "Invalid provider" });
      }

      await db
        .update(messagingChannels)
        .set({ enabled: false, updated_at: new Date() })
        .where(and(
          eq(messagingChannels.instance_id, ctx.instanceId),
          eq(messagingChannels.provider, provider)
        ));

      return { ok: true };
    }
  );
}

// ============================================================
// Internal helpers
// ============================================================

async function getChannelForLink(channelId: string) {
  const [channel] = await db
    .select()
    .from(messagingChannels)
    .where(eq(messagingChannels.id, channelId));
  return channel || null;
}

async function handleStartCommand(chatId: string, text: string, reply: any) {
  // Send welcome message — user needs to enter their 6-digit link code
  // Find any enabled Telegram channel to respond through
  const [ch] = await db
    .select()
    .from(messagingChannels)
    .where(and(
      eq(messagingChannels.provider, "telegram"),
      eq(messagingChannels.enabled, true)
    ))
    .limit(1);

  if (ch) {
    const provider = new TelegramProvider(decrypt(ch.token_enc));
    await provider.sendMessage(
      chatId,
      "Bienvenue sur Otto ! 🤖\n\nPour connecter ton agent, entre le code à 6 chiffres affiché dans ton dashboard Otto (section Messaging)."
    ).catch(() => {});
  }

  return reply.status(200).send({ ok: true });
}

async function handleCodeInput(chatId: string, code: string, provider: TelegramProvider, reply: any) {
  // Find a pending link with this code
  const [link] = await db
    .select()
    .from(messagingLinks)
    .where(and(
      eq(messagingLinks.link_code, code),
      isNull(messagingLinks.linked_at)
    ))
    .limit(1);

  if (!link) {
    await provider.sendMessage(chatId, "Code invalide ou expiré. Génère un nouveau code depuis le dashboard Otto.");
    return reply.status(200).send({ ok: true });
  }

  // Check expiry
  if (link.link_code_expires_at && new Date(link.link_code_expires_at) < new Date()) {
    await provider.sendMessage(chatId, "Ce code a expiré. Génère un nouveau code depuis le dashboard Otto.");
    return reply.status(200).send({ ok: true });
  }

  // Link the chat
  await db
    .update(messagingLinks)
    .set({
      external_chat_id: chatId,
      linked_at: new Date(),
      link_code: null,
      link_code_expires_at: null,
    })
    .where(eq(messagingLinks.id, link.id));

  await provider.sendMessage(chatId, "Connecté ! Tu peux maintenant chatter avec ton agent Otto ici. Envoie un message pour commencer.");

  logger.info({ chatId, userId: link.user_id, instanceId: link.instance_id }, "Telegram user linked");

  return reply.status(200).send({ ok: true });
}
