const db = require("./lib/db");
const pump = require("./lib/pump");
const { json, handler, publicAgent } = require("./lib/util");
const { currentSeason, seasonCloses, totalsBy } = require("./lib/season");
const { streaksFor, closePct } = require("./lib/stats");
const { BRAINS } = require("./lib/llm");
const { attachCoins } = require("./lib/ledger");

exports.handler = handler(async () => {
  const season = await currentSeason();
  const closes = await seasonCloses(season);
  const totals = totalsBy(closes);
  const ids = Object.keys(totals);
  const [agents, streaks] = await Promise.all([ids.length ? db.select("agents", `id=in.(${ids.join(",")})`) : [], streaksFor(ids)]);
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const leaders = agents.map((a) => ({ agent: publicAgent(a), season_pnl_sol: totals[a.id] || 0, closed_trades: closes.filter((t) => t.agent_id === a.id).length, streak: streaks[a.id]?.current || 0 }))
    .sort((a, b) => b.season_pnl_sol - a.season_pnl_sol);

  // Brain leaderboard: season P&L grouped by model.
  const brains = {};
  for (const l of leaders) {
    const k = l.agent.brain || "custom";
    const b = (brains[k] ||= { brain: k, label: BRAINS[k]?.label || k, agents: 0, pnl_sol: 0, closed: 0, wins: 0 });
    b.agents++; b.pnl_sol += l.season_pnl_sol; b.closed += l.closed_trades;
  }
  for (const c of closes) { const a = byId[c.agent_id]; if (a && Number(c.realized_sol) > 0) brains[a.brain || "custom"].wins++; }
  const brainBoard = Object.values(brains).map((b) => ({ ...b, pnl_sol: +b.pnl_sol.toFixed(4), avg_pnl_sol: +(b.pnl_sol / b.agents).toFixed(4), win_rate: b.closed ? Math.round((b.wins / b.closed) * 100) : null })).sort((a, b) => b.avg_pnl_sol - a.avg_pnl_sol);

  // Daily MVP: best single close by realized % in the last 24h.
  const since = Date.now() - 86400e3;
  const recent = closes.filter((c) => new Date(c.created_at).getTime() >= since).map((c) => ({ ...c, pct: closePct(c) })).filter((c) => c.pct != null && Number(c.realized_sol) > 0);
  let mvp = null;
  if (recent.length) {
    const best = recent.sort((a, b) => b.pct - a.pct)[0];
    const a = byId[best.agent_id] || (await db.select("agents", `id=eq.${best.agent_id}&limit=1`))[0];
    const [withCoin] = await attachCoins([best]);
    mvp = { agent: a ? publicAgent(a) : null, mint: best.mint, symbol: withCoin.token_symbol, image_url: withCoin.image_url, pct: +best.pct.toFixed(1), realized_sol: +Number(best.realized_sol).toFixed(4), at: best.created_at };
  }

  const split = [0.6, 0.25, 0.15];
  let pot = Number(season.pot_sol || 0), potWallet = process.env.POT_WALLET || null;
  if (potWallet) { try { pot = await pump.getBalanceSol(potWallet); } catch {} }
  return json(200, {
    season: { number: season.number, starts_at: season.starts_at, ends_at: season.ends_at, pot_sol: pot, pot_wallet: potWallet, note: season.note, split, now: new Date().toISOString() },
    leaders, brains: brainBoard, mvp,
  });
});
