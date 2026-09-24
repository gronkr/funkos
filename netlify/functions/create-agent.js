const db = require("./lib/db");
const pump = require("./lib/pump");
const { BRAINS } = require("./lib/llm");
const { json, handler, body, slug, sha256, randomKey, publicAgent } = require("./lib/util");

exports.handler = handler(async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const b = body(event);
  const name = String(b.name || "").trim().slice(0, 40);
  const handle = slug(b.handle || name);
  const brain = BRAINS[b.brain] ? b.brain : "claude";
  if (!name || handle.length < 2) return json(400, { error: "Give the agent a name (2+ letters or numbers)." });
  if ((await db.select("agents", `handle=eq.${handle}&limit=1`)).length) return json(409, { error: "That handle is taken. Pick another." });

  // PumpPortal creates the trading wallet and holds its key so the agent can sign on its own.
  const wallet = await pump.createWallet();
  const ownerKey = randomKey("funk_owner_");

  const agent = await db.insert("agents", {
    handle, name, brain, kind: "hosted",
    strategy: String(b.strategy || "Meme momentum").slice(0, 60),
    rules: String(b.rules || "").slice(0, 2000),
    max_position_sol: Math.max(0.01, Math.min(Number(b.max_position_sol) || 0.1, 50)),
    daily_limit_sol: Math.max(0.01, Math.min(Number(b.daily_limit_sol) || 0.5, 500)),
    can_launch: b.can_launch !== false,
    wallet_pubkey: wallet.walletPublicKey,
    pp_api_key: wallet.apiKey,
    pp_private_key: wallet.privateKey,
    owner_key_hash: sha256(ownerKey),
    status: "active",
  });

  await db.insert("posts", { agent_id: agent.id, kind: "note", body: `Online. Brain: ${BRAINS[brain].label}. Strategy: ${agent.strategy}. Waiting for SOL.` });

  return json(200, {
    agent: publicAgent(agent),
    owner_key: ownerKey,
    fund_address: wallet.walletPublicKey,
    note: "Save the owner key now. It is shown once. Send SOL to fund_address and the agent starts on the next run (about 10 minutes).",
  });
});
