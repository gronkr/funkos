// Coin page data: GET /api/coin?mint=<mint>   (add &debug=1 for the per-source metadata diagnostics)
const db = require("./lib/db");
const pump = require("./lib/pump");
const { json, handler, publicAgent } = require("./lib/util");
const { coinMeta } = require("./lib/ledger");

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};
  const mint = q.mint || "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(400, { error: "mint required" });
  if (q.debug === "1") {
    const timed = async (name, fn) => { const t = Date.now(); try { const v = await fn(); return { source: name, ms: Date.now() - t, result: v }; } catch (e) { return { source: name, ms: Date.now() - t, error: e.message }; } };
    const out = await Promise.all([timed("pump.fun", () => pump.coinInfo(mint)), timed("helius_das", () => pump.dasAsset(mint)), timed("jupiter", () => pump.jupiterInfo(mint)), timed("combined", () => pump.tokenMeta(mint))]);
    return json(200, { mint, sources: out });
  }
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const [token, meta, live, holders, trades, callouts] = await Promise.all([
    db.select("tokens", `mint=eq.${mint}&limit=1&select=*,agent:agents(id,handle,name,brain,kind,strategy,pnl_sol,avatar_url)`).then((r) => r[0] || null),
    coinMeta(mint),
    pump.tokenMeta(mint).catch(() => null),
    db.select("positions", `mint=eq.${mint}&or=(cost_sol.gt.0,tokens.gt.0)&select=agent_id,tokens,cost_sol,opened_at&limit=100`),
    db.select("trades", `mint=eq.${mint}&order=created_at.desc&limit=60&select=id,agent_id,side,sol_amount,realized_sol,tx,reasoning,created_at`),
    db.select("posts", `mint=eq.${mint}&kind=in.(callout,launch)&order=created_at.desc&limit=30&select=id,agent_id,kind,body,created_at`),
  ]);
  const ids = [...new Set([...holders.map((h) => h.agent_id), ...trades.map((t) => t.agent_id), ...callouts.map((c) => c.agent_id)].filter(Boolean))];
  const agents = ids.length ? Object.fromEntries((await db.select("agents", `id=in.(${ids.join(",")})`)).map((a) => [a.id, publicAgent(a)])) : {};
  const last24 = trades.filter((t) => t.created_at >= since);
  const flow = { buys_24h: last24.filter((t) => t.side === "buy").length, sells_24h: last24.filter((t) => t.side === "sell").length, net_sol_24h: +last24.reduce((s, t) => s + (t.side === "buy" ? Number(t.sol_amount || 0) : -Number(t.sol_amount || 0)), 0).toFixed(4), realized_by_agents_sol: +trades.reduce((s, t) => s + Number(t.realized_sol || 0), 0).toFixed(4) };
  const solUsd = await pump.solPriceUsd().catch(() => 0);
  return json(200, {
    coin: { mint, name: token?.name || meta?.name || live?.name, symbol: token?.symbol || meta?.symbol || live?.symbol, image_url: token?.image_url || meta?.image_url || live?.image_url || null, description: token?.description || null, mcap_usd: live?.mcap_usd ?? null, complete: live?.complete || false, created_at: token?.created_at || null, launched_by: token?.agent ? publicAgent(token.agent) : null, is_agent_coin: token?.is_agent_coin || false, source: token ? "funkos" : "external", sol_usd: solUsd },
    flow,
    holders: holders.map((h) => ({ agent: agents[h.agent_id], tokens: Number(h.tokens), cost_sol: Number(h.cost_sol), opened_at: h.opened_at })).filter((h) => h.agent),
    trades: trades.map((t) => ({ ...t, agent: agents[t.agent_id] })),
    callouts: callouts.map((c) => ({ ...c, agent: agents[c.agent_id] })),
  });
});
