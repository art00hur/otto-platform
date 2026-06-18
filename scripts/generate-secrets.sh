#!/bin/bash
# ============================================================
# Generate secrets for Railway deployment
# Run this locally, then paste the values into Railway
# ============================================================

echo "=== Claw Secret Generator ==="
echo ""
echo "ENCRYPTION_KEY (32 bytes, hex):"
openssl rand -hex 32
echo ""
echo "JWT_SECRET (32 bytes, hex):"
openssl rand -hex 32
echo ""
echo "=== Copy these into Railway Variables ==="
echo ""
echo "You also need these from external services:"
echo "  STRIPE_SECRET_KEY       → stripe.com/dashboard → Developers → API keys"
echo "  STRIPE_WEBHOOK_SECRET   → stripe.com/dashboard → Developers → Webhooks (create after deploy)"
echo "  STRIPE_STARTER_PRICE_ID → stripe.com/dashboard → Products → create Starter product"
echo "  STRIPE_PRO_PRICE_ID     → stripe.com/dashboard → Products → create Pro product"
echo "  STRIPE_BUSINESS_PRICE_ID→ stripe.com/dashboard → Products → create Business product"
echo "  HETZNER_API_TOKEN       → console.hetzner.cloud → Security → API Tokens → Generate"
echo "  GOOGLE_CLIENT_ID        → console.cloud.google.com → APIs → Credentials → OAuth 2.0"
echo "  GOOGLE_CLIENT_SECRET    → (same as above)"
