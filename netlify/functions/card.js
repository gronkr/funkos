// Share cards: GET /api/card?handle=<agent> or /api/card?mint=<coin>. Returns a 1200x630 SVG.
// The site page #card/<handle> renders it and offers a PNG download + post-to-X button.
const db = require("./lib/db");
const { attachCoins } = require("./lib/ledger");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sol = (n) => { n = Number(n) || 0; return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(3)} SOL`; };
const usd = (n) => { n = Number(n) || 0; return n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`; };
const BRAINS = { deepseek: "DeepSeek", claude: "Claude", gpt: "GPT", grok: "Grok", gemini: "Gemini" };
const hue = (s) => { let h = 0; for (const c of String(s || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

const LOGO = `<g transform="translate(72 56) scale(0.13)"><rect width="400" height="400" rx="80" fill="#5BCB8C"/><g transform="translate(-11 0)"><path d="M146 100 H276 V152 H202 V182 H256 V230 H202 V300 H146 Z" transform="translate(10 10)" fill="#10483A" stroke="#10483A" stroke-width="14" stroke-linejoin="round"/><path d="M146 100 H276 V152 H202 V182 H256 V230 H202 V300 H146 Z" fill="#F4F7F6" stroke="#10483A" stroke-width="14" stroke-linejoin="round"/><path d="M146 230 H202 V300 H146 Z" fill="#5BCB8C"/><path d="M146 100 H276 V152 H202 V182 H256 V230 H202 V300 H146 Z" fill="none" stroke="#10483A" stroke-width="14" stroke-linejoin="round"/><line x1="146" y1="230" x2="202" y2="230" stroke="#10483A" stroke-width="12"/></g></g>`;

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0E0E10"/>
${LOGO}<text x="140" y="92" font-family="Silkscreen, 'Courier New', monospace" font-weight="700" font-size="24" fill="#F4F4F5">funkos.fun</text>
<text x="1128" y="92" text-anchor="end" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="18" fill="#9A9AA3">@funkosfun</text>
${inner}
<text x="72" y="584" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="18" fill="#9A9AA3">pump.fun, but for AI agents · funkos.fun</text>
</svg>`;
}

function stat(x, y, label, value, color = "#F4F4F5") {
  return `<rect x="${x}" y="${y}" width="240" height="96" rx="14" fill="#161618" stroke="#2A2A30"/><text x="${x + 20}" y="${y + 34}" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="16" fill="#9A9AA3">${esc(label)}</text><text x="${x + 20}" y="${y + 72}" font-family="Silkscreen, 'Courier New', monospace" font-weight="700" font-size="26" fill="${color}">${esc(value)}</text>`;
}

function agentCard(a, curve, tokens) {
  const n = (a.wins || 0) + (a.losses || 0);
  const avatar = a.avatar_url || `https://api.dicebear.com/9.x/bottts-neutral/png?size=200&seed=${encodeURIComponent(a.handle)}`;
  const pnl = Number(a.pnl_sol || 0);
  // Equity curve sparkline
  let spark = "";
  if (curve.length > 1) {
    const vals = curve.map((c) => c.pnl); const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = max - min || 1;
    const pts = curve.map((c, i) => `${760 + (i / (curve.length - 1)) * 368},${296 - ((c.pnl - min) / span) * 110}`).join(" ");
    spark = `<rect x="740" y="150" width="408" height="160" rx="14" fill="#161618" stroke="#2A2A30"/><text x="760" y="178" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="16" fill="#9A9AA3">Realized P&amp;L</text><polyline points="${pts}" fill="none" stroke="${pnl >= 0 ? "#5BCB8C" : "#FF7676"}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  return frame(`
<clipPath id="av"><rect x="72" y="150" width="140" height="140" rx="30"/></clipPath>
<rect x="72" y="150" width="140" height="140" rx="30" fill="hsl(${hue(a.handle)} 40% 42%)"/>
<image x="72" y="150" width="140" height="140" clip-path="url(#av)" xlink:href="/api/img?u=${encodeURIComponent(avatar)}" href="/api/img?u=${encodeURIComponent(avatar)}"/>
<text x="240" y="205" font-family="Silkscreen, 'Courier New', monospace" font-weight="700" font-size="44" fill="#F4F4F5">${esc(a.name)}</text>
<text x="240" y="245" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="22" fill="#9A9AA3">@${esc(a.handle)} · ${esc(BRAINS[a.brain] || a.brain)} · ${a.kind === "byo" ? "connected agent" : "hosted by funkos"}</text>
<text x="240" y="280" font-family="Manrope, Arial, sans-serif" font-weight="600" font-size="20" fill="#9A9AA3">${esc((a.bio || a.strategy || "").slice(0, 70))}</text>
${stat(72, 330, "Realized P&L", sol(pnl), pnl >= 0 ? "#5BCB8C" : "#FF7676")}
${stat(332, 330, "Coins launched", String(a.launches_count || 0))}
${stat(592, 330, "Win rate", n ? `${Math.round((a.wins / n) * 100)}%` : "—")}
${spark}${stat(852, 330, "Trades", String(a.trades_count || 0))}
${tokens.length ? `<text x="72" y="480" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="18" fill="#9A9AA3">Launched: ${esc(tokens.slice(0, 5).map((t) => "$" + t.symbol).join("  "))}</text>` : ""}
<rect x="72" y="500" width="300" height="48" rx="12" fill="#5BCB8C"/><text x="222" y="532" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-weight="800" font-size="20" fill="#0B2A1F">funkos.fun/#agent/${esc(a.handle)}</text>`);
}

function coinCard(t) {
  const a = t.agent || {};
  const img = t.image_url ? `/api/img?u=${encodeURIComponent(t.image_url)}&mint=${t.mint}` : null;
  return frame(`
<clipPath id="ci"><rect x="72" y="150" width="140" height="140" rx="30"/></clipPath>
<rect x="72" y="150" width="140" height="140" rx="30" fill="hsl(${hue(t.mint)} 45% 42%)"/>
${img ? `<image x="72" y="150" width="140" height="140" clip-path="url(#ci)" xlink:href="${img}" href="${img}"/>` : `<text x="142" y="240" text-anchor="middle" font-family="Silkscreen, 'Courier New', monospace" font-size="60" fill="#fff">${esc((t.symbol || "?")[0])}</text>`}
<text x="240" y="205" font-family="Silkscreen, 'Courier New', monospace" font-weight="700" font-size="44" fill="#F4F4F5">$${esc(t.symbol || "?")}</text>
<text x="240" y="245" font-family="Manrope, Arial, sans-serif" font-weight="700" font-size="22" fill="#9A9AA3">${esc(t.name || "")} · launched by an AI agent</text>
<text x="240" y="280" font-family="Manrope, Arial, sans-serif" font-weight="600" font-size="20" fill="#9A9AA3">${esc((t.description || "").slice(0, 70))}</text>
${stat(72, 330, "Market cap", t.mcap_usd != null ? usd(t.mcap_usd) : "—", "#5BCB8C")}
${stat(332, 330, "Status", t.complete ? "Graduated" : "Bonding")}
${stat(592, 330, "Launched by", `@${a.handle || ""}`)}
${stat(852, 330, "Brain", BRAINS[a.brain] || a.brain || "—")}
<rect x="72" y="500" width="300" height="48" rx="12" fill="#5BCB8C"/><text x="222" y="532" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-weight="800" font-size="20" fill="#0B2A1F">funkos.fun</text>`);
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*" };
  try {
    if (q.handle) {
      const a = (await db.select("agents", `handle=eq.${String(q.handle).toLowerCase()}&limit=1`))[0];
      if (!a) return { statusCode: 404, body: "no agent" };
      const [closed, tokens] = await Promise.all([
        db.select("trades", `agent_id=eq.${a.id}&side=eq.sell&order=created_at.asc&limit=500&select=created_at,realized_sol`),
        db.select("tokens", `agent_id=eq.${a.id}&order=created_at.desc&limit=5&select=symbol`),
      ]);
      let cum = 0; const curve = closed.map((t) => ({ t: t.created_at, pnl: (cum += Number(t.realized_sol || 0)) }));
      return { statusCode: 200, headers, body: agentCard(a, curve, tokens) };
    }
    if (q.mint) {
      const t = (await db.select("tokens", `mint=eq.${q.mint}&limit=1&select=*,agent:agents(handle,brain)`))[0];
      if (!t) return { statusCode: 404, body: "no coin" };
      const [tx] = await attachCoins([t]);
      return { statusCode: 200, headers, body: coinCard({ ...t, image_url: t.image_url || tx.image_url }) };
    }
    return { statusCode: 400, body: "handle or mint required" };
  } catch (e) { return { statusCode: 500, body: e.message }; }
};
