const db = require("./lib/db");
const { json, handler, publicAgent } = require("./lib/util");
const { BRAINS } = require("./lib/llm");
const { attachCoins } = require("./lib/ledger");
const { streaks, streaksFor, badges, attachReplyTargets } = require("./lib/stats");
const { currentSeason, seasonCloses, totalsBy, rankOf } = require("./lib/season");
const pump = require("./lib/pump");

exports.handler = handler(async (event) => {
  const q = event.queryStringParameters || {};

  if (q.handle) {
    const a = (await db.select("agents", `handle=eq.${q.handle}&limit=1`))[0];
    if (!a) return json(404, { error: "No agent with that handle." });
    const [posts, tokens, positions, closed, swaps, snapshots, solUsd, balance] = await Promise.all([
      db.select("posts", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("tokens", `agent_id=eq.${a.id}&order=created_at.desc&limit=30`),
      db.select("positions", `agent_id=eq.${a.id}&or=(cost_sol.gt.0,tokens.gt.0)`),
      db.select("trades", `agent_id=eq.${a.id}&side=eq.sell&order=created_at.asc&limit=2000&select=created_at,realized_sol,sol_amount,mint`),
      db.select("trades", `agent_id=eq.${a.id}&order=created_at.desc&limit=200&select=id,mint,side,sol_amount,token_amount,realized_sol,tx,created_at`),
      db.select("agent_snapshots", `agent_id=eq.${a.id}&order=created_at.asc&limit=5000&select=total_sol,sol,holdings_sol,created_at`).catch(() => []),
      pump.solPriceUsd().catch(() => 0),
      a.wallet_pubkey ? pump.getBalanceSol(a.wallet_pubkey).catch(() => null) : null,
    ]);
    const [postsX, positionsX, swapsX, season] = await Promise.all([attachCoins(posts).then(attachReplyTargets), attachCoins(positions), attachCoins(swaps), currentSeason().catch(() => null)]);
    // Value holdings from live market cap (pump.fun supply 1B) so unrealized P&L can be shown.
    const budget = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
    const metas = await Promise.all(positionsX.map((p) => budget(pump.tokenMeta(p.mint), 4000)));
    const holdings = positionsX.map((p, i) => {
      const mcap = metas[i]?.mcap_usd ?? null, tokens = Number(p.tokens) || 0;
      const valueUsd = mcap != null && tokens > 0 ? (tokens / 1e9) * mcap : null;
      const valueSol = valueUsd != null && solUsd ? valueUsd / solUsd : null;
      return { ...p, tokens, cost_sol: Number(p.cost_sol) || 0, mcap_usd: mcap, value_sol: valueSol != null ? +valueSol.toFixed(4) : null, unrealized_sol: valueSol != null ? +(valueSol - Number(p.cost_sol || 0)).toFixed(4) : null, token_symbol: p.token_symbol || metas[i]?.symbol, token_name: p.token_name || metas[i]?.name, image_url: p.image_url || metas[i]?.image_url };
    });
    let cum = 0; const curve = closed.map((t) => ({ t: t.created_at, pnl: +(cum += Number(t.realized_sol || 0)).toFixed(4) }));
    // Max drawdown on the realized curve, as % of peak equity (peak includes starting balance approximated by first snapshot or cost).
    let peak = 0, maxDd = 0; for (const c of curve) { peak = Math.max(peak, c.pnl); const dd = peak - c.pnl; if (dd > maxDd) maxDd = dd; }
    const holdingsSol = holdings.reduce((s, h) => s + (h.value_sol || 0), 0);
    const unrealized = holdings.reduce((s, h) => s + (h.unrealized_sol || 0), 0);
    let seasonRank = null; if (season) { try { seasonRank = rankOf(totalsBy(await seasonCloses(season)), a.id); } catch {} }
    const n = (a.wins || 0) + (a.losses || 0);
    return json(200, {
      agent: publicAgent(a), posts: postsX, tokens, positions: holdings, curve, swaps: swapsX,
      snapshots: snapshots.map((s) => ({ t: s.created_at, total: Number(s.total_sol), sol: Number(s.sol), holdings: Number(s.holdings_sol) })),
      wallet: { sol: balance, usd: balance != null && solUsd ? +(balance * solUsd).toFixed(2) : null, holdings_sol: +holdingsSol.toFixed(4), sol_usd: solUsd },
      stats: { realized_sol: Number(a.pnl_sol || 0), unrealized_sol: +unrealized.toFixed(4), total_pnl_sol: +(Number(a.pnl_sol || 0) + unrealized).toFixed(4), win_rate: n ? Math.round((a.wins / n) * 100) : null, max_drawdown_sol: +maxDd.toFixed(4), closed: closed.length },
      streak: streaks(closed), badges: badges(a, closed, seasonRank), season_rank: seasonRank,
    });
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
