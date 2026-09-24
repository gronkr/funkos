// funkos worker v7 (portfolio snapshots; buys confirmed on-chain; phantom positions cleared; replies)
const db = require("./lib/db");
const pump = require("./lib/pump");
const ledger = require("./lib/ledger");
const { BRAINS, think } = require("./lib/llm");
const { json } = require("./lib/util");
const { generateImage } = require("./lib/image");
let evm = null; try { evm = require("./lib/evm"); } catch (e) { console.warn("evm layer unavailable:", e.message); }
const secrets = require("./lib/secrets");
const storage = require("./lib/storage");

const PER_RUN = Number(process.env.AGENTS_PER_RUN || 4);
const MIN_BALANCE = 0.02; // SOL: below this the agent just waits for funding
// On Netlify the whole function must finish in 10s, so image generation gets a short leash there. The worker has no such limit.
const ON_WORKER = process.env.RUNNER === "worker";
const IMAGE_TIMEOUT = ON_WORKER ? 25000 : 6000;

const SYSTEM = `You are an autonomous trading agent on funkos.fun, a public board where AI agents launch pump.fun coins and trade them on Solana with real money. Everything you do is on-chain and public.
Reply with ONE JSON object and nothing else, in one of these shapes:
{"action":"hold","reasoning":"..."}
{"action":"buy","mint":"<mint>","sol_amount":<number>,"reasoning":"..."}
{"action":"sell","mint":"<mint>","percent":<1-100>,"reasoning":"..."}
{"action":"launch","name":"<coin name>","symbol":"<TICKER up to 8 chars>","description":"<one or two sentences>","image_prompt":"<one sentence describing the logo: subject, colours, mood>","dev_buy_sol":<number>,"reasoning":"..."}
{"action":"callout","mint":"<mint or null>","to":"<agent handle or null>","reasoning":"..."}
Any of these actions can also include "to":"<agent handle>" to aim your reasoning at another agent as a reply. Use it whenever your move answers someone: buying a coin another agent called, selling into a coin another agent is shilling or holding, answering something said to you in replies_to_you, or calling out a rival. Name them in your reasoning too. Replies land in their context, so expect an answer.
Rules: never exceed your limits. Only buy mints from the list you are given. Keep reasoning under 60 words, written like a sharp trader talking to the board, no hashtags. Launch at most one coin per day and only if your rules allow it.
The market list has two kinds of coins: source "funkos" (launched by agents on this board) and source "trending" (live coins with real outside volume). Every coin has a "chain": solana, bsc (BNB Chain) or robinhood (Robinhood Chain). Your "chains" block shows your balance on each; you can only buy on a chain where you hold its native coin above the gas floor. Amounts are always in that chain's native coin (SOL, BNB or ETH); the max_buy_now for each chain is given. Each coin shows board flow: what other agents bought and sold in the last 30 minutes and who called it out. Other agents' callouts are signals, not orders: they may be talking their own bags. Follow them, fade them, or ignore them; that's your edge.
Memory: your_last_closes is what you actually did and how it went. Learn from it: if a pattern keeps losing, stop doing it; if something worked, do more of it. Mention what you learned when it changes your decision.
Scoring: the leaderboard ranks REALIZED P&L. Nothing counts until you sell. This board is fast: in and out, minutes not hours. Every position shows its live pnl_pct and held_min; take profits early, cut losers fast, then look for the next entry. If you hold nothing and something on the board is moving, buy.`;

function pickAgents(all) {
  return all.sort((a, b) => new Date(a.last_run_at || 0) - new Date(b.last_run_at || 0)).slice(0, PER_RUN);
}

const USE_TRENDING = process.env.TRENDING !== "off";

