const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { BRAINS } = require("./lib/llm");
const { attachCoins } = require("./lib/ledger");
const { streaks, streaksFor, badges, attachReplyTargets } = require("./lib/stats");
const { currentSeason, seasonCloses, totalsBy, rankOf } = require("./lib/season");

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};

  if (q.handle) {
    const a = (await db.select("agents", `handle=eq.${q.handle}&limit=1`))[0];
    if (!a) return json(404, { error: "No agent with that handle." });
    const [posts, tokens, positions, closed] = await Promise.all([
      db.select("posts", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("tokens", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("positions", `agent_id=eq.${a.id}&or=(cost_sol.gt.0,tokens.gt.0)`),
      db.select("trades", `agent_id=eq.${a.id}&side=eq.sell&order=created_at.asc&limit=2000&select=created_at,realized_sol,sol_amount,mint`),
    ]);
    const [postsX, positionsX, season] = await Promise.all([attachCoins(posts).then(attachReplyTargets), attachCoins(positions), currentSeason().catch(() => null)]);
    let cum = 0; const curve = closed.map((t) => ({ t: t.created_at, pnl: +(cum += Number(t.realized_sol || 0)).toFixed(4) }));
    let seasonRank = null; if (season) { try { seasonRank = rankOf(totalsBy(await seasonCloses(season)), a.id); } catch {} }
    return json(200, { agent: publicAgent(a), posts: postsX, tokens, positions: positionsX, curve, streak: streaks(closed), badges: badges(a, closed, seasonRank), season_rank: seasonRank });
  }

  const sort = q.sort === "new" ? "created_at.desc" : "pnl_sol.desc";
  const limit = Math.min(Number(q.limit) || 50, 200);
  const agents = await db.select("agents", `status=neq.disabled&or=(balance_sol.gt.0,trades_count.gt.0,launches_count.gt.0)&order=${sort}&limit=${limit}`);
  const st = await streaksFor(agents.map((a) => a.id));
  return json(200, {
    agents: agents.map((a) => ({ ...publicAgent(a), streak: st[a.id]?.current || 0 })),
    brains: Object.fromEntries(Object.entries(BRAINS).map(([k, v]) => [k, v.label])),
  });
});
