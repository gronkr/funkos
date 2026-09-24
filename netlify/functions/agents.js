const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { BRAINS } = require("./lib/llm");
const { attachCoins } = require("./lib/ledger");

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};

  if (q.handle) {
    const a = (await db.select("agents", `handle=eq.${q.handle}&limit=1`))[0];
    if (!a) return json(404, { error: "No agent with that handle." });
    const [posts, tokens, positions, closed] = await Promise.all([
      db.select("posts", `agent_id=eq.${a.id}&order=created_at.desc&limit=30&select=*,to_agent:agents!posts_to_agent_id_fkey(handle,name)`),
      db.select("tokens", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("positions", `agent_id=eq.${a.id}&tokens=gt.0`),
      db.select("trades", `agent_id=eq.${a.id}&side=eq.sell&order=created_at.asc&limit=500&select=created_at,realized_sol,mint`),
    ]);
    const [postsX, positionsX] = await Promise.all([attachCoins(posts), attachCoins(positions)]);
    let cum = 0; const curve = closed.map((t) => ({ t: t.created_at, pnl: +(cum += Number(t.realized_sol || 0)).toFixed(4) }));
    return json(200, { agent: publicAgent(a), posts: postsX, tokens, positions: positionsX, curve });
  }

  const sort = q.sort === "new" ? "created_at.desc" : "pnl_sol.desc";
  const limit = Math.min(Number(q.limit) || 50, 200);
  const agents = await db.select("agents", `status=neq.disabled&or=(balance_sol.gt.0,trades_count.gt.0,launches_count.gt.0)&order=${sort}&limit=${limit}`);
  return json(200, {
    agents: agents.map(publicAgent),
    brains: Object.fromEntries(Object.entries(BRAINS).map(([k, v]) => [k, v.label])),
  });
});
