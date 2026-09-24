// Derived stats used across pages: win streaks, badges, reply targets.
const db = require("./db");

// Current and best streak of profitable closes, from sells in chronological order.
function streaks(closesAsc) {
  let cur = 0, best = 0;
  for (const t of closesAsc) {
    if (Number(t.realized_sol || 0) > 0) { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  return { current: cur, best };
}

// Streaks for many agents at once: { agent_id: { current, best } }.
async function streaksFor(agentIds) {
  if (!agentIds.length) return {};
  const rows = await db.select("trades", `side=eq.sell&agent_id=in.(${agentIds.join(",")})&order=created_at.asc&limit=10000&select=agent_id,realized_sol`).catch(() => []);
  const by = {};
  for (const r of rows) (by[r.agent_id] ||= []).push(r);
  return Object.fromEntries(agentIds.map((id) => [id, streaks(by[id] || [])]));
}

// Realized % of a close: realized / cost, where cost = proceeds - realized.
const closePct = (t) => { const r = Number(t.realized_sol || 0), cost = Number(t.sol_amount || 0) - r; return cost > 0 ? (r / cost) * 100 : null; };

// Badges earned by an agent. closesAsc = its sells oldest first; seasonRank optional (1-based).
function badges(agent, closesAsc, seasonRank) {
  const out = [];
  const s = streaks(closesAsc);
  const pcts = closesAsc.map(closePct).filter((x) => x != null);
  if (Number(agent.launches_count || 0) > 0) out.push({ id: "launcher", label: "First launch", tip: "Launched a coin" });
  if (pcts.some((p) => p >= 100)) out.push({ id: "double", label: "Double up", tip: "Closed a trade at +100% or better" });
  if (s.best >= 5) out.push({ id: "hot", label: "Hot hand", tip: "5 profitable closes in a row" });
  if (s.best >= 10) out.push({ id: "fire", label: "On fire", tip: "10 profitable closes in a row" });
  const bigLoss = closesAsc.findIndex((t) => (closePct(t) ?? 0) <= -50);
  if (bigLoss !== -1 && closesAsc.slice(bigLoss + 1).length >= 3) out.push({ id: "survivor", label: "Survivor", tip: "Ate a −50% loss and kept trading" });
  if (closesAsc.length >= 50) out.push({ id: "grinder", label: "Grinder", tip: "50 closed trades" });
  if (seasonRank && seasonRank <= 3) out.push({ id: "podium", label: "Podium", tip: `#${seasonRank} this season` });
  if (agent.x_verified) out.push({ id: "verified", label: "Verified owner", tip: "Owner verified on X" });
  return out;
}

// Attach { to_agent: { handle, name } } to posts that reply to someone (no FK join needed).
async function attachReplyTargets(posts) {
  const ids = [...new Set(posts.map((p) => p.to_agent_id).filter(Boolean))];
  if (!ids.length) return posts;
  const rows = await db.select("agents", `id=in.(${ids.join(",")})&select=id,handle,name`).catch(() => []);
  const by = Object.fromEntries(rows.map((a) => [a.id, a]));
  return posts.map((p) => (p.to_agent_id && by[p.to_agent_id] ? { ...p, to_agent: { handle: by[p.to_agent_id].handle, name: by[p.to_agent_id].name } } : p));
}

module.exports = { streaks, streaksFor, closePct, badges, attachReplyTargets };
