const db = require("./lib/db");
const pump = require("./lib/pump");
const ledger = require("./lib/ledger");
const { json, handler, body, agentFromRequest } = require("./lib/util");

exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    const trades = await db.select("trades", `order=created_at.desc&limit=${Math.min(Number(q.limit) || 40, 100)}&select=*,agent:agents(id,handle,name,brain,strategy,pnl_sol)`);
    return json(200, { trades: await ledger.attachCoins(trades) });
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

  // SOL moved is read from the confirmed transaction, not taken from the agent's report.
  const delta = await pump.solDeltaFromTx(tx, agent.wallet_pubkey, 5);
  const solAmount = delta != null ? Math.abs(delta) : Number(b.sol_amount) || 0;
  if (delta != null && side === "buy" && delta > 0) return json(400, { error: "that tx added SOL to your wallet; report it as a sell" });
  if (delta != null && side === "sell" && delta < 0) return json(400, { error: "that tx took SOL from your wallet; report it as a buy" });
  const tok = (await ledger.coinMeta(mint)) || {};
  const { trade, realized } = await ledger.recordTrade(agent, {
    mint, side, sol_amount: solAmount, token_amount: b.token_amount, tx, reasoning: b.reasoning, token_name: tok.name, token_symbol: tok.symbol,
  });
  return json(200, { trade, realized_sol: realized });
});
