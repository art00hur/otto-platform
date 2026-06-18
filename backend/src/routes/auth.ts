import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { users, subscriptions, instances } from "../db/schema.js";
import { logger } from "../utils/logger.js";
import crypto from "crypto";

// ── Zod Schemas ──

const googleAuthSchema = z.object({
  id_token: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const setPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// ── Simple bcrypt-like password hashing using scrypt (no external deps) ──
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      resolve(`${salt}:${derived.toString("hex")}`);
    });
  });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(":");
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      const derivedHex = derived.toString("hex");
      // Use timingSafeEqual to prevent timing attacks
      if (derivedHex.length !== key.length) return resolve(false);
      resolve(crypto.timingSafeEqual(Buffer.from(derivedHex), Buffer.from(key)));
    });
  });
}

// ============================================================
// Auth Routes — Google OAuth + JWT session
// ============================================================
//
// Flow:
//   1. Frontend shows "Sign in with Google" button
//   2. Google returns an ID token (JWT signed by Google)
//   3. Frontend sends token to POST /api/auth/google
//   4. We verify the token with Google's API
//   5. Create or find user in our DB
//   6. Return our own JWT for subsequent API calls
// ============================================================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET environment variable is required. Generate one with: openssl rand -hex 32");
}
const TOKEN_EXPIRY_HOURS = 72; // 3 days

interface GoogleTokenPayload {
  iss: string;
  azp: string;
  aud: string;
  sub: string;   // Google user ID
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  iat: number;
  exp: number;
}

/**
 * Verify a Google ID token by calling Google's tokeninfo endpoint.
 * This is simpler and more reliable than local JWT verification
 * (no need to manage Google's rotating public keys).
 */
async function verifyGoogleToken(idToken: string): Promise<GoogleTokenPayload | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      logger.warn({ status: response.status }, "Google token verification failed");
      return null;
    }

    const payload = await response.json() as GoogleTokenPayload;

    // Verify audience matches our client ID
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      logger.warn({ aud: payload.aud }, "Google token audience mismatch");
      return null;
    }

    // Verify email is verified
    if (!payload.email_verified) {
      logger.warn({ email: payload.email }, "Google email not verified");
      return null;
    }

    return payload;
  } catch (err) {
    logger.error({ err }, "Google token verification error");
    return null;
  }
}

/**
 * Create a simple JWT (HMAC-SHA256).
 * We don't need a library for this — it's straightforward.
 */
export function createJWT(payload: Record<string, any>, expiryHours?: number): string {
  const expiry = expiryHours ?? TOKEN_EXPIRY_HOURS;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiry * 3600,
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");

  return `${header}.${body}.${signature}`;
}

/**
 * Verify and decode a Claw JWT.
 */
