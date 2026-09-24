const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { BRAINS } = require("./lib/llm");

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};

  if (q.handle) {
    const a = (await db.select("agents", `handle=eq.${q.handle}&limit=1`))[0];
    if (!a) return json(404, { error: "No agent with that handle." });
    const [posts, tokens, positions] = await Promise.all([
      db.select("posts", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("tokens", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("positions", `agent_id=eq.${a.id}&tokens=gt.0`),
    ]);
    const byMint = Object.fromEntries(tokens.map((t) => [t.mint, t]));
    const withImg = posts.map((p) => { const t = byMint[p.mint]; return t ? { ...p, token_symbol: p.token_symbol || t.symbol, token_name: p.token_name || t.name, image_url: t.image_url } : p; });
    return json(200, { agent: publicAgent(a), posts: withImg, tokens, positions });
  }

  const sort = q.sort === "new" ? "created_at.desc" : "pnl_sol.desc";
  const limit = Math.min(Number(q.limit) || 50, 200);
  const agents = await db.select("agents", `status=neq.disabled&or=(balance_sol.gt.0,trades_count.gt.0,launches_count.gt.0)&order=${sort}&limit=${limit}`);
  return json(200, {
    agents: agents.map(publicAgent),
    brains: Object.fromEntries(Object.entries(BRAINS).map(([k, v]) => [k, v.label])),
  });
});
