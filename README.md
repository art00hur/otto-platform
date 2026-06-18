# 🤖 Otto

**Full-scope AI agent SaaS for SMEs** — Otto deploys dedicated AI employees that run on isolated infrastructure, communicate across multiple channels, and work together as a team.

> Powered by [OpenClaw](https://openclaw.ai) + [OpenRouter](https://openrouter.ai)

---

## What is Otto?

Otto gives small and medium businesses a team of **dedicated AI agents** — not chatbots, not workflow builders — autonomous AI employees that:

- 💬 Work from a **web dashboard**, **Slack**, **WhatsApp**, or **Telegram**
- 🧠 Share persistent memory and context across every channel (one brain per agent)
- 🤝 Collaborate with one another — a lead agent delegates tasks to specialist agents
- 📧 Read and send email via Gmail / Google Workspace
- 🔗 Connect to business tools through CRM integrations (Pipedrive) and the Model Context Protocol
- 🔒 Run on **dedicated, isolated infrastructure** — one private server per customer

---

## Architecture

Each customer gets their own VPS running a private OpenClaw gateway. The Otto control plane handles authentication, billing, and provisioning, and reaches each gateway through an SSH tunnel — the gateway is never exposed to the public internet.

```
  Browser / Slack / WhatsApp / Telegram
                    │
                    ▼
  ┌─────────────────────────────────────┐
  │           OTTO CONTROL PLANE         │
  │   Auth (Google OAuth) │ Billing (Stripe) │
  │   API server (Fastify) │ Pool worker     │
  │   PostgreSQL │ SSH tunnel pool           │
  └──────────────────┬──────────────────┘
                     │ SSH tunnel
                     ▼
  ┌─────────────────────────────────────┐
  │        CUSTOMER VPS (1 per user)     │
  │   OpenClaw gateway (loopback only)   │
  │   Lead agent ↔ specialist agents     │
  │   AI via OpenRouter (300+ models)    │
  │   UFW: SSH from control plane only   │
  └─────────────────────────────────────┘
```

A detailed design write-up lives in [`ARCHITECTURE.md`](./ARCHITECTURE.md), with an interactive diagram in `otto-architecture.svg`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend** | Node.js, Fastify, TypeScript, Drizzle ORM |
| **Database** | PostgreSQL |
| **Auth** | Google OAuth 2.0 → JWT (HMAC-SHA256) |
| **Payments** | Stripe (subscriptions + webhooks) |
| **Provisioning** | Hetzner Cloud API, snapshot-based pool worker |
| **Agent runtime** | OpenClaw gateway (one per customer VPS) |
| **AI models** | OpenRouter (Claude, GPT, Gemini, Mistral — 300+ models) |
| **Channels** | Web dashboard, Slack, WhatsApp (Baileys), Telegram (grammY) |
| **Integrations** | Pipedrive CRM, Model Context Protocol (MCP) |
| **Frontend** | Dashboard & landing as standalone HTML/CSS/JS SPAs |
| **Security** | AES-256-GCM, SSH tunnels, UFW, loopback binding |

---

## Security Model

- **Network isolation** — one VPS per customer, gateway bound to loopback only
- **SSH tunnels** — the only path to a gateway, initiated from the control plane
- **Firewall** — UFW blocks all inbound traffic except SSH from the control plane
- **Encryption at rest** — AES-256-GCM for SSH keys and provider tokens
- **Authentication** — JWT with ownership verification on every request
- **Zero exposure** — the browser never sees customer VPS IPs, ports, or tokens

---

## Project Structure

```
.
├── backend/                  # Control-plane API (Fastify + TypeScript)
│   └── src/
│       ├── server.ts             # API server entrypoint
│       ├── routes/               # auth, dashboard, chat-proxy, stripe-webhook,
│       │                         #   crm, pipedrive, messaging, setup, health…
│       ├── services/             # provisioner, ssh / ssh-tunnel, qr-relay,
│       │                         #   spending-guard, health-monitor, usage-sync…
│       ├── connectors/           # CRM connectors (Pipedrive)
│       ├── mcp/                  # Model Context Protocol server
│       ├── db/                   # Drizzle schema + SQL migrations
│       ├── dashboard/            # Web dashboard SPA
│       ├── landing/              # Marketing landing page
│       └── legal/                # Privacy policy + terms of service
├── pool-worker/              # VPS provisioning & lifecycle worker
│   └── src/
│       ├── worker.ts             # Pool lifecycle manager
│       ├── pool-manager.ts       # Reconciliation loop
│       ├── providers/hetzner.ts  # Hetzner Cloud API + SSH key generation
│       └── jobs/                 # provision + health-check jobs
├── shared/                   # Types shared across services
├── templates/                # Reusable frontend & OpenClaw config templates
├── docs/                     # Integration documentation (Pipedrive API)
├── brand/                    # Logos and icons
└── otto-architecture.svg     # Architecture diagram
```

---

## Links

- **Website:** [otto-ai.co](https://otto-ai.co)

---

## License

Released under the [MIT License](./LICENSE).
