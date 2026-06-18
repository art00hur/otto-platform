# Otto Platform — Architecture & Roadmap

> Full-scope AI agent SaaS for SMEs, powered by OpenClaw + OpenRouter.

---

## Table of Contents

- [Vision](#vision)
- [What's Been Built](#whats-been-built)
- [Architecture](#architecture)
- [Core Components](#core-components)
- [AI Model Strategy (OpenRouter)](#ai-model-strategy-openrouter)
- [Security Model](#security-model)
- [Agent Email](#agent-email)
- [Multi-Channel Communication](#multi-channel-communication)
- [Agent-to-Agent Communication](#agent-to-agent-communication)
- [Scalability (1,000+ Customers)](#scalability-1000-customers)
- [Pricing](#pricing)
- [Roadmap & Time Estimates](#roadmap--time-estimates)

---

## Vision

Otto provides SMEs with **dedicated AI agents** — not chatbots, not workflow tools — actual AI employees that run on isolated infrastructure, communicate across multiple channels, and work together as a team.

A customer can:
- Deploy a single agent for one task (e.g., customer support)
- Build a full "AI company" with CEO, CFO, Support, and Marketing agents
- Chat with agents from the **Otto Dashboard**, **Slack**, **WhatsApp**, or **Telegram**
- Give each agent a dedicated email address to receive and process documents
- Have agents collaborate with each other autonomously

---

## What's Been Built

| Component | Status | Details |
|-----------|--------|---------|
| **Google OAuth sign-in** | ✅ Complete | Authentication flow working |
| **Stripe checkout** | ✅ Complete | Payment integration tested end-to-end |
| **Hetzner VPS provisioning** | ✅ Complete | Snapshot-based provisioning via pool worker system |
| **Pool worker** | ✅ Complete | Manages VPS lifecycle (create, assign, recycle) |
| **QR relay service** | ✅ Complete | Captures QR codes from OpenClaw for WhatsApp linking in browser |
| **WhatsApp device linking** | ✅ Complete | Full flow tested: signup → QR scan → WhatsApp connected |
| **Backend on Hetzner VPS** | ✅ Complete | Deployed with SSL certificates |
| **Database schema** | ✅ Complete | PostgreSQL — customers, VPS metadata, subscriptions |
| **End-to-end test** | ✅ Complete | Full user journey validated |

**Summary**: The core infrastructure works. What remains is the **dashboard**, **multi-agent management**, **Slack integration**, **email**, and **agent-to-agent orchestration**.

---

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                   OTTO CONTROL PLANE                       │
│            (Hetzner VPS — your central backend)            │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────┐              │
│  │  Auth    │  │ Billing  │  │ Provision  │              │
│  │ (Google  │  │ (Stripe) │  │  Manager   │              │
│  │  OAuth)  │  │          │  │ (Hetzner   │              │
│  └──────────┘  └──────────┘  │ API + Pool)│              │
│                               └────────────┘              │
│  ┌──────────────────────────────────────────┐             │
│  │          OTTO DASHBOARD (Web App)         │             │
│  │  • Agent CRUD (create, configure, delete) │             │
│  │  • Live chat with agents (WebSocket)      │             │
│  │  • Personality & model config             │             │
│  │  • Channel connections (Slack, WA, TG)    │             │
│  │  • Usage metrics & billing                │             │
│  └──────────────────────────────────────────┘             │
│                                                            │
│  ┌──────────────────────────────────────────┐             │
│  │          SSH TUNNEL POOL (Redis)          │             │
│  │  • Lazy connections (open on activity)    │             │
│  │  • ~50-100 concurrent at 1K customers     │             │
│  │  • Auto-close after 15 min idle           │             │
│  └──────────────────────────────────────────┘             │
└────────────────────────┬──────────────────────────────────┘
                         │ SSH Tunnel (per customer)
                         ▼
┌───────────────────────────────────────────────────────────┐
│              CUSTOMER VPS (1 per customer)                  │
│              Hetzner — Provisioned from snapshot             │
│                                                            │
│  ┌──────────────────────────────────────────┐             │
│  │      OpenClaw Gateway (127.0.0.1:{port}) │             │
│  │      Random port, loopback only           │             │
│  │      Auth token required                  │             │
│  │                                           │             │
│  │  Agent 1 ──┬── Slack (Socket Mode)        │             │
│  │  (CEO)     ├── WebSocket ← Dashboard      │             │
│  │            └── Email (IMAP/SMTP)          │             │
│  │                                           │             │
│  │  Agent 2 ──┬── WhatsApp (Baileys)         │             │
│  │  (Support) ├── Telegram (grammY)          │             │
│  │            └── WebSocket ← Dashboard      │             │
│  │                                           │             │
│  │  Agent ↔ Agent: sessions_send / spawn     │             │
│  └──────────────────────────────────────────┘             │
│                                                            │
│  AI Model calls → OpenRouter API (single key)              │
│  UFW Firewall: only SSH from Otto control plane IP         │
└───────────────────────────────────────────────────────────┘
```

---

## Core Components

### Control Plane (Otto Backend)

| Component | Tech | Purpose |
|-----------|------|---------|
| API Server | Node.js (Fastify) | Dashboard API, WebSocket proxy, agent CRUD |
| Auth | Google OAuth 2.0 | Customer sign-in |
| Billing | Stripe | Subscriptions + usage metering |
| Database | PostgreSQL | Customers, agents, subscriptions, VPS metadata |
| Session cache | Redis | WebSocket sessions, SSH tunnel pool, rate limiting |
| Provisioning | Hetzner API + Pool Worker | VPS from snapshots, auto-assign on signup |
| QR Relay | Existing service | WhatsApp device linking |

### Customer VPS (OpenClaw Instance)

Pre-configured via Hetzner snapshot:

- Ubuntu 24.04 + Node.js 22
- OpenClaw installed globally
- Systemd service for Gateway auto-start
- Random port (20000–60000) + auth token
- UFW: only SSH (port 22) from Otto control plane IP
- OpenRouter API key injected at provisioning
- IMAP/SMTP email skill pre-installed

### Dashboard (Frontend)

| Screen | Features |
|--------|----------|
| **Agent Overview** | Card grid of all agents, status indicators, quick stats |
| **Agent Config** | Name, avatar, role, personality editor (SOUL.md), model selection, tool permissions |
| **Live Chat** | WebSocket chat with any agent, file upload, session selector, agent-switching sidebar |
| **Channel Setup** | Slack OAuth install, WhatsApp QR scan, Telegram bot token, status per channel |
| **Email Setup** | Guided flow: enter Gmail/Workspace address + App Password, test connection |
| **Usage & Billing** | Message volume, API token usage, current plan, invoices |

---

## AI Model Strategy (OpenRouter)

**Decision: Use OpenRouter as the unified AI gateway.**

### Why OpenRouter

- **One API key, 300+ models** — no need for separate Anthropic, OpenAI, Google keys
- **OpenAI-compatible API** — drop-in with OpenClaw, zero custom code
- **Pay-as-you-go** — no monthly minimums, credits don't expire
- **Auto-routing** — `openrouter/auto` automatically picks the most cost-effective model per request
- **5.5% platform fee** on credit purchases — negligible vs. the operational simplicity
- **Built-in fallbacks** — if Claude is down, automatically routes to a fallback model

### Model configuration per VPS

```json5
{
  "models": {
    "openrouter": {
      "apiKey": "sk-or-..."  // Otto's master OpenRouter key
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/anthropic/claude-sonnet-4-5",
        "fallbacks": [
          "openrouter/anthropic/claude-haiku-4-5",
          "openrouter/google/gemini-3-flash-preview"
        ]
      }
    }
  }
}
```

### Cost strategy

| Tier | Default model | Fallback | Approx. cost per message |
|------|--------------|----------|--------------------------|
| Standard | Claude Sonnet 4.5 ($3/$15 per 1M tokens) | Haiku 4.5 | ~$0.005–0.02 |
| Premium (Enterprise) | Claude Opus 4.6 ($15/$75) | Sonnet 4.5 | ~$0.03–0.15 |
| Budget tasks (heartbeats, classification) | openrouter/auto | — | ~$0.001 |

### For the customer

The customer **never sees an API key**. Otto manages the OpenRouter account centrally. Usage is metered per customer via OpenRouter's activity API and billed through Stripe as part of their plan.

---

## Security Model

### Network security (per customer VPS)

| Layer | Implementation |
|-------|---------------|
| **Random port** | Gateway on port 20000–60000 (assigned at provisioning) |
| **Loopback bind** | `gateway.bind: "loopback"` — not reachable from the internet |
| **SSH tunnel** | Otto control plane → VPS via SSH. Only way to reach the Gateway |
| **Auth token** | 256-bit random token required for all Gateway connections |
| **UFW firewall** | All inbound blocked except SSH (port 22) from Otto control plane IP only |
| **Non-root execution** | OpenClaw runs as a dedicated non-root user |

### Data isolation

| Concern | Solution |
|---------|----------|
| Customer data | 1 VPS per customer, no shared databases |
| Agent isolation | Separate workspace, sessions, auth per agent (OpenClaw native) |
| API keys | OpenRouter key injected at provisioning, never stored in Otto DB |
| Email credentials | Stored in agent `.env` on VPS only |
| Channel credentials | WhatsApp session files, bot tokens — all on customer VPS |

### Channel security (Slack focus)

```json5
{
  "channels": {
    "slack": {
      "mode": "socket",                   // No public URL needed
      "dmPolicy": "allowlist",            // Only approved users
      "allowFrom": ["U_OWNER_SLACK_ID"],  // Business owner only
      "groupPolicy": "allowlist",         // No channels unless explicit
      "channels": {}                      // Empty = locked down
    }
  }
}
```

Socket Mode means the VPS connects outbound to Slack — no incoming webhooks, no ports to expose.

---

## Agent Email

### How it works

1. Customer creates a Gmail/Google Workspace account for the agent (e.g., `ceo@theircompany.com`)
2. Enables 2FA and generates an **App Password**
3. Provides credentials via the dashboard (guided flow)
4. Otto writes credentials to the agent's `.env` on the VPS
5. OpenClaw's `imap-smtp-email` skill monitors the inbox (cron: every 5 min)
6. Agent can read, search, reply, and process attachments

### VPS configuration

```bash
# ~/.openclaw/agents/ceo/workspace/.env
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=ceo@theircompany.com
IMAP_PASS=xxxx-xxxx-xxxx-xxxx   # App Password
IMAP_TLS=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=ceo@theircompany.com
SMTP_PASS=xxxx-xxxx-xxxx-xxxx
SMTP_SECURE=true
```

### Important notes

- **Recommend Google Workspace** ($6/mo per inbox) over free Gmail — more stable for automation, lower ban risk
- App Password required (2FA must be enabled)
- Credentials stay on customer VPS only — never in Otto's central database
- **Future upgrade**: integrate AgentMail for programmatic inbox creation (API-based, no OAuth)

---

## Multi-Channel Communication

### Cross-channel session continuity

By default, OpenClaw uses `session.dmScope: "main"` — all channels feed into the same session:

```
Dashboard (WebChat) ──┐
Slack ────────────────┼──→ agent:ceo:main (single session)
WhatsApp ─────────────┤
Telegram ─────────────┘
```

The user can start a conversation on the dashboard, continue on Slack from their phone, and follow up on WhatsApp later. **Same agent brain, same memory, same context.**

### Channel priority for SMEs

| Priority | Channel | Why | Setup complexity |
|----------|---------|-----|-----------------|
| 1 | **Dashboard** | Always available, richest UI | Built-in (WebChat) |
| 2 | **Slack** | Official API, Socket Mode (no public URL), enterprise-ready, DM allowlists | ~10 min (OAuth flow) |
| 3 | **WhatsApp** | Customer-facing support use cases | ~5 min (QR scan) but less stable |
| 4 | **Telegram** | Additional option for tech-savvy users | ~5 min (BotFather token) |

---

## Agent-to-Agent Communication

All agents run on **one VPS, one Gateway process**. They're isolated but can communicate via two built-in mechanisms:

### `sessions_send` — Direct conversations

Agents message each other with up to 5 back-and-forth exchanges:

```json5
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["ceo", "cfo", "support", "marketing"]
    }
  }
}
```

Example: Support agent receives a complex complaint → sends message to CEO agent → CEO responds with strategy → Support replies to customer.

### `sessions_spawn` — Task delegation

An agent spawns background work for another agent:

```
CEO: "CFO, analyze last month's expenses"
  → sessions_spawn(agentId="cfo", task="Analyze expenses...")
  → CFO runs in isolated sub-session
  → CFO completes, announces result back to CEO
```

### Why one VPS is enough

OpenClaw is a single Node.js process. AI inference happens on OpenRouter's servers, not the VPS. A CX32 (4 vCPU, 8GB) comfortably runs 5–10 agents. Multiple VPS only needed at 15+ agents.

---

## Scalability (1,000+ Customers)

### Why it scales

Each customer runs on their own VPS — the control plane only handles auth, billing, and WebSocket proxying. It doesn't run AI.

### Architecture for scale

```
              Load Balancer (nginx / Cloudflare)
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    API Server 1   API Server 2   API Server 3
          │              │              │
    ┌─────┴──────────────┴──────────────┴─────┐
    │           Shared Services                │
    │  PostgreSQL (managed) │ Redis (sessions) │
    │  Stripe webhooks      │ VPS Pool Worker  │
    └─────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    Customer VPS 1  Customer VPS 2  ... VPS 1000
```

### Key numbers

| Metric | Value |
|--------|-------|
| Concurrent SSH tunnels | ~50–100 (lazy pool, not 1,000 persistent) |
| VPS cost (1,000 × CX22) | ~€4,000/mo |
| Revenue (1,000 × €49 min) | ~€49,000/mo |
| Gross margin | ~92% before API costs |
| API server capacity | 3 instances handle 10K+ WebSocket connections |
| VPS provisioning | Pool of 10–20 pre-built, refill async |

### Stateless design

- API servers are stateless — sessions in Redis, data in PostgreSQL
- Horizontal scaling: add API instances behind load balancer
- SSH tunnel pool: open on user activity, close after 15 min idle
- Health checks: lightweight HTTP ping to each VPS every 5 min

---

## Pricing

### Competitor landscape

| Platform | Type | Price range |
|----------|------|------------|
| Lindy | No-code AI agents | Free → $37/mo |
| Gumloop | AI workflow automation | Free → $244/mo |
| Make | Workflow builder | Free → $18.82/mo |
| Clay | AI sales workflows | $149–$349/mo |
| OpenClaw Setup | Managed hosting only | From $3.90/mo |
| 11x.ai | Autonomous AI SDR | Custom (~$1K+/mo) |

### Otto pricing

**"AI employee" positioning — cheaper than any human hire.**

| Plan | Agents | Channels | VPS | AI Usage Included | Price |
|------|--------|----------|-----|-------------------|-------|
| **Solo** | 1 agent | Dashboard + 1 channel | CX22 (2 vCPU, 4GB) | ~2,000 messages/mo | **€49/mo** |
| **Team** | Up to 5 agents | All channels + inter-agent | CX32 (4 vCPU, 8GB) | ~6,000 messages/mo | **€149/mo** |
| **Enterprise** | Unlimited agents | All channels + custom | CX42+ | ~20,000 messages/mo | **€349+/mo** |

Overage: €0.005/message (Sonnet) or €0.05/message (Opus).

---

## Roadmap & Time Estimates

### Phase 1 — Dashboard MVP + Slack (5–6 weeks)

**Goal: Customer can sign up, create an agent, chat with it from the dashboard and Slack.**

| Task | Est. | Notes |
|------|------|-------|
| Dashboard frontend (React/Next.js) — layout, auth, routing | 1 week | Shell with Google OAuth integration |
| Agent CRUD API + database schema extension | 3–4 days | Create/update/delete agents, store config |
| Agent creation wizard (name, role, personality → SOUL.md generation) | 3–4 days | Pushes config to VPS via SSH |
| Live chat (WebSocket proxy: Dashboard → SSH tunnel → OpenClaw WebChat) | 1 week | Core feature — real-time bidirectional |
| Slack channel setup flow (OAuth install in dashboard) | 3–4 days | User clicks "Connect Slack", installs app |
| OpenRouter integration (replace direct Anthropic key) | 1–2 days | Update VPS snapshot config |
| Update VPS snapshot (random port, loopback, auth token, OpenRouter) | 2–3 days | Security hardening |
| Stripe plan updates (Solo/Team/Enterprise tiers) | 2–3 days | Already have Stripe working |
| Testing + polish | 3–4 days | End-to-end flows |

**Total Phase 1: ~5–6 weeks**

### Phase 2 — Multi-Agent + WhatsApp + Telegram (4–5 weeks)

**Goal: Customer can create multiple agents that talk to each other, across all channels.**

| Task | Est. | Notes |
|------|------|-------|
| Multi-agent UI (add/remove agents, agent switcher) | 1 week | Dashboard grid view, per-agent config |
| Multi-agent VPS config generation | 3–4 days | Generate openclaw.json with agents.list + bindings |
| Agent-to-agent configuration (sessions_send/spawn) | 2–3 days | Enable tools.agentToAgent per customer |
| WhatsApp setup flow (existing QR relay integration) | 2–3 days | Already built — integrate into new dashboard |
| Telegram setup flow (bot token input + verify) | 2–3 days | Simple form + API test |
| Personality editor (visual SOUL.md / AGENTS.md editor) | 3–4 days | Rich text → markdown → push to VPS |
| Usage metering (OpenRouter activity API → Stripe usage records) | 3–4 days | Per-customer token tracking |
| Testing + polish | 3–4 days | Multi-agent scenarios |

**Total Phase 2: ~4–5 weeks**

### Phase 3 — Email + Analytics (3–4 weeks)

**Goal: Agents have email access, customers can see what their agents are doing.**

| Task | Est. | Notes |
|------|------|-------|
| Email setup flow in dashboard (Gmail/Workspace credentials) | 3–4 days | Guided form + connection test via VPS |
| IMAP skill auto-configuration on VPS | 2–3 days | Write .env, install skill, configure cron |
| Conversation history viewer (read session transcripts) | 3–4 days | Fetch JSONL from VPS, render in dashboard |
| Agent activity feed (what did the agent do today?) | 3–4 days | Heartbeat logs, email processing, task completions |
| Usage analytics dashboard (messages, tokens, cost) | 3–4 days | Charts, per-agent breakdown |
| Testing + polish | 2–3 days | |

**Total Phase 3: ~3–4 weeks**

### Phase 4 — Scale & Polish (ongoing)

| Task | Notes |
|------|-------|
| SSH tunnel pool manager (lazy connections, auto-close) | For 100+ customers |
| VPS health monitoring + auto-restart | Cron-based health checks |
| Agent template marketplace ("Import a pre-built CFO agent") | Community/curated templates |
| Custom domain for agent emails | `ai@customer.com` |
| Virtual phone numbers (WhatsApp Business API) | Eliminates need for customer SIM cards |
| White-label option | For agencies reselling Otto |
| Mobile app (optional) | Dedicated iOS/Android beyond just using WhatsApp |

### Overall timeline

| Phase | Duration | Cumulative |
|-------|----------|-----------|
| Phase 1 (Dashboard + Slack) | 5–6 weeks | 5–6 weeks |
| Phase 2 (Multi-agent + channels) | 4–5 weeks | 9–11 weeks |
| Phase 3 (Email + analytics) | 3–4 weeks | 12–15 weeks |
| **MVP to full product** | | **~3–4 months** |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React / Next.js, Tailwind CSS, WebSocket client |
| **Backend** | Node.js (Fastify), PostgreSQL, Redis |
| **Auth** | Google OAuth 2.0 |
| **Payments** | Stripe (subscriptions + usage metering) |
| **Provisioning** | Hetzner Cloud API, snapshot-based, pool worker |
| **Agent Runtime** | OpenClaw Gateway (per-customer VPS) |
| **AI Models** | OpenRouter (300+ models, single API key) |
| **Default model** | Claude Sonnet 4.5 via OpenRouter |
| **Channels** | Slack (Bolt/Socket Mode), WhatsApp (Baileys), Telegram (grammY) |
| **Email** | IMAP/SMTP skill (Gmail, Google Workspace) |
| **Monitoring** | Health checks from control plane, OpenRouter activity API |

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| AI provider | OpenRouter (not direct Anthropic) | One key, 300+ models, auto-fallback, no separate API setup |
| Primary channel | Slack first, then WhatsApp | Official API, Socket Mode (no public URL), DM allowlists, enterprise-ready |
| VPS security | Loopback + SSH tunnel + random port + auth token | Zero public exposure. Best practice from OpenClaw security docs |
| Agent email | User provides Gmail/Workspace credentials | Simple UX, data stays on VPS. Future: AgentMail for auto-provisioning |
| Session model | Shared across channels by default | Dashboard → Slack → WhatsApp all share same conversation context |
| Agent communication | Single VPS, sessions_send + sessions_spawn | Native OpenClaw feature, no need for multi-VPS per customer |
| API key management | Otto provides OpenRouter key, customer never sees it | SME customers shouldn't deal with API keys |
| Pricing model | Flat subscription + included AI usage | Predictable for SMEs, simple to understand |
