import { useState, useMemo } from "react";

function Slider({ label, value, onChange, min, max, step = 1, format, color = "#6366f1" }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: "#8888a8" }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#e2e2f0" }}>
          {format ? format(value) : value}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: color, height: 4 }} />
    </div>
  );
}

function CostBar({ label, value, maxVal, color }) {
  const pct = Math.min((value / maxVal) * 100, 100);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: "#8888a8" }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>€{value.toFixed(2)}</span>
      </div>
      <div style={{ width: "100%", height: 6, background: "#1a1a2e", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 3, transition: "width 0.3s ease",
          boxShadow: `0 0 6px ${color}50`,
        }} />
      </div>
    </div>
  );
}

function PlanCard({ name, price, credit, agents, vpsCost, stripeFee, infraShare, margin, marginPct, color, creditPct }) {
  const totalCost = price - margin;
  const statusColor = marginPct >= 60 ? "#22c55e" : marginPct >= 40 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{
      background: "#12121a", border: `1px solid ${color}30`, borderRadius: 12,
      padding: "22px 24px", flex: 1, minWidth: 250,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 10, color: "#8888a8", letterSpacing: 2, fontWeight: 600 }}>{name.toUpperCase()}</div>
          <div style={{ fontSize: 30, fontWeight: 800, color }}>
            €{price}<span style={{ fontSize: 14, color: "#55556a" }}>/mo</span>
          </div>
        </div>
        <div style={{
          background: `${statusColor}18`, border: `1px solid ${statusColor}40`,
          borderRadius: 8, padding: "8px 14px", textAlign: "center",
        }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: statusColor }}>{marginPct.toFixed(0)}%</div>
          <div style={{ fontSize: 8, color: "#8888a8", letterSpacing: 1.5 }}>MARGIN</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <div style={{ flex: 1, background: `${color}10`, border: `1px solid ${color}20`, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color }}>{agents}</div>
          <div style={{ fontSize: 9, color: "#8888a8" }}>agent{agents > 1 ? "s" : ""}</div>
        </div>
        <div style={{ flex: 1, background: `${color}10`, border: `1px solid ${color}20`, borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color }}>€{credit}</div>
          <div style={{ fontSize: 9, color: "#8888a8" }}>AI credits</div>
        </div>
        <div style={{
          flex: 1, background: creditPct > 50 ? "#ef444410" : creditPct > 35 ? "#f59e0b10" : "#22c55e10",
          border: `1px solid ${creditPct > 50 ? "#ef4444" : creditPct > 35 ? "#f59e0b" : "#22c55e"}20`,
          borderRadius: 8, padding: "10px 12px", textAlign: "center",
        }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: creditPct > 50 ? "#ef4444" : creditPct > 35 ? "#f59e0b" : "#22c55e" }}>
            {creditPct.toFixed(0)}%
          </div>
          <div style={{ fontSize: 9, color: "#8888a8" }}>of price</div>
        </div>
      </div>

      <CostBar label="AI credits (OpenRouter)" value={credit} maxVal={price} color="#6366f1" />
      <CostBar label="VPS (Hetzner)" value={vpsCost} maxVal={price} color="#06b6d4" />
      <CostBar label="Stripe (2.9% + €0.25)" value={stripeFee} maxVal={price} color="#f59e0b" />
      <CostBar label="Backend infra" value={infraShare} maxVal={price} color="#8888a8" />

      <div style={{ borderTop: "1px solid #252540", paddingTop: 14, marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <div style={{ fontSize: 9, color: "#55556a" }}>TOTAL COST</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#ef4444" }}>€{totalCost.toFixed(2)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "#55556a" }}>PROFIT / USER</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#22c55e" }}>€{margin.toFixed(2)}</div>
        </div>
      </div>
    </div>
  );
}

const PRESETS = [
  { label: "Premium", sp: 89, tp: 219, ep: 449, sc: 26, tc: 69, ec: 155, sa: 1, ta: 3, ea: 10 },
  { label: "Mid-range", sp: 69, tp: 179, ep: 349, sc: 22, tc: 56, ec: 129, sa: 1, ta: 3, ea: 8 },
  { label: "Higher credits", sp: 89, tp: 219, ep: 449, sc: 35, tc: 86, ec: 190, sa: 1, ta: 3, ea: 10 },
  { label: "Max margin", sp: 89, tp: 219, ep: 449, sc: 17, tc: 52, ec: 112, sa: 1, ta: 3, ea: 10 },
];

