import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { logger } from "./utils/logger.js";
import { setupRoutes } from "./routes/setup.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/stripe-webhook.js";
import { qrRoutes } from "./routes/qr.js";
import { registerAIProxyRoutes } from "./routes/ai-proxy.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { authRoutes } from "./routes/auth.js";
import { chatProxyRoutes } from "./routes/chat-proxy.js";
import agentFilesRoutes from "./routes/agent-files.js";
import { agentManagementRoutes } from "./routes/agent-management.js";
import { hierarchyRoutes } from "./routes/hierarchy.js";
import { startUsageSync } from "./services/usage-sync.js";
import usageRoutes from "./routes/usage-routes.js";
import { adminRoutes } from "./routes/admin.js";
import { crmRoutes } from "./routes/crm.js";
import { pipedriveRoutes } from "./routes/pipedrive.js";
import { messagingRoutes } from "./routes/messaging.js";
import { readFile } from "fs/promises";
import authPlugin from "./plugins/auth.js";

const app = Fastify({
  logger: false, // We use our own pino logger
});

// Global error handler — logs all unhandled route errors
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const statusCode = error.statusCode || 500;
  const isServerError = statusCode >= 500;
  reply.status(statusCode).send({
    statusCode,
    error: error.name || "Internal Server Error",
    message: isServerError && process.env.NODE_ENV === "production"
      ? "Internal Server Error"
      : error.message,
  });
});

