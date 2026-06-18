import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { db, schema } from "../db/index.js";
import { eq, and, sql } from "drizzle-orm";
import { creditTopups } from "../db/schema.js";

import { logger } from "../utils/logger.js";
import { createJWT } from "./auth.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-02-24.acacia" as any,
});

// Plan credit limits in cents (EUR) — hard cap per month
const PLAN_CREDIT_LIMITS: Record<string, number> = {
  free: 100,       // €1
  starter: 1500,   // €15
  pro: 6000,       // €60
  ultra: 10000,    // €100
};

export async function webhookRoutes(app: FastifyInstance) {

  /**
   * GET /api/setup-complete — After Stripe checkout, generate JWT and redirect to dashboard.
   * This is the Stripe success_url target.
   * 
   * Also acts as a FALLBACK for VPS assignment if the webhook hasn't fired yet.
   * handleCheckoutComplete is idempotent, so calling it twice is safe.
   */
  app.get("/setup-complete", async (request, reply) => {
    const { session_id } = request.query as { session_id?: string };

    if (!session_id) {
      return reply.status(400).send({ error: "Missing session_id" });
    }

    try {
      // Retrieve checkout session from Stripe
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const userId = session.metadata?.user_id;

      if (!userId) {
        return reply.status(400).send({ error: "Invalid checkout session" });
      }

      // Fallback: if webhook hasn't processed this checkout yet, handle it now.
      // handleCheckoutComplete is idempotent — safe to call even if webhook already ran.
      if (session.subscription && session.metadata?.plan) {
        const [existingSub] = await db
          .select()
          .from(schema.subscriptions)
          .where(eq(schema.subscriptions.stripe_subscription_id, session.subscription as string))
          .limit(1);

        if (!existingSub) {
          logger.info({ userId, session_id }, "setup-complete: webhook hasn't processed yet, handling VPS assignment inline");
          await handleCheckoutComplete(session);
        } else {
          logger.info({ userId, session_id }, "setup-complete: webhook already processed, skipping");
        }
      }

      // Get user email
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Generate short-lived JWT for URL redirect (1 hour, not 72h)
      const token = createJWT({ userId: user.id, email: user.email }, 1);

      // Redirect to dashboard with token
      const dashboardUrl = `${process.env.API_URL || 'https://app.otto-ai.co'}/dashboard?token=${token}&user_id=${userId}`;
      return reply.redirect(dashboardUrl);
    } catch (err) {
      logger.error({ err, session_id }, "setup-complete failed");
      return reply.status(500).send({ error: "Setup failed. Please contact support." });
    }
  });

  /**
   * POST /api/webhook/stripe
   * Receives Stripe events for subscription lifecycle.
   */
  app.post(
    "/webhook/stripe",
    {
      config: { rawBody: true },
    },
    async (request, reply) => {
      const sig = request.headers["stripe-signature"] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

      if (!webhookSecret) {
        logger.error("STRIPE_WEBHOOK_SECRET not configured");
        return reply.status(500).send({ error: "Webhook not configured" });
      }

      let event: Stripe.Event;
      try {
          event = stripe.webhooks.constructEvent(
          request.rawBody as string,
          sig,
          webhookSecret
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown";
        logger.warn({ error: message }, "Stripe signature verification failed");
        return reply.status(400).send({ error: "Invalid signature" });
      }

      logger.info({ type: event.type, id: event.id }, "Stripe webhook received");

      switch (event.type) {
        case "checkout.session.completed":
          try {
            await handleCheckoutComplete(event.data.object as Stripe.Checkout.Session);
          } catch (err) {
            logger.error({ err: String(err), stack: (err as any)?.stack }, "handleCheckoutComplete CRASHED");
          }
          break;

        case "customer.subscription.updated":
          await handleSubscriptionUpdate(event.data.object as Stripe.Subscription);
          break;

        case "customer.subscription.deleted":
          await handleSubscriptionCancelled(event.data.object as Stripe.Subscription);
          break;

        case "invoice.payment_failed":
          await handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;

        default:
          logger.debug({ type: event.type }, "Unhandled Stripe event");
      }

      return { received: true };
    }
  );

  /**
   * POST /api/checkout — Create a Stripe Checkout Session for subscription.
   */
  app.post("/checkout", async (request, reply) => {
    const { email, plan, user_id } = request.body as {
      email: string;
      plan: "starter" | "pro" | "ultra";
      user_id: string;
    };

    const priceMap: Record<string, string | undefined> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID,
      pro: process.env.STRIPE_PRO_PRICE_ID,
      ultra: process.env.STRIPE_ULTRA_PRICE_ID,
    };

    const priceId = priceMap[plan];
    if (!priceId) {
      return reply.status(500).send({ error: `Stripe price not configured for ${plan}` });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.API_URL || 'https://app.otto-ai.co'}/api/setup-complete?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://otto-ai.co'}/?cancelled=true`,
      metadata: {
        user_id,
        plan,
      },
    });

    return { checkout_url: session.url };
  });

  /**
   * POST /api/checkout/topup — Buy extra AI credits (one-time payment).
   * 
   * Packages:
   *   $5  → $5 credits  (1x)
   *   $15 → $17 credits (13% bonus)
   *   $30 → $36 credits (20% bonus)
   */
  app.post("/checkout/topup", async (request, reply) => {
    const { user_id, package: pkg } = request.body as {
      user_id: string;
      package: "small" | "medium" | "large";
    };

    // Look up user's Stripe customer ID
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user_id));

    if (!user || !user.stripe_customer_id) {
      return reply.status(400).send({ error: "No active subscription found. Subscribe first." });
    }

    const packages: Record<string, { amountCents: number; creditsCents: number; label: string }> = {
      small:  { amountCents: 500,  creditsCents: 500,  label: "$5 AI Credits" },
      medium: { amountCents: 1500, creditsCents: 1700, label: "$17 AI Credits (+$2 bonus)" },
      large:  { amountCents: 3000, creditsCents: 3600, label: "$36 AI Credits (+$6 bonus)" },
    };

    const selected = packages[pkg];
    if (!selected) {
      return reply.status(400).send({ error: "Invalid package" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: user.stripe_customer_id,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: selected.label },
          unit_amount: selected.amountCents,
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/dashboard?topup=success`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard?topup=cancelled`,
      metadata: {
        user_id,
        type: "credit_topup",
        credits_cents: selected.creditsCents.toString(),
        amount_cents: selected.amountCents.toString(),
      },
    });

    return { checkout_url: session.url };
  });

  /**
   * POST /api/checkout/add-agent — Buy an extra agent slot ($30 one-time).
   * Includes $22.50 in AI credits (75% of payment).
   *
   * After payment, the agent is created via POST /api/agents/:instanceId/add
   * triggered from the dashboard on redirect.
   */
  app.post("/checkout/add-agent", async (request, reply) => {
    const { user_id, agent_name, agent_role, agent_emoji } = request.body as {
      user_id: string;
      agent_name: string;
      agent_role: string;
      agent_emoji: string;
    };

    if (!agent_name || !agent_role) {
      return reply.status(400).send({ error: "agent_name and agent_role are required" });
    }

    // Look up user's Stripe customer ID
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user_id));

    if (!user || !user.stripe_customer_id) {
      return reply.status(400).send({ error: "No active subscription found. Subscribe first." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer: user.stripe_customer_id,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Extra Agent: ${agent_name} (${agent_role})` },
          unit_amount: 3000, // $30
        },
        quantity: 1,
      }],
      success_url: `${process.env.API_URL || 'https://app.otto-ai.co'}/dashboard?add_agent=success&agent_name=${encodeURIComponent(agent_name)}&agent_role=${encodeURIComponent(agent_role)}&agent_emoji=${encodeURIComponent(agent_emoji || '🤖')}`,
      cancel_url: `${process.env.API_URL || 'https://app.otto-ai.co'}/dashboard?add_agent=cancelled`,
      metadata: {
        user_id,
        type: "add_agent",
        agent_name,
        agent_role,
        agent_emoji: agent_emoji || "🤖",
        credits_cents: "2250", // 75% of $30
      },
    });

    return { checkout_url: session.url };
  });

  /**
   * POST /api/plan/change — Upgrade or downgrade subscription.
   * 
   * Upgrade: charges prorated difference immediately, resets billing period to now.
   * Downgrade: schedules price change for end of current period.
   */
  app.post("/plan/change", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return reply.code(401).send({ error: "Missing token" });
    
    let decoded: any;
    try {
      decoded = (await import("./auth.js")).verifyJWT(authHeader.slice(7));
    } catch {
      return reply.code(401).send({ error: "Invalid token" });
    }

    const { plan } = request.body as { plan: "starter" | "pro" | "ultra" };
    if (!["starter", "pro", "ultra"].includes(plan)) {
      return reply.code(400).send({ error: "Invalid plan" });
    }

    const priceMap: Record<string, string | undefined> = {
      starter: process.env.STRIPE_STARTER_PRICE_ID,
      pro: process.env.STRIPE_PRO_PRICE_ID,
      ultra: process.env.STRIPE_ULTRA_PRICE_ID,
    };

    const newPriceId = priceMap[plan];
    if (!newPriceId) {
      return reply.code(500).send({ error: "Stripe price not configured for " + plan });
    }

    // Get user's subscription
    const [sub] = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.user_id, decoded.userId));

    if (!sub || !sub.stripe_subscription_id || sub.plan === "free") {
      return reply.code(400).send({ error: "No active paid subscription. Use /api/checkout to subscribe." });
    }

    if (sub.plan === plan) {
      return reply.code(400).send({ error: "Already on this plan" });
    }

    try {
      // Get current Stripe subscription
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const currentItemId = stripeSub.items.data[0]?.id;

      if (!currentItemId) {
        return reply.code(500).send({ error: "Could not find subscription item" });
      }

      const planOrder = { starter: 0, pro: 1, ultra: 2 };
      const isUpgrade = (planOrder[plan] || 0) > (planOrder[sub.plan as string] || 0);

      if (isUpgrade) {
        // UPGRADE: charge prorated difference now, reset billing period
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          items: [{ id: currentItemId, price: newPriceId }],
          proration_behavior: "always_invoice",
          billing_cycle_anchor: "now",
        });

        // Update local DB immediately
        const newCreditsLimit = PLAN_CREDIT_LIMITS[plan] || 2500;
        await db
          .update(schema.subscriptions)
          .set({
            plan,
            ai_credits_limit: newCreditsLimit,
            current_period_start: new Date(),
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          })
          .where(eq(schema.subscriptions.id, sub.id));

        logger.info({ userId: decoded.userId, from: sub.plan, to: plan }, "Plan upgraded — billed immediately");
        return { ok: true, action: "upgraded", plan, effective: "now" };
      } else {
        // DOWNGRADE: schedule for end of period
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
          items: [{ id: currentItemId, price: newPriceId }],
          proration_behavior: "none",
          billing_cycle_anchor: "unchanged",
        });

        // Update plan in DB but keep current credits until period end
        await db
          .update(schema.subscriptions)
          .set({ plan })
          .where(eq(schema.subscriptions.id, sub.id));

        const periodEnd = sub.current_period_end
          ? new Date(sub.current_period_end).toLocaleDateString()
          : "end of billing period";

        logger.info({ userId: decoded.userId, from: sub.plan, to: plan, effectiveAt: periodEnd }, "Plan downgraded — effective at period end");
        return { ok: true, action: "downgraded", plan, effective: periodEnd };
      }
    } catch (err: any) {
      logger.error({ userId: decoded.userId, error: err.message }, "Plan change failed");
      return reply.code(500).send({ error: "Plan change failed: " + err.message });
    }
  });
}

// ----- Event Handlers -----

/**
 * Handle checkout.session.completed — assign VPS + create subscription.
 * IDEMPOTENT: safe to call multiple times for the same session.
 * Called from both the webhook handler AND setup-complete fallback.
 */
async function handleCheckoutComplete(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id;
  if (!userId) return;

  // Credit top-up (one-time payment)?
  if (session.metadata?.type === "credit_topup") {
    await handleCreditTopup(session);
    return;
  }

  // Agent top-up (one-time payment, adds credits too)?
  if (session.metadata?.type === "add_agent") {
    await handleAgentTopup(session);
    return;
  }

  // Subscription checkout
  const plan = session.metadata?.plan as "starter" | "pro" | "ultra";
  if (!session.subscription) return;

  // IDEMPOTENCY CHECK: if subscription record already exists, skip everything
  const [existingSub] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.stripe_subscription_id, session.subscription as string))
    .limit(1);

  if (existingSub) {
    logger.info({ userId, subscriptionId: existingSub.id }, "handleCheckoutComplete: subscription already exists, skipping (idempotent)");
    return;
  }

  const creditsLimit = PLAN_CREDIT_LIMITS[plan] || 800;

  // 1. Update user's Stripe customer ID
  await db
    .update(schema.users)
    .set({ stripe_customer_id: session.customer as string })
    .where(eq(schema.users.id, userId));

  // 2. Check if user has an existing free subscription → upgrade it
  const [freeSub] = await db
    .select()
    .from(schema.subscriptions)
    .where(and(
      eq(schema.subscriptions.user_id, userId),
      eq(schema.subscriptions.plan, "free")
    ))
    .limit(1);

  if (freeSub) {
    // Free user already has a VPS assigned — reuse it
    await db
      .update(schema.subscriptions)
      .set({
        stripe_subscription_id: session.subscription as string,
        plan,
        status: "active",
        ai_credits_limit: creditsLimit,
        ai_credits_used: 0,
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .where(eq(schema.subscriptions.id, freeSub.id));

    // If free sub had no instance, try to assign one
    if (!freeSub.instance_id) {
      const [readyInstance] = await db
        .select()
        .from(schema.instances)
        .where(eq(schema.instances.status, "ready"))
        .limit(1);

      if (readyInstance) {
        await db.update(schema.instances).set({
          user_id: userId, status: "active", assigned_at: new Date(),
        }).where(eq(schema.instances.id, readyInstance.id));
        await db.update(schema.subscriptions).set({
          instance_id: readyInstance.id,
        }).where(eq(schema.subscriptions.id, freeSub.id));
      }
    }

    logger.info({ userId, plan, fromFree: true }, "Free subscription upgraded to paid");
    return;
  }

  // 3. No existing subscription — find a ready VPS from the pool
  const [readyInstance] = await db
    .select()
    .from(schema.instances)
    .where(eq(schema.instances.status, "ready"))
    .limit(1);

  let instanceId: string | null = null;
  if (readyInstance) {
    await db
      .update(schema.instances)
      .set({
        user_id: userId,
        status: "active",
        assigned_at: new Date(),
      })
      .where(eq(schema.instances.id, readyInstance.id));
    instanceId = readyInstance.id;
    logger.info({ userId, instanceId }, "Assigned ready VPS to user");
  } else {
    logger.warn({ userId }, "No ready VPS available at checkout — pool empty");
  }

  // 4. Create subscription record
  await db.insert(schema.subscriptions).values({
    user_id: userId,
    instance_id: instanceId,
    stripe_subscription_id: session.subscription as string,
    plan,
    status: "active",
    ai_credits_limit: creditsLimit,
    current_period_start: new Date(),
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  logger.info({ userId, plan, creditsLimit, instanceId }, "Subscription created + VPS assigned");
}

/**
 * Handle add_agent checkout — grants credits (75% of $30 = $22.50).
 * The actual agent creation is triggered from the dashboard after redirect,
 * calling POST /api/agents/:instanceId/add.
 */
async function handleAgentTopup(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id;
  if (!userId) return;

  const creditsCents = parseInt(session.metadata?.credits_cents || "0", 10);

  // Find user's active subscription
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, userId))
    .limit(1);

  if (!sub) {
    logger.error({ userId }, "Agent top-up but no subscription found");
    return;
  }

  // Add bonus credits (75% of payment)
  if (creditsCents > 0) {
    await db
      .update(schema.subscriptions)
      .set({
        ai_credits_bonus: sql`${schema.subscriptions.ai_credits_bonus} + ${creditsCents}`,
        extra_agent_slots: sql`${schema.subscriptions.extra_agent_slots} + 1`,
      })
      .where(eq(schema.subscriptions.id, sub.id));
  }

  // Record the topup
  await db.insert(schema.creditTopups).values({
    user_id: userId,
    subscription_id: sub.id,
    stripe_payment_id: session.payment_intent as string,
    amount_paid_cents: 3000,
    credits_granted_cents: creditsCents,
  });

  const agentName = session.metadata?.agent_name || "New Agent";
  logger.info({ userId, agentName, creditsCents }, "Agent top-up payment processed, credits added. Agent creation pending from dashboard.");
}

async function handleCreditTopup(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.user_id;
  if (!userId) return;

  const creditsCents = parseInt(session.metadata?.credits_cents || "0", 10);
  const amountCents = parseInt(session.metadata?.amount_cents || "0", 10);
  if (creditsCents <= 0) return;

  // Find user's active subscription
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.user_id, userId))
    .limit(1);

  if (!sub) {
    logger.error({ userId }, "Top-up but no subscription found");
    return;
  }

  // Add bonus credits
  await db
    .update(schema.subscriptions)
    .set({
      ai_credits_bonus: sql`${schema.subscriptions.ai_credits_bonus} + ${creditsCents}`,
        extra_agent_slots: sql`${schema.subscriptions.extra_agent_slots} + 1`,
    })
    .where(eq(schema.subscriptions.id, sub.id));

  // Record the topup
  await db.insert(schema.creditTopups).values({
    user_id: userId,
    subscription_id: sub.id,
    stripe_payment_id: session.payment_intent as string,
    amount_paid_cents: amountCents,
    credits_granted_cents: creditsCents,
  });

  logger.info({ userId, creditsCents, amountCents }, "Credit top-up applied");
}

async function handleSubscriptionUpdate(subscription: Stripe.Subscription) {
  const status = subscription.cancel_at_period_end
    ? "cancelling"
    : subscription.status === "active"
      ? "active"
      : "past_due";

  await db
    .update(schema.subscriptions)
    .set({
      status,
      current_period_end: new Date(subscription.current_period_end * 1000),
    })
    .where(
      eq(schema.subscriptions.stripe_subscription_id, subscription.id)
    );

  if (subscription.cancel_at_period_end) {
    logger.info(
      { subscriptionId: subscription.id, endsAt: new Date(subscription.current_period_end * 1000) },
      "Subscription set to cancel at period end — user keeps access until then"
    );
  }
}

async function handleSubscriptionCancelled(subscription: Stripe.Subscription) {
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(
      eq(schema.subscriptions.stripe_subscription_id, subscription.id)
    );

  if (!sub) return;

  // Downgrade to free instead of full cancellation — user keeps VPS
  await db
    .update(schema.subscriptions)
    .set({
      plan: "free",
      status: "active",
      stripe_subscription_id: null,
      ai_credits_limit: 100,
      ai_credits_used: 0,
      ai_credits_bonus: 0,
      extra_agent_slots: 0,
      current_period_start: new Date(),
      current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
    .where(eq(schema.subscriptions.id, sub.id));

  logger.info({ subscriptionId: sub.id }, "Paid subscription cancelled — downgraded to free");
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  if (!invoice.subscription) return;

  await db
    .update(schema.subscriptions)
    .set({ status: "past_due" })
    .where(
      eq(
        schema.subscriptions.stripe_subscription_id,
        invoice.subscription as string
      )
    );

  logger.warn({ subscription: invoice.subscription }, "Payment failed");
}
