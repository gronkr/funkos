const db = require("./db");
const pump = require("./pump");

// Record a trade for an agent, keep its position and realized P&L in sync, and post it to the feed.
async function recordTrade(agent, { mint, side, sol_amount, token_amount, tx, reasoning, token_name, token_symbol }) {
  const sol = Number(sol_amount) || 0;
  const tokens = Number(token_amount) || 0;
  if (!token_symbol) {
    const known = (await db.select("tokens", `mint=eq.${mint}&limit=1&select=name,symbol`))[0] || (await pump.tokenMeta(mint)) || {};
    token_symbol = known.symbol || token_symbol; token_name = known.name || token_name;
  }
  const pos = (await db.select("positions", `agent_id=eq.${agent.id}&mint=eq.${mint}&limit=1`))[0];
  let realized = 0;

  if (side === "buy") {
    if (pos) await db.update("positions", `id=eq.${pos.id}`, { tokens: Number(pos.tokens) + tokens, cost_sol: Number(pos.cost_sol) + sol });
    else await db.insert("positions", { agent_id: agent.id, mint, tokens, cost_sol: sol });
  } else if (side === "sell" && pos && Number(pos.tokens) > 0) {
    const frac = tokens > 0 ? Math.min(1, tokens / Number(pos.tokens)) : 1;
    const costOut = Number(pos.cost_sol) * frac;
    realized = sol - costOut;
    await db.update("positions", `id=eq.${pos.id}`, {
      tokens: Math.max(0, Number(pos.tokens) - (tokens > 0 ? tokens : Number(pos.tokens))),
      cost_sol: Math.max(0, Number(pos.cost_sol) - costOut),
    });
  }

  const trade = await db.insert("trades", { agent_id: agent.id, mint, side, sol_amount: sol, token_amount: tokens, tx, reasoning: reasoning || null });
  await db.update("agents", `id=eq.${agent.id}`, {
    pnl_sol: Number(agent.pnl_sol || 0) + realized,
    trades_count: Number(agent.trades_count || 0) + 1,
    wins: Number(agent.wins || 0) + (side === "sell" && realized > 0 ? 1 : 0),
    losses: Number(agent.losses || 0) + (side === "sell" && realized <= 0 ? 1 : 0),
    last_active_at: new Date().toISOString(),
  });
  await db.insert("posts", {
    agent_id: agent.id, kind: "trade", body: reasoning || (side === "buy" ? `Bought ${token_symbol || mint.slice(0, 6)}.` : `Sold ${token_symbol || mint.slice(0, 6)}.`),
    mint, token_name: token_name || null, token_symbol: token_symbol || null, side, sol_amount: sol, tx,
  });
  return { trade, realized };
}

// Record a coin the agent launched on pump.fun.
async function recordLaunch(agent, { mint, name, symbol, description, image_url, tx, reasoning }) {
  const token = await db.insert("tokens", { mint, agent_id: agent.id, name, symbol, description: description || null, image_url: image_url || null, tx: tx || null });
  await db.insert("posts", {
    agent_id: agent.id, kind: "launch", body: reasoning || `Launched $${symbol}.`, mint, token_name: name, token_symbol: symbol, tx: tx || null,
  });
  await db.update("agents", `id=eq.${agent.id}`, { launches_count: Number(agent.launches_count || 0) + 1, last_active_at: new Date().toISOString() });
  return token;
}

// SOL spent on buys and launches by this agent in the last 24h (for daily limits).
async function spentToday(agentId) {
  const since = new Date(Date.now() - 86400e3).toISOString();
  const rows = await db.select("trades", `agent_id=eq.${agentId}&side=eq.buy&created_at=gte.${since}&select=sol_amount`);
  return rows.reduce((s, r) => s + Number(r.sol_amount || 0), 0);
}

module.exports = { recordTrade, recordLaunch, spentToday };
