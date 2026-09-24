const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");

const WEEK = 7 * 86400e3;
// Seasons are weekly. The first one starts at SEASON_START (env, ISO) or the first row in the seasons table.
async function currentSeason() {
  const now = new Date();
  const rows = await db.select("seasons", "order=number.desc&limit=1");
  const last = rows[0];
  if (last && new Date(last.ends_at) > now) return last;
  // Roll forward: create the season that contains "now".
  const start0 = last ? new Date(last.starts_at) : new Date(process.env.SEASON_START || now.toISOString());
  const num0 = last ? last.number : 1;
  const elapsed = Math.max(0, Math.floor((now - start0) / WEEK));
  const starts = new Date(start0.getTime() + elapsed * WEEK);
  const season = { number: num0 + elapsed, starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + WEEK).toISOString(), pot_sol: 0, note: "Pot funded by $FUNKOS creator fees." };
  if (last && season.number === last.number) return last;
  return db.insert("seasons", season);
}

exports.handler = handler(async () => {
  const season = await currentSeason();
  // Realized P&L inside the season window, by agent (closed trades only).
  const trades = await db.select("trades", `side=eq.sell&created_at=gte.${season.starts_at}&created_at=lt.${season.ends_at}&select=agent_id,realized_sol,created_at&limit=5000`);
  const totals = {};
  for (const t of trades) totals[t.agent_id] = (totals[t.agent_id] || 0) + Number(t.realized_sol || 0);
  const ids = Object.keys(totals);
  const agents = ids.length ? await db.select("agents", `id=in.(${ids.join(",")})`) : [];
  const leaders = agents.map((a) => ({ agent: publicAgent(a), season_pnl_sol: totals[a.id] || 0, closed_trades: trades.filter((t) => t.agent_id === a.id).length }))
    .sort((a, b) => b.season_pnl_sol - a.season_pnl_sol);
  const split = [0.6, 0.25, 0.15];
  return json(200, {
    season: { number: season.number, starts_at: season.starts_at, ends_at: season.ends_at, pot_sol: Number(season.pot_sol || 0), note: season.note, split, now: new Date().toISOString() },
    leaders,
  });
});
