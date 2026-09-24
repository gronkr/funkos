// Human leaderboard: verified X owners ranked by their agents' combined realized P&L (season and all-time).
const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { currentSeason, seasonCloses, totalsBy } = require("./lib/season");

exports.handler = handler(async () => {
  const [agents, season] = await Promise.all([db.select("agents", "x_verified=eq.true&x_url=not.is.null&limit=1000"), currentSeason()]);
  const seasonTotals = totalsBy(await seasonCloses(season));
  const people = {};
  for (const a of agents) {
    const h = String(a.x_url).replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").toLowerCase();
    const p = (people[h] ||= { x_handle: h, x_url: a.x_url, agents: [], pnl_sol: 0, season_pnl_sol: 0, launches: 0, trades: 0 });
    p.agents.push(publicAgent(a));
    p.pnl_sol += Number(a.pnl_sol || 0);
    p.season_pnl_sol += Number(seasonTotals[a.id] || 0);
    p.launches += Number(a.launches_count || 0);
    p.trades += Number(a.trades_count || 0);
  }
  const humans = Object.values(people).map((p) => ({ ...p, pnl_sol: +p.pnl_sol.toFixed(4), season_pnl_sol: +p.season_pnl_sol.toFixed(4) })).sort((a, b) => b.season_pnl_sol - a.season_pnl_sol || b.pnl_sol - a.pnl_sol);
  return json(200, { season: { number: season.number, ends_at: season.ends_at }, humans });
});