export function verifyJWT(token: string): Record<string, any> | null {
  try {
    const [header, body, signature] = token.split(".");

    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString());

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Auto-create a free subscription for new users.
 * Assigns a VPS from the ready pool if available.
 */
async function createFreeSubscription(userId: string): Promise<void> {
  // Idempotent: skip if user already has a subscription
  const [existingSub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.user_id, userId))
    .limit(1);

  if (existingSub) return;

  // Lazy provisioning: do NOT assign a VPS at signup for free users.
  // VPS will be assigned on-demand when the user first opens chat.
  // This avoids wasting VPS resources on signups that never return.

  await db.insert(subscriptions).values({
    user_id: userId,
    instance_id: null,
    stripe_subscription_id: null,
    plan: "free",
    status: "active",
    ai_credits_limit: 100,
    ai_credits_used: 0,
    ai_credits_bonus: 0,
    extra_agent_slots: 0,
    current_period_start: new Date(),
    current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  logger.info({ userId }, "Free subscription created (no VPS yet — lazy provisioning)");
}

/**
 * Register auth routes.
 */
export async function authRoutes(app: FastifyInstance) {

  // Stricter rate limit for auth routes (10/min per IP)
  const authRateConfig = {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
      },
    },
  };

  // ============================================================
  // POST /api/auth/google — Exchange Google ID token for Claw JWT
  // ============================================================
  app.post("/auth/google", authRateConfig, async (request, reply) => {
    const parsed = googleAuthSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { id_token } = parsed.data;

    // Verify with Google
    const googleUser = await verifyGoogleToken(id_token);
    if (!googleUser) {
      return reply.status(401).send({ error: "Invalid Google token" });
    }

    // Find or create user
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.google_id, googleUser.sub))
      .limit(1);

    if (!user) {
      // Check if email already exists (signed up differently before)
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, googleUser.email))
        .limit(1);

      if (user) {
        // Link Google ID to existing account
        await db
          .update(users)
          .set({ google_id: googleUser.sub })
          .where(eq(users.id, user.id));
      } else {
        // Create new user
        const [newUser] = await db
          .insert(users)
          .values({
            email: googleUser.email,
            google_id: googleUser.sub,
          })
          .returning();
        user = newUser;
        logger.info({ userId: user.id, email: user.email }, "New user created via Google OAuth");
        await createFreeSubscription(user.id);
      }
    }

    // Create our JWT
    const token = createJWT({
      userId: user.id,
      email: user.email,
    });

    logger.info({ userId: user.id }, "User authenticated via Google");

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    };
  });

  // ============================================================
  // GET /api/auth/me — Get current user from JWT
  // ============================================================
  app.get("/auth/me", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "No token provided" });
    }

    const payload = verifyJWT(authHeader.slice(7));
    if (!payload) {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send({ error: "User not found" });
    }

    // Check if user has any subscription (including free)
    const [sub] = await db
      .select({ plan: subscriptions.plan, status: subscriptions.status })
      .from(subscriptions)
      .where(and(eq(subscriptions.user_id, user.id), eq(subscriptions.status, "active")))
      .limit(1);

    // Issue a fresh long-lived token (refreshes short-lived redirect tokens)
    const freshToken = createJWT({ userId: user.id, email: user.email });

    return {
      user: {
        id: user.id,
        email: user.email,
        has_subscription: !!sub,
        plan: sub?.plan || null,
      },
      token: freshToken,
    };
  });

  // ============================================================
  // POST /api/auth/login — Email + password login
  // ============================================================
  app.post("/auth/login", authRateConfig, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);

    if (!user || !user.password_hash) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const token = createJWT({ userId: user.id, email: user.email });
    logger.info({ userId: user.id }, "User authenticated via email/password");

    return {
      token,
      user: { id: user.id, email: user.email },
    };
  });

  // ============================================================
  // POST /api/auth/set-password — Admin sets a password for a user (requires admin JWT)
  // ============================================================
  app.post("/auth/set-password", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const jwt = verifyJWT(authHeader.slice(7));
    // Only allow admin users to set passwords (same list as admin.ts)
    const ADMIN_IDS = [
      "3850163b-c506-4913-bbee-2fcae6e9e279",
      "448f1fc8-a9b2-4d67-9977-5498245bdae8",
    ];
    if (!jwt || !ADMIN_IDS.includes(jwt.userId)) {
      return reply.status(403).send({ error: "Admin only" });
    }

    const parsed = setPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const { email, password } = parsed.data;

    const hash = await hashPassword(password);

    // Find or create user
    let [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);

    if (user) {
      await db.update(users).set({ password_hash: hash }).where(eq(users.id, user.id));
      logger.info({ userId: user.id, email }, "Password set for existing user");
    } else {
      const [newUser] = await db
        .insert(users)
        .values({ email: email.toLowerCase().trim(), password_hash: hash })
        .returning();
      user = newUser;
      logger.info({ userId: user.id, email }, "New user created with password");
      await createFreeSubscription(user.id);
    }

    return { ok: true, userId: user.id, email: user.email };
  });

  logger.info("Auth routes registered");
}
