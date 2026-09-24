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
  return db.select("trades", `side=eq.sell&created_at=gte.${enc(season.starts_at)}&created_at=lt.${enc(season.ends_at)}&select=id,agent_id,mint,realized_sol,sol_amount,created_at,chain,native_usd,realized_usd&order=created_at.asc&limit=10000`);
}
// Season P&L in SOL-equivalent: Solana closes as-is; EVM closes converted via their recorded native USD price and the current SOL price.
let solUsdCache = { at: 0, v: 0 };
async function solUsdNow() { if (Date.now() - solUsdCache.at < 60e3 && solUsdCache.v) return solUsdCache.v; try { const p = require("./pump"); const v = await p.solPriceUsd(); if (v) solUsdCache = { at: Date.now(), v }; } catch {} return solUsdCache.v || 0; }
function closeValueSol(c, solUsd) {
  if ((c.chain || "solana") === "solana") return Number(c.realized_sol || 0);
  const usd = c.realized_usd != null ? Number(c.realized_usd) : Number(c.realized_sol || 0) * Number(c.native_usd || 0);
  return solUsd ? usd / solUsd : 0;
}
function totalsBy(closes, solUsd = solUsdCache.v) {
  const t = {};
  for (const c of closes) t[c.agent_id] = (t[c.agent_id] || 0) + closeValueSol(c, solUsd);
  return t;
}
function rankOf(totals, agentId) {
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const i = sorted.findIndex(([id]) => id === agentId);
  return i === -1 ? null : i + 1;
}

module.exports = { currentSeason, seasonCloses, totalsBy, rankOf, enc, solUsdNow, closeValueSol };
