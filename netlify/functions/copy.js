const db = require("./lib/db");
const pump = require("./lib/pump");
const { json, handler, body, bearer, sha256, randomKey, publicAgent } = require("./lib/util");

const pub = (c) => { const { pp_api_key, pp_private_key, owner_key_hash, ...rest } = c; return rest; };

async function copyFromRequest(event) {
  const key = bearer(event) || (event.queryStringParameters || {}).key;
  if (!key || !key.startsWith("funk_copy_")) return null;
  return (await db.select("copies", `owner_key_hash=eq.${sha256(key)}&limit=1`))[0] || null;
}

exports.handler = handler(async (event) => {
  // Create a copy: pick a leader, get a wallet to fund.
  if (event.httpMethod === "POST") {
    const b = body(event);
    const leader = (await db.select("agents", `handle=eq.${String(b.leader || "").toLowerCase()}&limit=1`))[0];
    if (!leader) return json(404, { error: "No agent with that handle." });
    const wallet = await pump.createWallet();
    const ownerKey = randomKey("funk_copy_");
    const copy = await db.insert("copies", {
      leader_id: leader.id, label: String(b.label || "").slice(0, 40) || null,
      wallet_pubkey: wallet.walletPublicKey, pp_api_key: wallet.apiKey, pp_private_key: wallet.privateKey,
      owner_key_hash: sha256(ownerKey),
      max_per_copy_sol: Math.max(0.005, Math.min(Number(b.max_per_copy_sol) || 0.05, 50)),
      daily_cap_sol: Math.max(0.01, Math.min(Number(b.daily_cap_sol) || 0.5, 500)),
      status: "active",
    });
    return json(200, { copy: pub(copy), leader: publicAgent(leader), owner_key: ownerKey, fund_address: wallet.walletPublicKey, note: "Save the key. Send SOL to fund_address; every trade the leader makes from now on is mirrored, capped to your limits." });
  }

  const copy = await copyFromRequest(event);
  if (!copy) return json(401, { error: "Log in with your copy key (funk_copy_...)." });

  if (event.httpMethod === "PATCH") {
    const b = body(event);
    const patch = {};
    if (b.status === "paused" || b.status === "active") patch.status = b.status;
    if (b.max_per_copy_sol) patch.max_per_copy_sol = Math.max(0.005, Math.min(Number(b.max_per_copy_sol), 50));
    if (b.daily_cap_sol) patch.daily_cap_sol = Math.max(0.01, Math.min(Number(b.daily_cap_sol), 500));
    const [updated] = await db.update("copies", `id=eq.${copy.id}`, patch);
    return json(200, { copy: pub(updated) });
  }

  const q = event.queryStringParameters || {};
  const [leader, trades] = await Promise.all([
    db.select("agents", `id=eq.${copy.leader_id}&limit=1`).then((r) => r[0]),
    db.select("copy_trades", `copy_id=eq.${copy.id}&order=created_at.desc&limit=50`),
  ]);
  let balance_sol = null;
  try { balance_sol = await pump.getBalanceSol(copy.wallet_pubkey); } catch {}
  const out = { copy: pub(copy), leader: leader ? publicAgent(leader) : null, balance_sol, trades };
  if (q.export === "1") out.wallet_private_key = copy.pp_private_key;
  return json(200, out);
});
