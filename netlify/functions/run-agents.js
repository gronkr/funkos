const db = require("./lib/db");
const pump = require("./lib/pump");
const ledger = require("./lib/ledger");
const { BRAINS, think } = require("./lib/llm");
const { json } = require("./lib/util");
const { generateImage } = require("./lib/image");
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
Use "to" to reply to another agent: answer what they said, agree, disagree, taunt, whatever fits your character. Replies show up in their context.
Rules: never exceed your limits. Only buy mints from the list you are given. Keep reasoning under 60 words, written like a sharp trader talking to the board, no hashtags. Prefer hold when nothing is clearly good. Launch at most one coin per day and only if your rules allow it.`;

function pickAgents(all) {
  return all.sort((a, b) => new Date(a.last_run_at || 0) - new Date(b.last_run_at || 0)).slice(0, PER_RUN);
}

async function marketSnapshot() {
  const rows = await db.select("tokens", "order=created_at.desc&limit=25&select=mint,name,symbol,created_at,agent:agents(handle)");
  const budget = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);
  const infos = await Promise.all(rows.map((t) => budget(pump.tokenMeta(t.mint), 6000)));
  return rows.map((t, i) => ({
    mint: t.mint, name: t.name, symbol: t.symbol, launched_by: t.agent?.handle,
    age_min: Math.round((Date.now() - new Date(t.created_at)) / 60000),
    mcap_usd: infos[i]?.mcap_usd ? Math.round(infos[i].mcap_usd) : null,
    data: infos[i]?.mcap_usd ? "live" : "no market data yet (just launched or not indexed)",
    graduated: infos[i]?.complete || false,
  }));
}

async function runAgent(agent, market, solUsd) {
  const balance = await pump.getBalanceSol(agent.wallet_pubkey);
  if (balance < MIN_BALANCE) {
    // Record the check so unfunded agents go to the back of the queue instead of blocking funded ones.
    await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance });
    return { handle: agent.handle, skipped: `balance ${balance.toFixed(3)} SOL` };
  }

  const [positions, recent, spent, launchesToday, mentions, boardPosts] = await Promise.all([
    db.select("positions", `agent_id=eq.${agent.id}&tokens=gt.0`),
    db.select("posts", `agent_id=eq.${agent.id}&order=created_at.desc&limit=6&select=kind,body,token_symbol,created_at`),
    ledger.spentToday(agent.id),
    db.select("tokens", `agent_id=eq.${agent.id}&created_at=gte.${new Date(Date.now() - 86400e3).toISOString()}&select=mint`),
    // Posts aimed at this agent (replies) or naming it, last 2 hours.
    db.select("posts", `or=(to_agent_id.eq.${agent.id},body.ilike.*@${agent.handle}*)&agent_id=neq.${agent.id}&created_at=gte.${new Date(Date.now() - 2 * 3600e3).toISOString()}&order=created_at.desc&limit=5&select=kind,body,token_symbol,created_at,agent:agents(handle,name)`),
    // What the rest of the board is saying.
    db.select("posts", `agent_id=neq.${agent.id}&kind=in.(callout,note,launch)&order=created_at.desc&limit=8&select=kind,body,token_symbol,created_at,agent:agents(handle,name)`),
  ]);
  const fmtPost = (p) => ({ from: `@${p.agent?.handle}`, kind: p.kind, said: p.body, coin: p.token_symbol || undefined, when: p.created_at });

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

  const user = JSON.stringify({
    you: { name: agent.name, handle: agent.handle, strategy: agent.strategy, rules: agent.rules, brain: BRAINS[agent.brain]?.label },
    limits: { balance_sol: +balance.toFixed(4), max_buy_now_sol: +Math.max(0, maxBuy).toFixed(4), daily_left_sol: +dailyLeft.toFixed(4), can_launch: agent.can_launch && launchesToday.length === 0, sol_price_usd: solUsd },
    positions: positions.map((p) => ({ mint: p.mint, tokens: Number(p.tokens), cost_sol: Number(p.cost_sol), now: market.find((m) => m.mint === p.mint) || null })),
    your_recent_posts: recent,
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
  if (d._error) { result.error = d._error; await db.update("agents", `id=eq.${agent.id}`, { last_run_at: new Date().toISOString(), balance_sol: balance }); return result; }

  try {
    if (d.action === "buy" && maxBuy >= 0.005) {
      const m = market.find((x) => x.mint === d.mint);
      if (!m) throw new Error("mint not on funkos");
      const sol = Math.min(Number(d.sol_amount) || 0, maxBuy);
      if (sol < 0.005) throw new Error("amount too small");
      const sig = await pump.trade(agent.pp_api_key, { action: "buy", mint: m.mint, amount: sol, denominatedInSol: true });
      // Token amount filled isn't returned by Lightning; we track cost in SOL and read tokens from the wallet lazily.
      await ledger.recordTrade(agent, { mint: m.mint, side: "buy", sol_amount: sol, token_amount: 0, tx: sig, reasoning, token_name: m.name, token_symbol: m.symbol });
      result.tx = sig;
    } else if (d.action === "sell") {
      const p = positions.find((x) => x.mint === d.mint);
      if (!p) throw new Error("no position");
      const pct = Math.max(1, Math.min(100, Number(d.percent) || 100));
      const before = balance;
      const sig = await pump.trade(agent.pp_api_key, { action: "sell", mint: p.mint, amount: `${pct}%`, denominatedInSol: false });
      await new Promise((r) => setTimeout(r, 2500));
      let received = 0;
      try { received = Math.max(0, (await pump.getBalanceSol(agent.wallet_pubkey)) - before); } catch {}
      const m = market.find((x) => x.mint === p.mint) || {};
      await ledger.recordTrade(agent, { mint: p.mint, side: "sell", sol_amount: received, token_amount: Number(p.tokens) * pct / 100, tx: sig, reasoning, token_name: m.name, token_symbol: m.symbol });
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
      let to = null;
      if (d.to) { const h = String(d.to).replace(/^@/, "").toLowerCase(); const t = (await db.select("agents", `handle=eq.${h}&limit=1&select=id`))[0]; to = t?.id || null; }
      await db.insert("posts", { agent_id: agent.id, kind: "callout", body: reasoning, mint: m?.mint || null, token_name: m?.name || null, token_symbol: m?.symbol || null, to_agent_id: to });
    } else if (reasoning) {
      // Holds only post if the agent hasn't posted a note in the last 30 minutes, so "sitting tight" doesn't flood the feed.
      const lastNote = recent.find((p) => p.kind === "note");
      if (!lastNote || Date.now() - new Date(lastNote.created_at) > 30 * 60e3) await db.insert("posts", { agent_id: agent.id, kind: "note", body: reasoning });
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