async function start() {
  // Plugins
  await app.register(cors, {
    origin: (origin, cb) => {
      const allowlist = [
        "https://app.otto-ai.co",
        "https://api.otto-ai.co",
        "https://otto-ai.co",
        "http://localhost:3000",
      ];
      if (process.env.CORS_ORIGIN) allowlist.push(process.env.CORS_ORIGIN);
      if (!origin || allowlist.includes(origin)) {
        cb(null, true);
      } else {
        cb(new Error("Not allowed by CORS"), false);
      }
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(websocket);
  await app.register(authPlugin);

  // Global security headers for all HTML responses
  app.addHook("onSend", (request, reply, payload, done) => {
    const ct = reply.getHeader("content-type");
    if (typeof ct === "string" && ct.includes("text/html")) {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "SAMEORIGIN");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    }
    done();
  });

  // Raw body storage for Stripe webhook signature verification
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      try {
        // Store raw buffer on the node request object
        (req as any).rawBody = (body as Buffer).toString('utf-8');
        const json = JSON.parse((body as Buffer).toString('utf-8'));
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // Routes
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(setupRoutes, { prefix: "/api" });
  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(webhookRoutes, { prefix: "/api" });
  await app.register(qrRoutes, { prefix: "/api" });

  // AI Proxy — must NOT have global rate limit (has its own per-user limiting)
  registerAIProxyRoutes(app);

  // Dashboard
  await app.register(dashboardRoutes, { prefix: "/api" });

  // Admin Routes
  await app.register(adminRoutes);

  // CRM integration routes
  await app.register(crmRoutes, { prefix: "/api" });

  // Pipedrive OAuth integration
  await app.register(pipedriveRoutes, { prefix: "/api" });

  // Messaging routes (Telegram/WhatsApp webhooks + dashboard setup)
  await app.register(messagingRoutes, { prefix: "/api" });

  // Chat proxy (WebSocket: browser → SSH tunnel → OpenClaw gateway)
  await app.register(chatProxyRoutes, { prefix: "/api" });

  // Agent files API (read/write SOUL.md, IDENTITY.md, etc. via gateway WebSocket)
  await app.register(agentFilesRoutes);
  await app.register(agentManagementRoutes, { prefix: "/api" });
  await app.register(hierarchyRoutes, { prefix: "/api" });
  await app.register(usageRoutes);
  // Load static HTML pages
  const dashboardHtml = await import("fs").then(fs =>
    fs.readFileSync(new URL("./dashboard/index.html", import.meta.url), "utf-8")
  );
  const landingHtml = await import("fs").then(fs =>
    fs.readFileSync(new URL("./landing/index.html", import.meta.url), "utf-8")
  );

  // Shared CSP for dashboard
  const dashboardCSP = [
    "default-src 'self'",
    "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com https://accounts.google.com https://apis.google.com",
    "style-src 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "frame-src https://accounts.google.com",
    "connect-src 'self' wss://app.otto-ai.co https://app.otto-ai.co wss://api.otto-ai.co https://api.otto-ai.co https://accounts.google.com https://cdnjs.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  // Dashboard page
  app.get("/dashboard", async (_req, reply) => {
    reply
      .header("Content-Security-Policy", dashboardCSP)
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "SAMEORIGIN")
      .header("Referrer-Policy", "no-referrer")
      .type("text/html")
      .send(dashboardHtml);
  });

  // Legal pages
  const privacyHtml = await import("fs").then(fs =>
    fs.readFileSync(new URL("./legal/privacy.html", import.meta.url), "utf-8")
  );
  const termsHtml = await import("fs").then(fs =>
    fs.readFileSync(new URL("./legal/terms.html", import.meta.url), "utf-8")
  );
  const staticCSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'";
  app.get("/privacy", async (_req, reply) => {
    reply.header("Content-Security-Policy", staticCSP).type("text/html").send(privacyHtml);
  });
  app.get("/terms", async (_req, reply) => {
    reply.header("Content-Security-Policy", staticCSP).type("text/html").send(termsHtml);
  });
  app.get("/admin", async (request, reply) => {
    const html = await readFile(new URL("./admin/index.html", import.meta.url), "utf-8");
    return reply
      .header("Content-Security-Policy", dashboardCSP)
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "SAMEORIGIN")
      .header("Referrer-Policy", "no-referrer")
      .type("text/html")
      .send(html);
  });

  // User guide page
  const guideHtml = await import("fs").then(fs =>
    fs.readFileSync(new URL("./guide/guide.html", import.meta.url), "utf-8")
  );
  app.get("/guide", async (_req, reply) => {
    reply.header("Content-Security-Policy", staticCSP).type("text/html").send(guideHtml);
  });

  // Root: dashboard for app.otto-ai.co, health check for api.otto-ai.co, landing for otto-ai.co
  app.get("/", async (req, reply) => {
    const host = req.headers.host || "";
    if (host.startsWith("api.")) {
      return { status: "ok", service: "otto-backend" };
    }
    // app.otto-ai.co goes straight to dashboard
    if (host.startsWith("app.")) {
      reply
        .header("Content-Security-Policy", dashboardCSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "SAMEORIGIN")
        .header("Referrer-Policy", "no-referrer")
        .type("text/html")
        .send(dashboardHtml);
      return;
    }
    reply.header("Content-Security-Policy", staticCSP).type("text/html").send(landingHtml);
  });

  // Start
  const port = parseInt(process.env.PORT || "3001", 10);
  const host = process.env.HOST || "127.0.0.1";

  await app.listen({ port, host });
  startUsageSync();

  // Start health monitor (checks every 5 min, alerts after 3 failures)
  import("./services/health-monitor.js").then(({ startHealthMonitor }) => {
    startHealthMonitor();
  }).catch((err) => {
    logger.warn({ err }, "Health monitor failed to start");
  });

  logger.info({ port, host }, "🤖 Otto backend running");

  // Startup secrets health check — verify encrypted values are readable.
  // Runs async so it doesn't block startup. Logs warnings if secrets are broken.
  (async () => {
    try {
      const { db, schema } = await import("./db/index.js");
      const { decrypt } = await import("./utils/encryption.js");
      const { eq } = await import("drizzle-orm");
      const active = await db
        .select({
          id: schema.instances.id,
          ssh_private_key_enc: schema.instances.ssh_private_key_enc,
          gateway_token_enc: schema.instances.gateway_token_enc,
        })
        .from(schema.instances)
        .where(eq(schema.instances.status, "active"));

      for (const inst of active) {
        const problems: string[] = [];
        if (inst.ssh_private_key_enc) {
          try { decrypt(inst.ssh_private_key_enc); } catch { problems.push("ssh_private_key_enc"); }
        }
        if (inst.gateway_token_enc) {
          try { decrypt(inst.gateway_token_enc); } catch { problems.push("gateway_token_enc"); }
        }
        if (problems.length > 0) {
          logger.error({ instanceId: inst.id, broken: problems },
            "STARTUP CHECK: Encrypted values unreadable — ENCRYPTION_KEY may have been rotated without re-encrypting DB. Agent features will be broken for this instance.");
        }
      }
    } catch (err) {
      logger.warn({ err }, "Startup secrets health check failed");
    }
  })();
}

start().catch((err) => {
  logger.fatal(err, "Failed to start server");
  process.exit(1);
});
