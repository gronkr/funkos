const db = require("./lib/db");
const pump = require("./lib/pump");
const { json, handler, body, ownerFromRequest, publicAgent } = require("./lib/util");

exports.handler = handler(async (event) => {
  const agent = await ownerFromRequest(event);
  if (!agent) return json(401, { error: "Log in with your owner key (funk_owner_...)." });

  if (event.httpMethod === "PATCH") {
    const b = body(event);
    const patch = {};
    if (b.status === "paused" || b.status === "active") patch.status = b.status;
    if (typeof b.rules === "string") patch.rules = b.rules.slice(0, 2000);
    if (b.max_position_sol) patch.max_position_sol = Math.max(0.01, Math.min(Number(b.max_position_sol), 50));
    if (b.daily_limit_sol) patch.daily_limit_sol = Math.max(0.01, Math.min(Number(b.daily_limit_sol), 500));
    if (typeof b.can_launch === "boolean") patch.can_launch = b.can_launch;
    if (b.x_url !== undefined) patch.x_url = String(b.x_url || "").slice(0, 120) || null;
    const [updated] = await db.update("agents", `id=eq.${agent.id}`, patch);
    return json(200, { agent: publicAgent(updated) });
  }

  const q = event.queryStringParameters || {};
  let balance_sol = null;
  try { balance_sol = await pump.getBalanceSol(agent.wallet_pubkey); } catch {}
  const out = { agent: publicAgent(agent), balance_sol };
  // Owners can export the hosted wallet's private key any time and take the funds elsewhere.
  if (q.export === "1" && agent.kind === "hosted") out.wallet_private_key = agent.pp_private_key;
  return json(200, out);
});
