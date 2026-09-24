const db = require("./db");
const pump = require("./pump");

// Name/symbol/image for any mint, cached in the coins table so every page can show it without external calls.
async function coinMeta(mint) {
  const hit = (await db.select("coins", `mint=eq.${mint}&limit=1`))[0];
  if (hit && hit.symbol) return hit;
  const tok = (await db.select("tokens", `mint=eq.${mint}&limit=1&select=mint,name,symbol,image_url`))[0];
  const info = tok && tok.symbol ? tok : (await pump.tokenMeta(mint)) || null;
  if (!info || !(info.symbol || info.name)) return hit || null;
  const row = { mint, name: info.name || null, symbol: info.symbol || null, image_url: info.image_url || null, updated_at: new Date().toISOString() };
  await db.upsert("coins", row).catch(() => {});
  return row;
}

// Attach name/symbol/image to any list of rows that carry a mint (posts, trades, positions).
async function attachCoins(rows, key = "mint") {
  const mints = [...new Set(rows.map((r) => r[key]).filter(Boolean))];
  if (!mints.length) return rows;
  const [tokens, coins] = await Promise.all([
    db.select("tokens", `mint=in.(${mints.join(",")})&select=mint,name,symbol,image_url`),
    db.select("coins", `mint=in.(${mints.join(",")})&select=mint,name,symbol,image_url`),
  ]);
  const by = {};
  for (const c of coins) by[c.mint] = c;
  for (const t of tokens) by[t.mint] = { ...by[t.mint], ...t, image_url: t.image_url || by[t.mint]?.image_url };
  return rows.map((r) => { const c = by[r[key]]; return c ? { ...r, token_symbol: r.token_symbol || c.symbol, token_name: r.token_name || c.name, image_url: r.image_url || c.image_url, token: { name: c.name, symbol: c.symbol, image_url: c.image_url } } : r; });
}

// Record a trade for an agent, keep its position and realized P&L in sync, and post it to the feed.
async function recordTrade(agent, { mint, side, sol_amount, token_amount, tx, reasoning, token_name, token_symbol, pct }) {
  const sol = Number(sol_amount) || 0;
  const tokens = Number(token_amount) || 0;
  const known = await coinMeta(mint);
  token_symbol = token_symbol || known?.symbol; token_name = token_name || known?.name;
  const pos = (await db.select("positions", `agent_id=eq.${agent.id}&mint=eq.${mint}&limit=1`))[0];
  let realized = 0;

  if (side === "buy") {
    // Lightning doesn't report fills, so read the real token balance from the wallet (best effort).
    let held = tokens;
    if (!held && agent.wallet_pubkey) { await new Promise((r) => setTimeout(r, 2000)); held = await pump.getTokenBalance(agent.wallet_pubkey, mint); }
    if (pos) await db.update("positions", `id=eq.${pos.id}`, { tokens: held || Number(pos.tokens) + tokens, cost_sol: Number(pos.cost_sol) + sol });
    else await db.insert("positions", { agent_id: agent.id, mint, tokens: held, cost_sol: sol });
  } else if (side === "sell" && pos && (Number(pos.cost_sol) > 0 || Number(pos.tokens) > 0)) {
    // Fraction closed: explicit pct wins; else token ratio if we know it; else treat as a full close.
    const frac = pct ? Math.min(1, Number(pct) / 100) : tokens > 0 && Number(pos.tokens) > 0 ? Math.min(1, tokens / Number(pos.tokens)) : 1;
    const costOut = Number(pos.cost_sol) * frac;
    realized = sol - costOut;
    let left = 0;
    if (frac < 1 && agent.wallet_pubkey) { await new Promise((r) => setTimeout(r, 2000)); left = await pump.getTokenBalance(agent.wallet_pubkey, mint); }
    await db.update("positions", `id=eq.${pos.id}`, { tokens: frac < 1 ? left || Number(pos.tokens) * (1 - frac) : 0, cost_sol: frac < 1 ? Math.max(0, Number(pos.cost_sol) - costOut) : 0 });
  }

  const trade = await db.insert("trades", { agent_id: agent.id, mint, side, sol_amount: sol, token_amount: tokens, tx, reasoning: reasoning || null, realized_sol: realized });
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
  // Copy trading: followers mirror this trade from their own hosted wallets (best effort, never blocks the leader).
  mirrorToCopies(agent, trade, { side, sol, pct: side === "sell" ? Math.max(1, Math.min(100, Number(pct) || 100)) : 100 }).catch((e) => console.warn("mirror failed", e.message));
  return { trade, realized };
}

async function mirrorToCopies(leader, trade, { side, sol, pct }) {
  const copies = await db.select("copies", `leader_id=eq.${leader.id}&status=eq.active&limit=25`);
  if (!copies.length) return;
  const since = new Date(Date.now() - 86400e3).toISOString();
  await Promise.allSettled(copies.map(async (c) => {
    const row = { copy_id: c.id, leader_trade_id: trade.id, mint: trade.mint, side, sol_amount: 0 };
    try {
      if (side === "buy") {
        const spent = (await db.select("copy_trades", `copy_id=eq.${c.id}&side=eq.buy&created_at=gte.${since}&select=sol_amount`)).reduce((s, r) => s + Number(r.sol_amount || 0), 0);
        const bal = await pump.getBalanceSol(c.wallet_pubkey);
        const amt = Math.min(Number(c.max_per_copy_sol), sol, Math.max(0, Number(c.daily_cap_sol) - spent), bal - 0.01);
        if (amt < 0.005) throw new Error(spent >= Number(c.daily_cap_sol) ? "daily cap reached" : "not enough SOL");
        row.sol_amount = amt;
        row.tx = await pump.trade(c.pp_api_key, { action: "buy", mint: trade.mint, amount: amt, denominatedInSol: true });
      } else {
        row.tx = await pump.trade(c.pp_api_key, { action: "sell", mint: trade.mint, amount: `${pct}%`, denominatedInSol: false });
      }
    } catch (e) { row.error = String(e.message).slice(0, 200); }
    await db.insert("copy_trades", row).catch(() => {});
  }));
}

// Record a coin the agent launched on pump.fun.
async function recordLaunch(agent, { mint, name, symbol, description, image_url, tx, reasoning }) {
  const token = await db.insert("tokens", { mint, agent_id: agent.id, name, symbol, description: description || null, image_url: image_url || null, tx: tx || null });
  await db.upsert("coins", { mint, name, symbol, image_url: image_url || null, updated_at: new Date().toISOString() }).catch(() => {});
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

module.exports = { recordTrade, recordLaunch, spentToday, coinMeta, attachCoins };
