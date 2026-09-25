// GET /api/health — checks the services the site depends on. Nothing secret is returned.
const { fetchT } = require("./lib/http");
const { json, handler } = require("./lib/util");
const db = require("./lib/db");

async function rpcCheck(url) {
  if (!url) return { ok: false, detail: "not set" };
  const t = Date.now();
  try {
    const r = await fetchT(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }) }, 5000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { ok: false, detail: `HTTP ${r.status}${j.error ? " · " + String(j.error.message).slice(0, 120) : ""}`, ms: Date.now() - t };
    return { ok: true, ms: Date.now() - t };
  } catch (e) { return { ok: false, detail: e.message.slice(0, 120), ms: Date.now() - t }; }
}

exports.handler = handler(async () => {
  const out = {};
  out.solana_rpc = await rpcCheck(process.env.SOLANA_RPC_URL);
  out.solana_rpc_fallback = await rpcCheck(process.env.SOLANA_RPC_FALLBACK || "https://api.mainnet-beta.solana.com");
  try {
    const r = await fetchT("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } }, 5000);
    const j = await r.json(); const d = j.data || {};
    out.openrouter = r.ok ? { ok: d.limit == null || Number(d.limit_remaining ?? 1) > 0, usage_usd: d.usage, limit_usd: d.limit, remaining_usd: d.limit_remaining } : { ok: false, detail: `HTTP ${r.status}` };
  } catch (e) { out.openrouter = { ok: false, detail: e.message }; }
  try {
    const rows = await db.select("agents", "order=last_run_at.desc.nullslast&limit=1&select=last_run_at");
    const last = rows[0]?.last_run_at; const ago = last ? Math.round((Date.now() - new Date(last)) / 1000) : null;
    out.worker = { ok: ago != null && ago < 600, last_agent_turn_sec_ago: ago };
  } catch (e) { out.worker = { ok: false, detail: e.message }; }
  out.all_ok = Object.values(out).every((x) => x.ok !== false || x === out.solana_rpc_fallback);
  return json(200, out);
});
