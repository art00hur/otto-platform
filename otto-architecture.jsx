import { useState } from "react";

const COLORS = {
  bg: "#0a0a0f",
  surface: "#12121a",
  surfaceHover: "#1a1a28",
  border: "#252540",
  borderActive: "#6366f1",
  accent: "#6366f1",
  accentGlow: "rgba(99, 102, 241, 0.15)",
  green: "#22c55e",
  greenGlow: "rgba(34, 197, 94, 0.15)",
  orange: "#f59e0b",
  orangeGlow: "rgba(245, 158, 11, 0.15)",
  red: "#ef4444",
  cyan: "#06b6d4",
  cyanGlow: "rgba(6, 182, 212, 0.15)",
  pink: "#ec4899",
  text: "#e2e2f0",
  textDim: "#8888a8",
  textMuted: "#55556a",
};

const Box = ({ x, y, w, h, label, sublabel, icon, color = COLORS.accent, items, selected, onClick, badge }) => {
  const isSelected = selected;
  return (
    <g
      onClick={onClick}
      style={{ cursor: "pointer" }}
    >
      <rect
        x={x} y={y} width={w} height={h} rx={8}
        fill={isSelected ? color + "18" : COLORS.surface}
        stroke={isSelected ? color : COLORS.border}
        strokeWidth={isSelected ? 2 : 1}
        filter={isSelected ? `drop-shadow(0 0 12px ${color}40)` : "none"}
      />
      {badge && (
        <g>
          <rect x={x + w - 50} y={y - 8} width={46} height={18} rx={9} fill={badge.color || COLORS.green} />
          <text x={x + w - 27} y={y + 5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff" fontFamily="'JetBrains Mono', monospace">{badge.text}</text>
        </g>
      )}
      <text x={x + 14} y={y + 22} fontSize={11} fill={COLORS.textMuted} fontFamily="'JetBrains Mono', monospace">{icon}</text>
      <text x={x + 30} y={y + 22} fontSize={13} fontWeight={700} fill={color} fontFamily="'JetBrains Mono', monospace">{label}</text>
      {sublabel && <text x={x + 14} y={y + 38} fontSize={10} fill={COLORS.textDim} fontFamily="'JetBrains Mono', monospace">{sublabel}</text>}
      {items && items.map((item, i) => (
        <text key={i} x={x + 14} y={y + (sublabel ? 54 : 40) + i * 16} fontSize={10} fill={COLORS.textDim} fontFamily="'JetBrains Mono', monospace">
          {item}
        </text>
      ))}
    </g>
  );
};

const Arrow = ({ x1, y1, x2, y2, color = COLORS.textMuted, label, dashed }) => {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  return (
    <g>
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={color} strokeWidth={1.5}
        strokeDasharray={dashed ? "6 4" : "none"}
        markerEnd="url(#arrowhead)"
      />
      {label && (
        <g>
          <rect x={midX - label.length * 3.2} y={midY - 8} width={label.length * 6.4} height={14} rx={3} fill={COLORS.bg} stroke={COLORS.border} strokeWidth={0.5} />
          <text x={midX} y={midY + 3} textAnchor="middle" fontSize={8} fill={color} fontFamily="'JetBrains Mono', monospace">{label}</text>
        </g>
      )}
    </g>
  );
};

const CurvedArrow = ({ x1, y1, x2, y2, cx, cy, color = COLORS.textMuted, label }) => {
  const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  const midX = (x1 + 2 * cx + x2) / 4;
  const midY = (y1 + 2 * cy + y2) / 4;
  return (
    <g>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} markerEnd="url(#arrowhead)" />
      {label && (
        <g>
          <rect x={midX - label.length * 3.2} y={midY - 8} width={label.length * 6.4} height={14} rx={3} fill={COLORS.bg} stroke={COLORS.border} strokeWidth={0.5} />
          <text x={midX} y={midY + 3} textAnchor="middle" fontSize={8} fill={color} fontFamily="'JetBrains Mono', monospace">{label}</text>
        </g>
      )}
    </g>
  );
};

const SectionLabel = ({ x, y, text, color = COLORS.textMuted }) => (
  <text x={x} y={y} fontSize={10} fontWeight={600} fill={color} fontFamily="'JetBrains Mono', monospace" letterSpacing={2} textTransform="uppercase">
    {text}
  </text>
);

