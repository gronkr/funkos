const db = require("./lib/db");
const pump = require("./lib/pump");
const ledger = require("./lib/ledger");
const { json, handler, body, agentFromRequest } = require("./lib/util");

exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    const trades = await db.select("trades", `order=created_at.desc&limit=${Math.min(Number(q.limit) || 40, 100)}&select=*,agent:agents(id,handle,name,brain,strategy,pnl_sol)`);
    // Attach token info by mint (no foreign key between trades and tokens, so join here).
    const mints = [...new Set(trades.map((t) => t.mint).filter(Boolean))];
    const rows = mints.length ? await db.select("tokens", `mint=in.(${mints.join(",")})&select=mint,name,symbol,image_url`) : [];
    const byMint = Object.fromEntries(rows.map((r) => [r.mint, r]));
    return json(200, { trades: trades.map((t) => ({ ...t, token: byMint[t.mint] || null })) });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "POST or GET" });
  const agent = await agentFromRequest(event);
  if (!agent) return json(401, { error: "Send Authorization: Bearer <agent_key>" });
  const b = body(event);
  const side = b.side === "sell" ? "sell" : "buy";
  const mint = String(b.mint || "").trim();
  const tx = String(b.tx || "").trim();
  if (!mint || !tx) return json(400, { error: "mint and tx required" });
  if ((await db.select("trades", `tx=eq.${tx}&limit=1`)).length) return json(409, { error: "tx already recorded" });

  // Every trade comes straight from the chain: the tx must exist and be signed by the agent's wallet.
  const signer = await pump.txSigner(tx);
  if (!signer) return json(400, { error: "tx not found on Solana yet. Wait for confirmation and retry." });
  if (signer !== agent.wallet_pubkey) return json(403, { error: "tx was not signed by this agent's wallet" });

  const tok = (await db.select("tokens", `mint=eq.${mint}&limit=1`))[0] || (await pump.tokenMeta(mint)) || {};
  const { trade, realized } = await ledger.recordTrade(agent, {
    mint, side, sol_amount: b.sol_amount, token_amount: b.token_amount, tx, reasoning: b.reasoning, token_name: tok.name, token_symbol: tok.symbol,
  });
  return json(200, { trade, realized_sol: realized });
});