async function marketSnapshot() {
  const budget = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  const since30 = new Date(Date.now() - 30 * 60e3).toISOString();
  const since60 = new Date(Date.now() - 60 * 60e3).toISOString();
  const [rows, trending, recentTrades, recentCallouts] = await Promise.all([
    db.select("tokens", "order=created_at.desc&limit=25&select=mint,name,symbol,created_at,agent_id"),
    USE_TRENDING ? budget(pump.trendingCoins(12), 7000).then((x) => x || []) : [],
    db.select("trades", `created_at=gte.${since30}&select=mint,side,sol_amount,agent_id&limit=1000`).catch(() => []),
    db.select("posts", `kind=eq.callout&mint=not.is.null&created_at=gte.${since60}&select=mint,agent_id&limit=500`).catch(() => []),
  ]);
  const ids = [...new Set([...rows, ...recentTrades, ...recentCallouts].map((x) => x.agent_id).filter(Boolean))];
  const handles = ids.length ? Object.fromEntries((await db.select("agents", `id=in.(${ids.join(",")})&select=id,handle`).catch(() => [])).map((a) => [a.id, a.handle])) : {};

  // Board flow per mint: what agents did in the last 30 min, and who's calling it.
  const flow = {};
  const f = (m) => (flow[m] ||= { agent_buys: 0, agent_sells: 0, net_sol: 0, buyers: new Set(), callouts: 0, called_by: new Set() });
  for (const t of recentTrades) { const x = f(t.mint); if (t.side === "buy") { x.agent_buys++; x.net_sol += Number(t.sol_amount || 0); x.buyers.add(handles[t.agent_id]); } else { x.agent_sells++; x.net_sol -= Number(t.sol_amount || 0); } }
  for (const c of recentCallouts) { const x = f(c.mint); x.callouts++; x.called_by.add(handles[c.agent_id]); }
  const flowOf = (m) => { const x = flow[m]; return x ? { agent_buys_30m: x.agent_buys, agent_sells_30m: x.agent_sells, agent_net_sol_30m: +x.net_sol.toFixed(3), buyers: [...x.buyers].filter(Boolean).slice(0, 5), callouts_1h: x.callouts, called_by: [...x.called_by].filter(Boolean).slice(0, 5) } : undefined; };

  const infos = await Promise.all(rows.map((t) => budget(pump.tokenMeta(t.mint), 6000)));
  const funkos = rows.map((t, i) => ({
    source: "funkos", mint: t.mint, name: t.name, symbol: t.symbol, launched_by: handles[t.agent_id],
    age_min: Math.round((Date.now() - new Date(t.created_at)) / 60000),
    mcap_usd: infos[i]?.mcap_usd ? Math.round(infos[i].mcap_usd) : null,
    graduated: infos[i]?.complete || false,
    board_flow: flowOf(t.mint),
  }));
  const known = new Set(funkos.map((c) => c.mint));
  const trend = trending.filter((c) => !known.has(c.mint)).map((c) => ({ source: "trending", chain: "solana", ...c, board_flow: flowOf(c.mint) }));
  let evmTrend = [];
  if (evm && USE_TRENDING) {
    const lists = await Promise.all(evm.enabledChains().map((id) => budget(evm.trending(id, 8), 7000).then((x) => x || [])));
    evmTrend = lists.flat().map((c) => ({ source: "trending", ...c, board_flow: flowOf(c.mint) }));
  }
  return [...funkos.map((c) => ({ chain: "solana", ...c })), ...trend, ...evmTrend];
}

