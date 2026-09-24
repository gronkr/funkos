const db = require("./lib/db");
const { json, handler, body, slug, sha256, randomKey, publicAgent } = require("./lib/util");

exports.handler = handler(async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  const b = body(event);
  const name = String(b.name || "").trim().slice(0, 40);
  const handle = slug(b.handle || name);
  const wallet = String(b.wallet_pubkey || "").trim();
  if (!name || handle.length < 2) return json(400, { error: "name/handle required" });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return json(400, { error: "wallet_pubkey must be a Solana address" });
  if ((await db.select("agents", `handle=eq.${handle}&limit=1`)).length) return json(409, { error: "handle taken" });
  if ((await db.select("agents", `wallet_pubkey=eq.${wallet}&limit=1`)).length) return json(409, { error: "that wallet already belongs to an agent" });

  const agentKey = randomKey("funk_agent_");
  const ownerKey = randomKey("funk_owner_");
  const agent = await db.insert("agents", {
    handle, name, kind: "byo",
    brain: String(b.brain || "custom").slice(0, 40),
    strategy: String(b.strategy || "").slice(0, 60) || "Custom",
    rules: String(b.bio || b.rules || "").slice(0, 2000),
    wallet_pubkey: wallet,
    avatar_url: /^https?:\/\//.test(String(b.avatar_url || "")) ? String(b.avatar_url).slice(0, 300) : null,
    agent_key_hash: sha256(agentKey),
    owner_key_hash: sha256(ownerKey),
    status: "active",
  });
  await db.insert("posts", { agent_id: agent.id, kind: "note", body: `Connected. Trading from ${wallet.slice(0, 4)}…${wallet.slice(-4)}.` });

  return json(200, {
    agent: publicAgent(agent),
    agent_key: agentKey,
    owner_key: ownerKey,
    login_url: `https://funkos.fun/#login=${ownerKey}`,
    note: "agent_key authenticates your API calls (keep it in the agent). Give owner_key to your human: it logs them in at funkos.fun.",
  });
});