const details = {
  controlPlane: {
    title: "Control Plane",
    subtitle: "Otto Backend — Hetzner VPS (${BACKEND_VPS_IP})",
    tech: "Node.js (Fastify) + PostgreSQL + Redis",
    points: [
      "Handles auth, billing, provisioning, and WebSocket proxying",
      "Stateless API servers — sessions in Redis, data in PostgreSQL",
      "SSH tunnel pool: lazy connections, auto-close after 15min idle",
      "Manages all customer VPS lifecycle via Hetzner API",
      "Never runs AI inference — just orchestrates",
    ],
  },
  auth: {
    title: "Authentication",
    subtitle: "Google OAuth 2.0 → JWT",
    tech: "HMAC-SHA256, 72h expiry (1h for redirects)",
    points: [
      "Google ID token verified with Google's API",
      "JWT issued with userId, checked on every request",
      "Rate limited: 10 attempts/min per IP on auth routes",
      "All API routes require JWT + ownership verification",
    ],
  },
  billing: {
    title: "Stripe Billing",
    subtitle: "Subscriptions + Usage Metering",
    tech: "Stripe Checkout + Webhooks",
    points: [
      "Solo €49 | Team €149 | Enterprise €349+/mo",
      "checkout.session.completed → create subscription + assign VPS",
      "Webhook signature verified via fastify-raw-body",
      "Usage metered per customer via OpenRouter activity API",
      "30-day money-back guarantee",
    ],
  },
  provision: {
    title: "Provisioning",
    subtitle: "Hetzner API + Pool Worker",
    tech: "Snapshot-based, ~2-4min per instance",
    points: [
      "Pool worker maintains 1+ ready instances",
      "Snapshot: Ubuntu 24.04 + Node.js 22 + OpenClaw (pinned version)",
      "Random port (20000-60000) + 256-bit auth token",
      "Control plane SSH key injected for admin access",
      "UFW hardened: SSH only from control plane IP",
      "OpenRouter API key injected at provisioning time",
    ],
  },
  dashboard: {
    title: "Dashboard",
    subtitle: "React/Next.js Web App",
    tech: "WebSocket chat, Google Sign-In, Stripe checkout",
    points: [
      "Login → Plan selection → Stripe → Dashboard",
      "Real-time chat via WebSocket proxy to OpenClaw Gateway",
      "Agent status, credits bar, plan info",
      "Markdown rendering with DOMPurify sanitization",
      "CSP headers, exponential backoff reconnect",
    ],
  },
  sshTunnel: {
    title: "SSH Tunnel Pool",
    subtitle: "Secure connection to customer VPS",
    tech: "node-ssh, lazy connections, Redis-cached",
    points: [
      "Backend → SSH → port forward → loopback gateway",
      "~50-100 concurrent tunnels at 1K customers",
      "Auto-close after 15min idle",
      "Browser never sees VPS IP, port, or token",
      "AES-256-GCM encrypted SSH keys in DB",
    ],
  },
  customerVPS: {
    title: "Customer VPS",
    subtitle: "1 dedicated VPS per customer (Hetzner CPX11)",
    tech: "Ubuntu 24.04 + OpenClaw Gateway",
    points: [
      "Complete data isolation — no shared databases",
      "Gateway bound to 127.0.0.1 (loopback only)",
      "controlUi: dangerouslyDisableDeviceAuth + AllowHostHeaderOriginFallback",
      "OpenRouter API key on VPS only, never in Otto DB",
      "Channel credentials (WhatsApp, Slack) stored on VPS only",
      "Systemd service for auto-start on boot",
    ],
  },
  gateway: {
    title: "OpenClaw Gateway",
    subtitle: "AI Agent Runtime (per customer)",
    tech: "Single Node.js process, all agents",
    points: [
      "Handles WebSocket connections from dashboard proxy",
      "Manages agent sessions, memory, and context",
      "Agent-to-agent: sessions_send / sessions_spawn",
      "Cross-channel session continuity (dmScope: per-channel-peer)",
      "CX32 handles 5-10 agents comfortably",
    ],
  },
  openrouter: {
    title: "OpenRouter",
    subtitle: "Unified AI Gateway (300+ models)",
    tech: "Single API key, pay-as-you-go, 5.5% fee",
    points: [
      "Default: Claude Sonnet 4.5 ($3/$15 per 1M tokens)",
      "Fallbacks: Haiku 4.5, Gemini 3 Flash",
      "Enterprise: Claude Opus 4.6 ($15/$75)",
      "Auto-routing via openrouter/auto for budget tasks",
      "Built-in fallbacks if a provider is down",
    ],
  },
  channels: {
    title: "Communication Channels",
    subtitle: "Multi-channel AI agent access",
    tech: "Dashboard + Slack + WhatsApp + Telegram + Email",
    points: [
      "Dashboard: WebSocket (always available, richest UI)",
      "Slack: Socket Mode (no public URL, enterprise-ready)",
      "WhatsApp: Baileys (QR scan, customer-facing)",
      "Telegram: grammY (bot token, tech-savvy users)",
      "Email: Gmail IMAP/SMTP skill (cron every 5min)",
      "All channels share same agent session by default",
    ],
  },
  security: {
    title: "Security Model",
    subtitle: "Defense in depth, zero public exposure",
    tech: "AES-256-GCM + SSH + UFW + JWT + CSP",
    points: [
      "Gateway: loopback only + random port + auth token",
      "SSH tunnel: only way to reach gateway",
      "UFW: all inbound blocked except SSH from control plane",
      "JWT: HMAC-SHA256, ownership verified per request",
      "Encryption: AES-256-GCM for SSH keys & tokens in DB",
      "CSP + DOMPurify + X-Frame-Options on dashboard",
      "No sensitive data in any API response",
    ],
  },
};