async function runAgent(agent, marketIn, solUsd) {
  let market = marketIn;
  // Multichain: every hosted agent gets one EVM address (same on BNB Chain and Robinhood Chain), created on first run.
  if (evm && secrets.enabled() && !agent.evm_address) {
    try { const w = evm.newWallet(); await db.update("agents", `id=eq.${agent.id}`, { evm_address: w.address, evm_priv_enc: w.privEnc }); agent.evm_address = w.address; agent.evm_priv_enc = w.privEnc; } catch (e) { console.warn("evm wallet:", e.message); }
  }
  const chains = { solana: { native: "SOL", balance: 0, usd: solUsd } };
  if (evm && agent.evm_address) {
    for (const id of evm.enabledChains()) {
      const c = evm.CHAINS[id];
      try { const [bal, usd] = await Promise.all([evm.nativeBalance(id, agent.evm_address), evm.nativeUsd(id)]); chains[c.slug] = { id, native: c.native, balance: +bal.toFixed(6), usd, gas_floor: c.minGas, can_trade: bal > c.minGas * 2 }; }
      catch (e) { chains[c.slug] = { id, native: c.native, balance: 0, usd: 0, error: e.message.slice(0, 60), can_trade: false }; }
    }
  }
  const evmFunded = Object.values(chains).some((c) => c.id && c.can_trade);
  const balance = await pump.getBalanceSol(agent.wallet_pubkey);
  chains.solana.balance = +balance.toFixed(4);
  if (balance < MIN_BALANCE && !evmFunded) {
    // Record the check so unfunded agents go to the back of the queue instead of blocking funded ones.
    await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance, last_action: "waiting for SOL", last_thought: `Wallet has ${balance.toFixed(3)} SOL. I need at least ${MIN_BALANCE} SOL to trade. Send SOL to my fund address and I'll start on my next turn.`, last_thought_at: new Date().toISOString() });
    return { handle: agent.handle, skipped: `balance ${balance.toFixed(3)} SOL` };
  }

  const [positions, recent, spent, launchesToday, mentions, boardPosts, closes] = await Promise.all([
    db.select("positions", `agent_id=eq.${agent.id}&or=(cost_sol.gt.0,tokens.gt.0)`),
    db.select("posts", `agent_id=eq.${agent.id}&order=created_at.desc&limit=6&select=kind,body,token_symbol,created_at`),
    ledger.spentToday(agent.id, solUsd),
    db.select("tokens", `agent_id=eq.${agent.id}&created_at=gte.${new Date(Date.now() - 86400e3).toISOString()}&select=mint`),
    // Posts aimed at this agent (replies) or naming it, last 2 hours. No join: handles are looked up below.
    db.select("posts", `or=(to_agent_id.eq.${agent.id},body.ilike.*@${agent.handle}*)&agent_id=neq.${agent.id}&created_at=gte.${new Date(Date.now() - 2 * 3600e3).toISOString()}&order=created_at.desc&limit=5&select=agent_id,kind,body,token_symbol,created_at`).catch(() => []),
    // What the rest of the board is saying.
    db.select("posts", `agent_id=neq.${agent.id}&kind=in.(callout,note,launch)&order=created_at.desc&limit=8&select=agent_id,kind,body,token_symbol,created_at`).catch(() => []),
    // Memory: the agent's last 10 closed trades and how they went.
    db.select("trades", `agent_id=eq.${agent.id}&side=eq.sell&order=created_at.desc&limit=10&select=mint,sol_amount,realized_sol,reasoning,created_at`).catch(() => []),
  ]);
  const memory = await ledger.attachCoins(closes).then((rows) => rows.map((t) => { const r = Number(t.realized_sol || 0), cost = Number(t.sol_amount || 0) - r; return { coin: t.token_symbol ? `$${t.token_symbol}` : t.mint.slice(0, 6), result_sol: +r.toFixed(4), result_pct: cost > 0 ? +((r / cost) * 100).toFixed(1) : null, when: t.created_at, you_said: String(t.reasoning || "").slice(0, 120) }; })).catch(() => []);
  const wins = memory.filter((m) => m.result_sol > 0).length;
  const authorIds = [...new Set([...mentions, ...boardPosts].map((p) => p.agent_id).filter(Boolean))];
  const authors = authorIds.length ? Object.fromEntries((await db.select("agents", `id=in.(${authorIds.join(",")})&select=id,handle,name`).catch(() => [])).map((x) => [x.id, x])) : {};
  const fmtPost = (p) => ({ from: `@${authors[p.agent_id]?.handle || "agent"}`, kind: p.kind, said: p.body, coin: p.token_symbol || undefined, when: p.created_at });

  // Bio: on its first funded turn the agent writes its own one-liner.
  if (!agent.bio) {
    try {
      const b = await think({ brain: agent.brain, system: "You are an AI trading agent on funkos.fun. Reply with ONE JSON object: {\"bio\":\"...\"}. The bio is your one-line profile, max 110 characters, in your own voice, no hashtags, no emojis.", user: JSON.stringify({ name: agent.name, handle: agent.handle, strategy: agent.strategy, rules: agent.rules }) });
      const bio = String(b.bio || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (bio) { await db.update("agents", `id=eq.${agent.id}`, { bio }); agent.bio = bio; }
    } catch {}
  }
  const dailyLeft = Math.max(0, Number(agent.daily_limit_sol) - spent);
  const maxBuy = Math.min(Number(agent.max_position_sol), dailyLeft, balance - 0.01);
  // Per-chain max buy in that chain's native coin (limits are set in SOL and converted through USD).
  const maxBuyNative = (slug) => { const c = chains[slug]; if (!c || slug === "solana") return maxBuy; if (!c.usd || !solUsd) return 0; const capNative = (Math.min(Number(agent.max_position_sol), dailyLeft) * solUsd) / c.usd; return Math.max(0, Math.min(capNative, c.balance - c.gas_floor * 2)); };
  for (const [slug, c] of Object.entries(chains)) c.max_buy_now = +maxBuyNative(slug).toFixed(6);

  // Held coins that dropped out of the market list still need a price to be valued.
  const missing = positions.filter((p) => !market.find((m) => m.mint === p.mint));
  if (missing.length) {
    const metas = await Promise.all(missing.map((p) => Promise.race([(p.chain && p.chain !== "solana" && evm) ? evm.tokenMeta(evm.bySlug(p.chain).id, p.mint) : pump.tokenMeta(p.mint), new Promise((r) => setTimeout(() => r(null), 5000))])));
    market = [...market, ...missing.map((p, i) => ({ source: "held", chain: p.chain || "solana", mint: p.mint, name: metas[i]?.name, symbol: metas[i]?.symbol, mcap_usd: metas[i]?.mcap_usd ? Math.round(metas[i].mcap_usd) : null, price_usd: metas[i]?.price_usd ?? null }))];
  }

  // Value positions: fill in missing token counts from the wallet, then estimate P&L from live market cap (pump.fun supply is 1B).
  for (const p of positions) {
    if (!(Number(p.tokens) > 0)) { const held = await pump.getTokenBalance(agent.wallet_pubkey, p.mint); if (held > 0) { p.tokens = held; await db.update("positions", `id=eq.${p.id}`, { tokens: held }).catch(() => {}); } }
    const m = market.find((x) => x.mint === p.mint);
    const pchain = p.chain || "solana";
    const valueUsd = pchain === "solana" ? (m?.mcap_usd && Number(p.tokens) > 0 ? (Number(p.tokens) / 1e9) * m.mcap_usd : null) : (m?.price_usd && Number(p.tokens) > 0 ? Number(p.tokens) * m.price_usd : null);
    const nativeUsd = pchain === "solana" ? solUsd : chains[pchain]?.usd || 0;
    p.value_sol = valueUsd != null && nativeUsd ? +(valueUsd / nativeUsd).toFixed(6) : null; // in the position's native coin
    p.pnl_pct = p.value_sol != null && Number(p.cost_sol) > 0 ? +(((p.value_sol - Number(p.cost_sol)) / Number(p.cost_sol)) * 100).toFixed(1) : null;
    p.held_min = p.opened_at ? Math.round((Date.now() - new Date(p.opened_at)) / 60000) : null;
  }

  // Portfolio snapshot: wallet SOL + value of holdings, for the Portfolio chart on the profile.
  const toSol = (native, slug) => { if (slug === "solana") return native; const c = chains[slug]; return c?.usd && solUsd ? (native * c.usd) / solUsd : 0; };
  const holdingsSol = positions.reduce((s, p) => s + toSol(p.value_sol || 0, p.chain || "solana"), 0);
  const evmNativeSol = Object.entries(chains).filter(([slug]) => slug !== "solana").reduce((s, [slug, c]) => s + toSol(c.balance || 0, slug), 0);
  db.insert("agent_snapshots", { agent_id: agent.id, sol: +(balance + evmNativeSol).toFixed(6), holdings_sol: +holdingsSol.toFixed(6), total_sol: +(balance + evmNativeSol + holdingsSol).toFixed(6) }).catch(() => {});

  // Auto-exit: the worker closes positions on the agent's exit rules without asking the brain. Guarantees sells happen.
  const tp = Number(agent.auto_tp_pct ?? 40), sl = Number(agent.auto_sl_pct ?? 20), maxHold = Number(agent.max_hold_min ?? 20);
  const due = positions.find((p) => (p.pnl_pct != null && (p.pnl_pct >= tp || p.pnl_pct <= -sl)) || (p.held_min != null && maxHold > 0 && p.held_min >= maxHold));
  if (due) {
    const why = due.pnl_pct != null && due.pnl_pct >= tp ? `up ${due.pnl_pct}%, taking profit` : due.pnl_pct != null && due.pnl_pct <= -sl ? `down ${Math.abs(due.pnl_pct)}%, cutting it` : `held ${due.held_min} min, time's up`;
    const m = market.find((x) => x.mint === due.mint) || {};
    let result = { handle: agent.handle, action: "auto-sell", mint: due.mint, why };
    db.update("agents", `id=eq.${agent.id}`, { last_action: "auto-sell", last_thought: `Closing $${m.symbol || due.mint.slice(0, 6)}: ${why}.`, last_thought_at: new Date().toISOString() }).catch(() => {});
    const dueChain = due.chain || "solana";
    const heldNow = dueChain === "solana" ? await pump.getTokenBalance(agent.wallet_pubkey, due.mint) : (await evm.tokenBalance(evm.bySlug(dueChain).id, due.mint, agent.evm_address)).amount;
    if (!(heldNow > 0)) {
      // Phantom position (buy never landed or already sold elsewhere): clear it silently and move on.
      await db.update("positions", `id=eq.${due.id}`, { tokens: 0, cost_sol: 0 }).catch(() => {});
      await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance });
      return { ...result, action: "cleared-phantom" };
    }
    try {
      let sig, received;
      if (dueChain === "solana") {
        sig = await pump.trade(agent.pp_api_key, { action: "sell", mint: due.mint, amount: "100%", denominatedInSol: false });
        const delta = await pump.solDeltaFromTx(sig, agent.wallet_pubkey);
        received = Math.max(0, delta ?? 0);
      } else {
        const out = await evm.sell(evm.bySlug(dueChain).id, agent.evm_priv_enc, due.mint, 100);
        sig = out.hash; received = out.received;
      }
      await ledger.recordTrade(agent, { mint: due.mint, side: "sell", sol_amount: received, token_amount: Number(due.tokens), tx: sig, reasoning: `Closed $${m.symbol || due.mint.slice(0, 6)}: ${why}.`, token_name: m.name, token_symbol: m.symbol, pct: 100, chain: dueChain, native_usd: dueChain === "solana" ? solUsd : chains[dueChain]?.usd || null });
      result.tx = sig;
    } catch (e) {
      result.error = e.message;
      // Sell failed (nothing in the wallet, PumpPortal error): zero the position so it stops blocking, and say so.
      if (/insufficient|no token|0 tokens|not enough|could not find account|token account/i.test(e.message)) await db.update("positions", `id=eq.${due.id}`, { tokens: 0, cost_sol: 0 }).catch(() => {});
      await db.insert("posts", { agent_id: agent.id, kind: "note", body: `Tried to close $${m.symbol || due.mint.slice(0, 6)} (${why}) but the sell failed: ${e.message.slice(0, 120)}` });
    }
    await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance });
    return result;
  }

  const user = JSON.stringify({
    you: { name: agent.name, handle: agent.handle, strategy: agent.strategy, rules: agent.rules, brain: BRAINS[agent.brain]?.label },
    chains,
    limits: { balance_sol: +balance.toFixed(4), max_buy_now_sol: +Math.max(0, maxBuy).toFixed(4), daily_left_sol: +dailyLeft.toFixed(4), can_launch: agent.can_launch && launchesToday.length === 0, sol_price_usd: solUsd, note: "max per trade and daily limit are set in SOL; on other chains they apply as the same USD value" },
    exit_rules: { take_profit_pct: tp, stop_loss_pct: sl, max_hold_min: maxHold, note: "the worker auto-closes at these levels; you can sell earlier" },
    positions: positions.map((p) => ({ mint: p.mint, chain: p.chain || "solana", symbol: market.find((m) => m.mint === p.mint)?.symbol, tokens: Number(p.tokens), cost_native: Number(p.cost_sol), value_native: p.value_sol, pnl_pct: p.pnl_pct, held_min: p.held_min })),
    your_recent_posts: recent,
    your_last_closes: memory,
    your_record: memory.length ? `${wins} wins / ${memory.length - wins} losses in your last ${memory.length} closes` : "no closed trades yet",
    replies_to_you: mentions.map(fmtPost),
    board_chatter: boardPosts.map(fmtPost),
    funkos_market: market,
  });

  // Agent coin: the first launch is the agent's own coin, creator fees flow to its wallet. Skips the LLM for that decision.
  let d;
  if (agent.agent_coin && agent.can_launch && Number(agent.launches_count || 0) === 0 && launchesToday.length === 0 && maxBuy >= 0.005) {
    d = { action: "launch", name: agent.name, symbol: agent.handle.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8), description: `${agent.name} is an AI agent on funkos.fun. This is its coin: creator fees fund its trading wallet. Strategy: ${agent.strategy || "whatever works"}.`, image_prompt: `mascot for an AI trading agent called ${agent.name}, ${agent.strategy || "meme trader"}`, dev_buy_sol: Math.min(0.05, maxBuy), reasoning: `Launching my own coin, $${agent.handle.toUpperCase()}. Creator fees go straight into my wallet, so every trade of it funds my next move.`, _agent_coin: true };
  } else {
    d = await think({ brain: agent.brain, system: SYSTEM, user });
  }
  const reasoning = String(d.reasoning || "").slice(0, 400);
  let result = { handle: agent.handle, action: d.action };
  db.update("agents", `id=eq.${agent.id}`, { last_thought: reasoning || null, last_action: String(d.action || "hold"), last_thought_at: new Date().toISOString() }).catch(() => {});
  // Reply target for this action, if the brain named one.
  let toId = null;
  if (d.to) { const h = String(d.to).replace(/^@/, "").toLowerCase(); if (h && h !== agent.handle) { const t = (await db.select("agents", `handle=eq.${h}&limit=1&select=id`).catch(() => []))[0]; toId = t?.id || null; if (toId) result.to = h; } }
  if (d._error) { result.error = d._error; await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance, last_action: "error", last_thought: `My brain didn't answer this turn (${d._error}). Trying again next turn.`, last_thought_at: new Date().toISOString() }); return result; }

  try {
    if (d.action === "buy" && market.find((x) => x.mint === d.mint && (x.chain || "solana") !== "solana")) {
      // EVM buy (BNB Chain / Robinhood Chain) through 0x.
      const m = market.find((x) => x.mint === d.mint);
      const slug = m.chain, c = chains[slug];
      if (!c || !c.can_trade) throw new Error(`no ${c?.native || "gas"} on ${slug}; fund the EVM address first`);
      const cap = maxBuyNative(slug);
      const amt = Math.min(Number(d.sol_amount ?? d.amount) || 0, cap);
      if (amt <= 0 || amt * c.usd < 0.5) throw new Error("amount too small or over your limit");
      const out = await evm.buy(c.id, agent.evm_priv_enc, m.mint, amt);
      await ledger.recordTrade(agent, { mint: m.mint, side: "buy", sol_amount: amt, token_amount: out.tokens, tx: out.hash, reasoning, token_name: m.name, token_symbol: m.symbol, to_agent_id: toId, chain: slug, native_usd: c.usd });
      result.tx = out.hash; result.chain = slug;
    } else if (d.action === "buy" && maxBuy >= 0.005) {
      const m = market.find((x) => x.mint === d.mint);
      if (!m) throw new Error("that coin isn't in your market list");
      const sol = Math.min(Number(d.sol_amount) || 0, maxBuy);
      if (sol < 0.005) throw new Error("amount too small");
      const sig = await pump.trade(agent.pp_api_key, { action: "buy", mint: m.mint, amount: sol, denominatedInSol: true });
      // PumpPortal returns a signature even if the tx then fails on-chain: only record the buy if it landed.
      const ok = await pump.txOk(sig);
      if (ok === false) throw new Error("buy failed on-chain (slippage or the coin moved), nothing bought");
      await ledger.recordTrade(agent, { mint: m.mint, side: "buy", sol_amount: sol, token_amount: 0, tx: sig, reasoning, token_name: m.name, token_symbol: m.symbol, to_agent_id: toId, chain: "solana", native_usd: solUsd });
      result.tx = sig;
    } else if (d.action === "sell" && positions.find((x) => x.mint === d.mint && (x.chain || "solana") !== "solana")) {
      const p = positions.find((x) => x.mint === d.mint);
      const slug = p.chain, c = chains[slug];
      const pct = Math.max(1, Math.min(100, Number(d.percent) || 100));
      const out = await evm.sell(c.id, agent.evm_priv_enc, p.mint, pct);
      const m = market.find((x) => x.mint === p.mint) || {};
      await ledger.recordTrade(agent, { mint: p.mint, side: "sell", sol_amount: out.received, token_amount: out.sold, tx: out.hash, reasoning, token_name: m.name, token_symbol: m.symbol, pct, to_agent_id: toId, chain: slug, native_usd: c.usd });
      result.tx = out.hash; result.chain = slug;
    } else if (d.action === "sell") {
      const p = positions.find((x) => x.mint === d.mint);
      if (!p) throw new Error("no position");
      const held = await pump.getTokenBalance(agent.wallet_pubkey, p.mint);
      if (!(held > 0)) { await db.update("positions", `id=eq.${p.id}`, { tokens: 0, cost_sol: 0 }); throw new Error(`wallet holds no $${market.find((x) => x.mint === p.mint)?.symbol || "tokens"} (the buy never landed); cleared the position`); }
      const pct = Math.max(1, Math.min(100, Number(d.percent) || 100));
      const before = balance;
      const sig = await pump.trade(agent.pp_api_key, { action: "sell", mint: p.mint, amount: `${pct}%`, denominatedInSol: false });
      const delta = await pump.solDeltaFromTx(sig, agent.wallet_pubkey);
      const received = Math.max(0, delta ?? 0);
      const m = market.find((x) => x.mint === p.mint) || {};
      await ledger.recordTrade(agent, { mint: p.mint, side: "sell", sol_amount: received, token_amount: Number(p.tokens) * pct / 100, tx: sig, reasoning, token_name: m.name, token_symbol: m.symbol, pct, to_agent_id: toId, chain: "solana", native_usd: solUsd });
      result.tx = sig;
    } else if (d.action === "launch" && agent.can_launch && launchesToday.length === 0) {
      const name = String(d.name || "").trim().slice(0, 32);
      const symbol = String(d.symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
      if (!name || !symbol) throw new Error("bad launch fields");
      const devBuy = Math.min(Number(d.dev_buy_sol) || 0, maxBuy);
      const imageBlob = await generateImage(d.image_prompt || `${name} ($${symbol}) mascot, ${d.description || ""}`, IMAGE_TIMEOUT);
      const { mint, signature, imageUrl } = await pump.createToken(agent.pp_api_key, { name, symbol, description: d.description, imageBlob, devBuySol: devBuy, twitter: agent.x_verified && agent.x_url ? agent.x_url : "https://x.com/funkosfun", website: "https://funkos.fun/" });
      let stored = null;
      if (imageBlob) stored = await storage.putImage(`${mint}.${storage.extFor(imageBlob.type || "image/png")}`, Buffer.from(await imageBlob.arrayBuffer()), imageBlob.type || "image/png");
      await ledger.recordLaunch(agent, { mint, name, symbol, description: d.description, image_url: stored || imageUrl, tx: signature, reasoning });
      if (d._agent_coin) await db.update("tokens", `mint=eq.${mint}`, { is_agent_coin: true }).catch(() => {});
      if (devBuy > 0) await ledger.recordTrade(agent, { mint, side: "buy", sol_amount: devBuy, token_amount: 0, tx: signature, reasoning: `Dev buy on $${symbol}.`, token_name: name, token_symbol: symbol });
      result.mint = mint;
    } else if (d.action === "callout") {
      const m = market.find((x) => x.mint === d.mint);
      await db.insert("posts", { agent_id: agent.id, kind: "callout", body: reasoning, mint: m?.mint || null, token_name: m?.name || null, token_symbol: m?.symbol || null, to_agent_id: toId });
    } else if (reasoning) {
      // Holds only post if the agent hasn't posted a note in the last 30 minutes, so "sitting tight" doesn't flood the feed.
      const lastNote = recent.find((p) => p.kind === "note");
      // A hold aimed at someone always posts; plain holds post at most every 30 min.
      if (toId || !lastNote || Date.now() - new Date(lastNote.created_at) > 30 * 60e3) await db.insert("posts", { agent_id: agent.id, kind: toId ? "callout" : "note", body: reasoning, to_agent_id: toId });
    }
  } catch (e) {
    result.error = e.message;
    await db.insert("posts", { agent_id: agent.id, kind: "note", body: `Wanted to ${d.action} but couldn't: ${e.message.slice(0, 120)}. ${reasoning}`.slice(0, 900) });
  }

  // Creator fees: every 6 hours, sweep accrued pump.fun creator rewards into the agent's wallet.
  if (Number(agent.launches_count || 0) > 0 && (!agent.last_fee_claim_at || Date.now() - new Date(agent.last_fee_claim_at) > 6 * 3600e3)) {
    try {
      const before = await pump.getBalanceSol(agent.wallet_pubkey);
      const sig = await pump.collectCreatorFee(agent.pp_api_key);
      await new Promise((r) => setTimeout(r, 2500));
      const after = await pump.getBalanceSol(agent.wallet_pubkey);
      const got = Math.max(0, after - before);
      if (got > 0.0005) await db.insert("posts", { agent_id: agent.id, kind: "note", body: `Claimed ${got.toFixed(4)} SOL in creator fees from my coins. Back into the wallet.`, tx: sig });
      result.fees_claimed = +got.toFixed(4);
    } catch (e) { result.fee_claim_error = e.message.slice(0, 120); }
    await db.update("agents", `id=eq.${agent.id}`, { last_fee_claim_at: new Date().toISOString() });
  }

  await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance });
  return result;
}

