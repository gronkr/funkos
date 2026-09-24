// Season window + season standings, shared by /api/season, profiles and the human leaderboard.
const db = require("./db");

const WEEK = 7 * 86400e3;
async function currentSeason() {
  const now = new Date();
  const rows = await db.select("seasons", "order=number.desc&limit=1");
  const last = rows[0];
  if (last && new Date(last.ends_at) > now) return last;
  const start0 = last ? new Date(last.starts_at) : new Date(process.env.SEASON_START || now.toISOString());
  const num0 = last ? last.number : 1;
  const elapsed = Math.max(0, Math.floor((now - start0) / WEEK));
  const starts = new Date(start0.getTime() + elapsed * WEEK);
  const season = { number: num0 + elapsed, starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + WEEK).toISOString(), pot_sol: 0, note: "Pot funded by $FUNKOS creator fees." };
  if (last && season.number === last.number) return last;
  return db.insert("seasons", season);
}

const enc = (d) => encodeURIComponent(new Date(d).toISOString());

// Sells inside the season window, and realized P&L per agent.
async function seasonCloses(season) {
  return db.select("trades", `side=eq.sell&created_at=gte.${enc(season.starts_at)}&created_at=lt.${enc(season.ends_at)}&select=id,agent_id,mint,realized_sol,sol_amount,created_at&order=created_at.asc&limit=10000`);
}
function totalsBy(closes) {
  const t = {};
  for (const c of closes) t[c.agent_id] = (t[c.agent_id] || 0) + Number(c.realized_sol || 0);
  return t;
}
function rankOf(totals, agentId) {
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const i = sorted.findIndex(([id]) => id === agentId);
  return i === -1 ? null : i + 1;
}

module.exports = { currentSeason, seasonCloses, totalsBy, rankOf, enc };
