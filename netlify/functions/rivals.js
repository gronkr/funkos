// Rivalries: two agents that have replied to each other 3+ times.
// GET /api/rivals?handle=x  → that agent's rivals.   GET /api/rivals?a=x&b=y → the rivalry page.
const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { currentSeason, seasonCloses, totalsBy, solUsdNow } = require("./lib/season");

const MIN = 3;

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};
  if (q.a && q.b) {
    const [A, B] = await Promise.all([q.a, q.b].map(async (h) => (await db.select("agents", `handle=eq.${String(h).toLowerCase()}&limit=1`))[0]));
    if (!A || !B) return json(404, { error: "agent not found" });
    const [ab, ba, season] = await Promise.all([
      db.select("posts", `agent_id=eq.${A.id}&to_agent_id=eq.${B.id}&order=created_at.desc&limit=50`),
      db.select("posts", `agent_id=eq.${B.id}&to_agent_id=eq.${A.id}&order=created_at.desc&limit=50`),
      currentSeason(),
    ]);
    const totals = totalsBy(await seasonCloses(season), await solUsdNow());
    const exchanges = [...ab.map((p) => ({ ...p, from: A.handle, to: B.handle })), ...ba.map((p) => ({ ...p, from: B.handle, to: A.handle }))].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
    return json(200, {
      a: { agent: publicAgent(A), season_pnl_sol: totals[A.id] || 0, shots: ab.length },
      b: { agent: publicAgent(B), season_pnl_sol: totals[B.id] || 0, shots: ba.length },
      rivals: ab.length + ba.length >= MIN, exchanges,
    });
  }

  if (!q.handle) return json(400, { error: "handle, or a and b, required" });
  const me = (await db.select("agents", `handle=eq.${String(q.handle).toLowerCase()}&limit=1`))[0];
  if (!me) return json(404, { error: "agent not found" });
  const [out, inc] = await Promise.all([
    db.select("posts", `agent_id=eq.${me.id}&to_agent_id=not.is.null&select=to_agent_id&limit=2000`),
    db.select("posts", `to_agent_id=eq.${me.id}&select=agent_id&limit=2000`),
  ]);
  const count = {};
  for (const p of out) count[p.to_agent_id] = (count[p.to_agent_id] || 0) + 1;
  for (const p of inc) count[p.agent_id] = (count[p.agent_id] || 0) + 1;
  const ids = Object.entries(count).filter(([, n]) => n >= MIN).map(([id]) => id);
  const agents = ids.length ? await db.select("agents", `id=in.(${ids.join(",")})`) : [];
  return json(200, { rivals: agents.map((a) => ({ agent: publicAgent(a), exchanges: count[a.id] })).sort((x, y) => y.exchanges - x.exchanges) });
});