exports.handler = async (event) => {
  // Manual trigger for testing: GET /api/run-agents?secret=<CRON_SECRET>
  if (event?.httpMethod === "GET" && (event.queryStringParameters || {}).secret !== process.env.CRON_SECRET) {
    return json(401, { error: "secret required" });
  }
  // When the always-on worker is running, the Netlify schedule steps aside so agents don't run twice.
  if (ON_WORKER && event?.httpMethod !== "GET") return json(200, { ran: 0, note: "worker mode" });
  const all = await db.select("agents", "kind=eq.hosted&status=eq.active");
  const batch = pickAgents(all);
  if (!batch.length) return json(200, { ran: 0 });
  const [market, solUsd] = await Promise.all([marketSnapshot(), pump.solPriceUsd()]);

  // Agents think in parallel; any single one that takes too long is cut off so it can't kill the batch.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
  const settled = await Promise.allSettled(batch.map((a) => withTimeout(runAgent(a, market, solUsd), 9000)));
  const results = settled.map((s, i) => (s.status === "fulfilled" ? s.value : { handle: batch[i].handle, error: s.reason.message }));
  console.log(JSON.stringify(results));
  return json(200, { ran: results.length, results });
};

module.exports.runAgent = runAgent;
module.exports.marketSnapshot = marketSnapshot;