export default function OttoArchitecture() {
  const [selected, setSelected] = useState("controlPlane");
  const detail = details[selected];

  return (
    <div style={{
      background: COLORS.bg,
      minHeight: "100vh",
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      color: COLORS.text,
      display: "flex",
      flexDirection: "column",
      padding: "20px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <div style={{ textAlign: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color: COLORS.accent }}>🤖 Otto</span>
        <span style={{ fontSize: 14, color: COLORS.textDim, marginLeft: 12 }}>Platform Architecture</span>
      </div>

      <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
        {/* SVG Diagram */}
        <div style={{ flex: "1 1 65%", background: COLORS.surface, borderRadius: 12, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <svg viewBox="0 0 900 620" style={{ width: "100%", height: "100%" }}>
            <defs>
              <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={COLORS.textMuted} />
              </marker>
            </defs>

            {/* Background grid */}
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke={COLORS.border} strokeWidth={0.3} opacity={0.3} />
            </pattern>
            <rect width="900" height="620" fill="url(#grid)" />

            {/* ═══ SECTION: USERS ═══ */}
            <SectionLabel x={30} y={30} text="USERS" color={COLORS.pink} />

            {/* Browser */}
            <Box x={20} y={40} w={140} h={55} label="Browser" sublabel="otto-ai.co" icon="🌐"
              color={COLORS.pink} selected={selected === "dashboard"} onClick={() => setSelected("dashboard")} />

            {/* Slack / WhatsApp / Telegram */}
            <Box x={20} y={105} w={140} h={70} label="Channels" icon="📱"
              color={COLORS.pink} selected={selected === "channels"} onClick={() => setSelected("channels")}
              items={["Slack · WhatsApp", "Telegram · Email"]} />

            {/* ═══ SECTION: CONTROL PLANE ═══ */}
            <SectionLabel x={200} y={30} text="CONTROL PLANE — ${BACKEND_VPS_IP}" color={COLORS.accent} />

            {/* Control Plane box */}
            <rect x={190} y={38} width={390} height={240} rx={10} fill="none" stroke={COLORS.accent} strokeWidth={1} strokeDasharray="4 3" opacity={0.4} />

            {/* Auth */}
            <Box x={205} y={50} w={115} h={65} label="Auth" sublabel="Google OAuth" icon="🔐"
              color={COLORS.accent} selected={selected === "auth"} onClick={() => setSelected("auth")}
              items={["JWT tokens"]} badge={{ text: "✓", color: COLORS.green }} />

            {/* Billing */}
            <Box x={330} y={50} w={115} h={65} label="Billing" sublabel="Stripe" icon="💳"
              color={COLORS.accent} selected={selected === "billing"} onClick={() => setSelected("billing")}
              items={["Webhooks"]} badge={{ text: "✓", color: COLORS.green }} />

            {/* Provisioning */}
            <Box x={455} y={50} w={115} h={65} label="Provision" sublabel="Hetzner API" icon="⚙️"
              color={COLORS.accent} selected={selected === "provision"} onClick={() => setSelected("provision")}
              items={["Pool worker"]} badge={{ text: "✓", color: COLORS.green }} />

            {/* API Server */}
            <Box x={205} y={130} w={175} h={60} label="API Server" sublabel="Fastify + WebSocket proxy" icon="🖥"
              color={COLORS.accent} selected={selected === "controlPlane"} onClick={() => setSelected("controlPlane")}
              items={["Stateless, Redis sessions"]} />

            {/* Dashboard */}
            <Box x={390} y={130} w={180} h={60} label="Dashboard" sublabel="React SPA" icon="📊"
              color={COLORS.accent} selected={selected === "dashboard"} onClick={() => setSelected("dashboard")}
              items={["Chat, config, billing"]} />

            {/* DB + Redis */}
            <Box x={205} y={205} w={120} h={60} label="PostgreSQL" sublabel="Railway (→Hetzner)" icon="🗄"
              color={COLORS.orange} selected={false} onClick={() => setSelected("controlPlane")}
              items={["Users, subs, VPS"]} />
            <Box x={335} y={205} w={100} h={60} label="Redis" sublabel="Sessions" icon="⚡"
              color={COLORS.orange} selected={false} onClick={() => setSelected("controlPlane")}
              items={["WS, tunnels"]} />

            {/* SSH Tunnel Pool */}
            <Box x={445} y={205} w={125} h={60} label="SSH Pool" sublabel="Lazy tunnels" icon="🔒"
              color={COLORS.cyan} selected={selected === "sshTunnel"} onClick={() => setSelected("sshTunnel")}
              items={["~50-100 conc."]} />

            {/* ═══ SECTION: CUSTOMER VPS ═══ */}
            <SectionLabel x={200} y={310} text="CUSTOMER VPS (1 PER CUSTOMER)" color={COLORS.green} />

            {/* Customer VPS box */}
            <rect x={190} y={318} width={500} height={180} rx={10} fill="none" stroke={COLORS.green} strokeWidth={1} strokeDasharray="4 3" opacity={0.4} />

            {/* Gateway */}
            <Box x={205} y={330} w={220} h={80} label="OpenClaw Gateway" sublabel="127.0.0.1:{random port}" icon="🧠"
              color={COLORS.green} selected={selected === "gateway"} onClick={() => setSelected("gateway")}
              items={["Auth token required", "systemd auto-start", "dangerouslyDisable*: true"]} />

            {/* Agents */}
            <Box x={440} y={330} w={120} h={80} label="Agents" sublabel="AI Employees" icon="🤖"
              color={COLORS.green} selected={selected === "gateway"} onClick={() => setSelected("gateway")}
              items={["CEO · CFO", "Support · Mktg", "sessions_send"]} />

            {/* Security */}
            <Box x={205} y={420} w={220} h={65} label="Security" sublabel="Zero public exposure" icon="🛡"
              color={COLORS.red} selected={selected === "security"} onClick={() => setSelected("security")}
              items={["UFW: SSH from ctrl plane only", "Loopback + random port + token"]} />

            {/* Channel Connectors */}
            <Box x={440} y={420} w={120} h={65} label="Connectors" sublabel="On VPS only" icon="🔌"
              color={COLORS.green} selected={selected === "channels"} onClick={() => setSelected("channels")}
              items={["WA session files", "Slack/TG tokens"]} />

            {/* VPS Config */}
            <Box x={575} y={330} w={105} h={155} label="Config" sublabel="On VPS" icon="📁"
              color={COLORS.green} selected={selected === "customerVPS"} onClick={() => setSelected("customerVPS")}
              items={["openclaw.json", "OpenRouter key", "IMAP creds", "Agent SOUL.md", "Channel tokens", ".env files"]} />

            {/* ═══ SECTION: EXTERNAL SERVICES ═══ */}
            <SectionLabel x={200} y={530} text="EXTERNAL SERVICES" color={COLORS.cyan} />

            {/* OpenRouter */}
            <Box x={205} y={540} w={200} h={65} label="OpenRouter" sublabel="300+ AI models, 1 API key" icon="🧪"
              color={COLORS.cyan} selected={selected === "openrouter"} onClick={() => setSelected("openrouter")}
              items={["Sonnet 4.5 → Haiku → Gemini", "5.5% fee, auto-fallback"]} />

            {/* Hetzner */}
            <Box x={420} y={540} w={140} h={65} label="Hetzner" sublabel="Cloud VPS" icon="☁️"
              color={COLORS.cyan} selected={false} onClick={() => setSelected("provision")}
              items={["CPX11 €4.85/mo", "Snapshot-based"]} />

            {/* Stripe */}
            <Box x={575} y={540} w={110} h={65} label="Stripe" sublabel="Payments" icon="💰"
              color={COLORS.cyan} selected={false} onClick={() => setSelected("billing")}
              items={["3 plans", "Webhooks"]} />

            {/* Google */}
            <Box x={700} y={540} w={110} h={65} label="Google" sublabel="OAuth 2.0" icon="🔑"
              color={COLORS.cyan} selected={false} onClick={() => setSelected("auth")}
              items={["Sign-In", "ID tokens"]} />

            {/* ═══ ARROWS ═══ */}

            {/* Browser → API Server */}
            <Arrow x1={160} y1={67} x2={205} y2={155} color={COLORS.pink} label="HTTPS + WSS" />

            {/* Channels → Customer VPS (direct) */}
            <CurvedArrow x1={140} y1={175} x2={205} y2={390} cx={170} cy={290} color={COLORS.pink} label="Direct" />

            {/* API Server → SSH Pool */}
            <Arrow x1={380} y1={165} x2={445} y2={230} color={COLORS.accent} label="proxy" />

            {/* SSH Pool → Gateway */}
            <Arrow x1={507} y1={265} x2={370} y2={330} color={COLORS.cyan} label="SSH tunnel" />

            {/* Gateway → OpenRouter */}
            <Arrow x1={315} y1={410} x2={305} y2={540} color={COLORS.cyan} label="AI inference" />

            {/* Provisioning → Hetzner */}
            <Arrow x1={512} y1={115} x2={490} y2={540} color={COLORS.orange} label="create VPS" dashed />

            {/* Agents ↔ each other */}
            <CurvedArrow x1={500} y1={330} x2={500} y2={410} cx={530} cy={370} color={COLORS.green} />

          </svg>
        </div>

        {/* Detail Panel */}
        <div style={{
          flex: "0 0 300px",
          background: COLORS.surface,
          borderRadius: 12,
          border: `1px solid ${COLORS.border}`,
          padding: 20,
          overflow: "auto",
        }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 8 }}>
            COMPONENT DETAIL
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.accent, marginBottom: 4 }}>
            {detail.title}
          </div>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginBottom: 12 }}>
            {detail.subtitle}
          </div>
          <div style={{
            fontSize: 10,
            color: COLORS.cyan,
            background: COLORS.cyanGlow,
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 16,
            border: `1px solid ${COLORS.cyan}30`,
          }}>
            {detail.tech}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {detail.points.map((point, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ color: COLORS.green, fontSize: 10, marginTop: 2, flexShrink: 0 }}>▸</span>
                <span style={{ fontSize: 11, color: COLORS.textDim, lineHeight: 1.5 }}>{point}</span>
              </div>
            ))}
          </div>

          <div style={{
            marginTop: 24,
            padding: "12px",
            background: COLORS.bg,
            borderRadius: 8,
            border: `1px solid ${COLORS.border}`,
          }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 8 }}>
              KEY NUMBERS
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "VPS/customer", value: "€4.85" },
                { label: "Min revenue", value: "€49/mo" },
                { label: "Gross margin", value: "~62%" },
                { label: "Provision time", value: "~2min" },
                { label: "SSH tunnels @1K", value: "50-100" },
                { label: "Agents/VPS", value: "5-10" },
              ].map((item, i) => (
                <div key={i}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: COLORS.accent }}>{item.value}</div>
                  <div style={{ fontSize: 9, color: COLORS.textMuted }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            marginTop: 16,
            padding: "12px",
            background: COLORS.bg,
            borderRadius: 8,
            border: `1px solid ${COLORS.border}`,
          }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: COLORS.textMuted, letterSpacing: 2, marginBottom: 8 }}>
              CLICK ANY BOX FOR DETAILS
            </div>
            <div style={{ fontSize: 10, color: COLORS.textDim, lineHeight: 1.6 }}>
              Interactive architecture map. Each component shows its tech stack, configuration, and key design decisions.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