export default function OttoMargins() {
  const [soloPrice, setSoloPrice] = useState(89);
  const [teamPrice, setTeamPrice] = useState(219);
  const [entPrice, setEntPrice] = useState(449);

  const [soloCredit, setSoloCredit] = useState(26);
  const [teamCredit, setTeamCredit] = useState(69);
  const [entCredit, setEntCredit] = useState(155);

  const [soloAgents, setSoloAgents] = useState(1);
  const [teamAgents, setTeamAgents] = useState(3);
  const [entAgents, setEntAgents] = useState(10);

  const [soloVPS, setSoloVPS] = useState(4.85);
  const [teamVPS, setTeamVPS] = useState(8.49);
  const [entVPS, setEntVPS] = useState(15.49);

  const [customerCount, setCustomerCount] = useState(100);
  const [soloPct, setSoloPct] = useState(55);
  const [teamPct, setTeamPct] = useState(30);
  const entPct = Math.max(0, 100 - soloPct - teamPct);

  const [claudeMax, setClaudeMax] = useState(172);    // ~$200 in EUR
  const [googleCloud, setGoogleCloud] = useState(9);   // ~$10
  const [namecheap, setNamecheap] = useState(13);      // ~$15
  const [otherFixed, setOtherFixed] = useState(0);
  const totalFixed = claudeMax + googleCloud + namecheap + otherFixed;

  const infraShare = 0.50;

  const applyPreset = (p) => {
    setSoloPrice(p.sp); setTeamPrice(p.tp); setEntPrice(p.ep);
    setSoloCredit(p.sc); setTeamCredit(p.tc); setEntCredit(p.ec);
    setSoloAgents(p.sa); setTeamAgents(p.ta); setEntAgents(p.ea);
  };

  const plans = useMemo(() => {
    const defs = [
      { name: "Solo", price: soloPrice, credit: soloCredit, agents: soloAgents, vpsCost: soloVPS, color: "#6366f1" },
      { name: "Pro", price: teamPrice, credit: teamCredit, agents: teamAgents, vpsCost: teamVPS, color: "#06b6d4" },
      { name: "Ultra", price: entPrice, credit: entCredit, agents: entAgents, vpsCost: entVPS, color: "#22c55e" },
    ];
    return defs.map(p => {
      const stripeFee = p.price * 0.029 + 0.25;
      const totalCost = p.credit + p.vpsCost + stripeFee + infraShare;
      const margin = p.price - totalCost;
      const marginPct = (margin / p.price) * 100;
      const creditPct = (p.credit / p.price) * 100;
      return { ...p, stripeFee, infraShare, margin, marginPct, totalCost, creditPct };
    });
  }, [soloPrice, teamPrice, entPrice, soloCredit, teamCredit, entCredit, soloAgents, teamAgents, entAgents, soloVPS, teamVPS, entVPS]);

  const portfolio = useMemo(() => {
    const counts = [
      Math.round(customerCount * soloPct / 100),
      Math.round(customerCount * teamPct / 100),
      Math.round(customerCount * entPct / 100),
    ];
    const totalRev = counts.reduce((s, c, i) => s + c * plans[i].price, 0);
    const varCost = counts.reduce((s, c, i) => s + c * plans[i].totalCost, 0);
    const totalCost = varCost + totalFixed;
    const totalProfit = totalRev - totalCost;
    const totalAI = counts.reduce((s, c, i) => s + c * plans[i].credit, 0);
    const blendedMargin = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0;
    return { counts, totalRev, totalCost, varCost, totalProfit, totalAI, blendedMargin, arr: totalRev * 12 };
  }, [plans, customerCount, soloPct, teamPct, entPct, totalFixed]);

  const minWageMonthly = 1810;  // FR SMIC chargé ~€1,810
  const vaMonthly = 700;

  return (
    <div style={{ background: "#0a0a0f", minHeight: "100vh", color: "#e2e2f0", fontFamily: "'JetBrains Mono', 'SF Mono', monospace", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 2, marginBottom: 4 }}>OTTO AI</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#6366f1" }}>Margin Calculator — Premium Positioning</div>
            <div style={{ fontSize: 11, color: "#8888a8", marginTop: 4 }}>All EUR · 100% credit burn · "AI employee" pricing</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PRESETS.map((p, i) => {
              const active = soloPrice === p.sp && soloCredit === p.sc && teamCredit === p.tc;
              return (
                <button key={i} onClick={() => applyPreset(p)} style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer",
                  border: `1px solid ${active ? "#6366f1" : "#252540"}`,
                  background: active ? "#6366f118" : "transparent",
                  color: active ? "#6366f1" : "#8888a8", fontFamily: "inherit",
                }}>{p.label}</button>
              );
            })}
          </div>
        </div>

        {/* Value comparison */}
        <div style={{ background: "#12121a", border: "1px solid #252540", borderRadius: 12, padding: "14px 20px", marginBottom: 18, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 1.5, fontWeight: 600, whiteSpace: "nowrap" }}>COST COMPARISON</div>
          {[
            { label: "SMIC chargé (FR)", cost: minWageMonthly, color: "#ef4444" },
            { label: "Virtual assistant", cost: vaMonthly, color: "#f59e0b" },
            { label: `Otto Solo (${soloAgents} agent)`, cost: soloPrice, color: "#6366f1" },
            { label: `Otto Pro (${teamAgents} agents)`, cost: teamPrice, color: "#06b6d4" },
            { label: `Otto Ultra (${entAgents} agents)`, cost: entPrice, color: "#22c55e" },
          ].map((item, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: Math.max(Math.round((item.cost / minWageMonthly) * 80), 8), height: 20, background: item.color, borderRadius: 3, boxShadow: `0 0 8px ${item.color}40` }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: item.color }}>€{item.cost.toLocaleString()}</div>
                <div style={{ fontSize: 8, color: "#55556a" }}>{item.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {/* Left panel */}
          <div style={{ flex: "0 0 280px" }}>
            {/* Plan prices */}
            <div style={{ background: "#12121a", border: "1px solid #6366f130", borderRadius: 12, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#6366f1", letterSpacing: 1.5, fontWeight: 600, marginBottom: 16 }}>PLAN PRICES & AGENTS</div>
              <Slider label="Solo price" value={soloPrice} onChange={setSoloPrice} min={39} max={129} step={1} format={v => `€${v}/mo`} color="#6366f1" />
              <Slider label="Solo agents" value={soloAgents} onChange={setSoloAgents} min={1} max={3} step={1} format={v => `${v} agent${v > 1 ? 's' : ''}`} color="#6366f1" />
              <div style={{ borderTop: "1px solid #252540", margin: "8px 0 12px" }} />
              <Slider label="Pro price" value={teamPrice} onChange={setTeamPrice} min={129} max={349} step={1} format={v => `€${v}/mo`} color="#06b6d4" />
              <Slider label="Pro agents" value={teamAgents} onChange={setTeamAgents} min={2} max={5} step={1} format={v => `${v} agents`} color="#06b6d4" />
              <div style={{ borderTop: "1px solid #252540", margin: "8px 0 12px" }} />
              <Slider label="Ultra price" value={entPrice} onChange={setEntPrice} min={249} max={699} step={1} format={v => `€${v}/mo`} color="#22c55e" />
              <Slider label="Ultra agents" value={entAgents} onChange={setEntAgents} min={5} max={15} step={1} format={v => `${v} agents`} color="#22c55e" />
            </div>

            {/* Credits */}
            <div style={{ background: "#12121a", border: "1px solid #252540", borderRadius: 12, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 1.5, fontWeight: 600, marginBottom: 16 }}>AI CREDITS (€)</div>
              <Slider label="Solo" value={soloCredit} onChange={setSoloCredit} min={5} max={Math.round(soloPrice * 0.7)} step={1} format={v => `€${v}`} color="#6366f1" />
              <Slider label="Pro" value={teamCredit} onChange={setTeamCredit} min={15} max={Math.round(teamPrice * 0.7)} step={1} format={v => `€${v}`} color="#06b6d4" />
              <Slider label="Ultra" value={entCredit} onChange={setEntCredit} min={30} max={Math.round(entPrice * 0.7)} step={5} format={v => `€${v}`} color="#22c55e" />
            </div>

            {/* VPS */}
            <div style={{ background: "#12121a", border: "1px solid #252540", borderRadius: 12, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 1.5, fontWeight: 600, marginBottom: 16 }}>VPS COSTS (€)</div>
              <Slider label={`Solo (CX22, ${soloAgents}ag)`} value={soloVPS} onChange={setSoloVPS} min={3} max={15} step={0.25} format={v => `€${v.toFixed(2)}`} color="#06b6d4" />
              <Slider label={`Pro (CX32, ${teamAgents}ag)`} value={teamVPS} onChange={setTeamVPS} min={5} max={22} step={0.25} format={v => `€${v.toFixed(2)}`} color="#06b6d4" />
              <Slider label={`Ultra (CX42+, ${entAgents}ag)`} value={entVPS} onChange={setEntVPS} min={8} max={40} step={0.5} format={v => `€${v.toFixed(2)}`} color="#06b6d4" />
            </div>

            {/* Margin health */}
            <div style={{ background: "#12121a", border: "1px solid #252540", borderRadius: 12, padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 1.5, fontWeight: 600, marginBottom: 12 }}>MARGIN HEALTH</div>
              {plans.map((p) => {
                const barColor = p.marginPct >= 60 ? "#22c55e" : p.marginPct >= 40 ? "#f59e0b" : "#ef4444";
                return (
                  <div key={p.name} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: p.color, fontWeight: 600 }}>{p.name} ({p.agents} ag)</span>
                      <span style={{ color: barColor, fontWeight: 700 }}>{p.marginPct.toFixed(0)}%</span>
                    </div>
                    <div style={{ width: "100%", height: 10, background: "#1a1a2e", borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ width: `${Math.max(p.marginPct, 0)}%`, height: "100%", background: barColor, borderRadius: 5, transition: "width 0.3s", boxShadow: `0 0 8px ${barColor}40` }} />
                    </div>
                    <div style={{ fontSize: 9, color: "#55556a", marginTop: 2 }}>€{p.credit} credits / €{p.price} price → €{p.margin.toFixed(0)} profit</div>
                  </div>
                );
              })}
            </div>

            {/* Fixed costs */}
            <div style={{ background: "#12121a", border: "1px solid #ef444430", borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 10, color: "#ef4444", letterSpacing: 1.5, fontWeight: 600, marginBottom: 16 }}>FIXED MONTHLY COSTS</div>
              <Slider label="Claude Max" value={claudeMax} onChange={setClaudeMax} min={0} max={180} step={1} format={v => `€${v}`} color="#ef4444" />
              <Slider label="Google Cloud" value={googleCloud} onChange={setGoogleCloud} min={0} max={80} step={1} format={v => `€${v}`} color="#ef4444" />
              <Slider label="Namecheap" value={namecheap} onChange={setNamecheap} min={0} max={40} step={1} format={v => `€${v}`} color="#ef4444" />
              <Slider label="Other" value={otherFixed} onChange={setOtherFixed} min={0} max={400} step={5} format={v => `€${v}`} color="#ef4444" />
              <div style={{ background: "#0a0a0f", borderRadius: 8, padding: "10px 14px", marginTop: 4, border: "1px solid #ef444425", textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "#55556a", marginBottom: 2 }}>TOTAL FIXED COSTS</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#ef4444" }}>€{totalFixed}/mo</div>
                {customerCount > 0 && (
                  <div style={{ fontSize: 9, color: "#55556a", marginTop: 2 }}>= €{(totalFixed / customerCount).toFixed(2)} per customer</div>
                )}
              </div>
            </div>
          </div>

          {/* Right: Cards + portfolio */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              {plans.map(p => <PlanCard key={p.name} {...p} />)}
            </div>

            <div style={{ background: "#12121a", border: "1px solid #252540", borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 10, color: "#55556a", letterSpacing: 1.5, fontWeight: 600, marginBottom: 14 }}>PORTFOLIO — WORST CASE (100% CREDIT BURN)</div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Slider label="Total customers" value={customerCount} onChange={setCustomerCount} min={1} max={1000} step={1} format={v => v.toLocaleString()} />
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Slider label={`Solo ${soloPct}%`} value={soloPct} onChange={v => { setSoloPct(v); if (v + teamPct > 100) setTeamPct(100 - v); }} min={0} max={100} format={v => `${v}%`} color="#6366f1" />
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <Slider label={`Pro ${teamPct}% · Ultra ${entPct}%`} value={teamPct} onChange={v => { setTeamPct(Math.min(v, 100 - soloPct)); }} min={0} max={100 - soloPct} format={v => `${v}%`} color="#06b6d4" />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginTop: 14, background: "#0a0a0f", borderRadius: 10, padding: 18, border: "1px solid #252540" }}>
                {[
                  { label: "MRR", value: `€${portfolio.totalRev.toLocaleString()}`, color: "#6366f1" },
                  { label: "VAR COSTS", value: `€${Math.round(portfolio.varCost).toLocaleString()}`, color: "#f59e0b" },
                  { label: "FIXED COSTS", value: `€${totalFixed.toLocaleString()}`, color: "#ef4444" },
                  { label: "NET PROFIT", value: `€${Math.round(portfolio.totalProfit).toLocaleString()}`, color: "#22c55e" },
                  { label: "NET MARGIN", value: `${portfolio.blendedMargin.toFixed(1)}%`, color: portfolio.blendedMargin >= 50 ? "#22c55e" : portfolio.blendedMargin >= 30 ? "#f59e0b" : "#ef4444" },
                ].map((item, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 8, color: "#55556a", marginBottom: 4, letterSpacing: 1.5 }}>{item.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, textAlign: "center", padding: "8px 0" }}>
                <span style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}>ARR </span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#6366f1" }}>€{Math.round(portfolio.arr).toLocaleString()}</span>
                <span style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}> · NET ARR </span>
                <span style={{ fontSize: 16, fontWeight: 800, color: "#22c55e" }}>€{Math.round(portfolio.totalProfit * 12).toLocaleString()}</span>
              </div>

              <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                {plans.map((p, i) => (
                  <div key={p.name} style={{ flex: 1, background: `${p.color}10`, border: `1px solid ${p.color}30`, borderRadius: 8, padding: "10px 14px", textAlign: "center", minWidth: 160 }}>
                    <div style={{ fontSize: 10, color: "#8888a8" }}>{p.name} × {portfolio.counts[i]} users</div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 4 }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: p.color }}>€{Math.round(portfolio.counts[i] * p.price).toLocaleString()}</div>
                        <div style={{ fontSize: 8, color: "#55556a" }}>REVENUE</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#22c55e" }}>€{Math.round(portfolio.counts[i] * p.margin).toLocaleString()}</div>
                        <div style={{ fontSize: 8, color: "#55556a" }}>PROFIT</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 14, padding: 14, borderRadius: 8, background: "#6366f108", border: "1px solid #6366f115", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}>AI SPEND</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#6366f1" }}>€{Math.round(portfolio.totalAI).toLocaleString()}/mo</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}>VPS SPEND</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#06b6d4" }}>€{Math.round(portfolio.counts[0] * soloVPS + portfolio.counts[1] * teamVPS + portfolio.counts[2] * entVPS).toLocaleString()}/mo</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}>FIXED OVERHEAD</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#ef4444" }}>€{totalFixed}/mo</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "#55556a", letterSpacing: 1.5 }}>BREAKEVEN</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#f59e0b" }}>
                    {(() => {
                      const avgMargin = customerCount > 0 ? (portfolio.varCost > 0 ? (portfolio.totalRev - portfolio.varCost) / customerCount : 0) : 0;
                      return avgMargin > 0 ? `${Math.ceil(totalFixed / avgMargin)} users` : "—";
                    })()}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 10, padding: "8px 14px", borderRadius: 6, background: "#0a0a0f", border: "1px solid #252540", fontSize: 10, color: "#55556a", textAlign: "center" }}>
                FR SMIC chargé ~€1,810/mo · OpenRouter credits billed in USD, converted at ~€0.86/$1
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
