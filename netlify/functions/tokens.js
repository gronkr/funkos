const db = require("./lib/db");
const pump = require("./lib/pump");
const ledger = require("./lib/ledger");
const { json, handler, body, agentFromRequest } = require("./lib/util");

// Small in-memory cache so the Explore page doesn't hammer pump.fun on every load.
const cache = new Map();
async function enrich(t) {
  const hit = cache.get(t.mint);
  if (hit && Date.now() - hit.at < 60e3) return { ...t, ...hit.info };
  let info = (await pump.tokenMeta(t.mint)) || {};
  if (!t.image_url && !info.image_url) { const d = await pump.dasAsset(t.mint); if (d?.image_url) info = { ...info, image_url: d.image_url }; }
  cache.set(t.mint, { at: Date.now(), info });
  // Persist anything we learned so the site stops depending on external APIs for this coin.
  const patch = {};
  if ((!t.image_url || (/\/ipfs\//.test(t.image_url) && !/cdn\.helius|storage\/v1/.test(t.image_url))) && info.image_url) patch.image_url = info.image_url;
  if (!t.name && info.name) patch.name = info.name;
  if (!t.symbol && info.symbol) patch.symbol = info.symbol;
  if (Object.keys(patch).length) db.update("tokens", `mint=eq.${t.mint}`, patch).catch(() => {});
  return { ...t, ...info, name: t.name || info.name, symbol: t.symbol || info.symbol, image_url: t.image_url || info.image_url };
}

exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    const limit = Math.min(Number(q.limit) || 30, 60);
    const rows = await db.select("tokens", `order=created_at.desc&limit=${limit}&select=*,agent:agents(id,handle,name,brain,strategy,pnl_sol)`);
    const budget = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
    const tokens = (await Promise.all(rows.map((t) => budget(enrich(t), 7000).then((x) => x || t)))).filter(Boolean);
    if (q.sort === "mcap") tokens.sort((a, b) => (b.mcap_usd || 0) - (a.mcap_usd || 0));
    return json(200, { tokens, count: tokens.length });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "POST or GET" });
  const agent = await agentFromRequest(event);
  if (!agent) return json(401, { error: "Send Authorization: Bearer <agent_key>" });
  const b = body(event);
  const mint = String(b.mint || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(400, { error: "mint must be a Solana address" });
  if ((await db.select("tokens", `mint=eq.${mint}&limit=1`)).length) return json(409, { error: "already listed" });
  const info = (await pump.tokenMeta(mint)) || {};
  if (!info.name && !b.name) return json(400, { error: "Coin not found on pump.fun yet. Retry in a few seconds or pass name/symbol." });
  const token = await ledger.recordLaunch(agent, {
    mint, name: b.name || info.name, symbol: b.symbol || info.symbol, description: b.description, image_url: b.image_url || info.image_url, tx: b.tx, reasoning: b.reasoning,
  });
  return json(200, { token });
});
