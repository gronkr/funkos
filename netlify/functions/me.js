const db = require("./lib/db");
const pump = require("./lib/pump");
const { json, handler, body, ownerFromRequest, publicAgent, randomKey } = require("./lib/util");

// X verification: the owner posts a code from their account, pastes the post link, we read the public post via X's oEmbed
// endpoint (no API key needed) and check the code is in it and who posted it.
async function readPost(tweetUrl) {
  const m = String(tweetUrl || "").match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/);
  if (!m) throw new Error("That's not a link to a post. It should look like https://x.com/you/status/123…");
  const url = `https://twitter.com/${m[1]}/status/${m[2]}`;
  const r = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=1`);
  if (!r.ok) throw new Error("Couldn't read that post. Make sure it's public and the link is right.");
  const j = await r.json();
  const handle = (String(j.author_url || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/) || [])[1] || m[1];
  return { handle, html: String(j.html || "") };
}

exports.handler = handler(async (event) => {
  const agent = await ownerFromRequest(event);
  if (!agent) return json(401, { error: "Log in with your owner key (funk_owner_...)." });

  if (event.httpMethod === "POST") {
    const b = body(event);
    if (b.action === "x_claim") {
      const code = `funkos-${randomKey("").slice(0, 8).toLowerCase()}`;
      await db.update("agents", `id=eq.${agent.id}`, { x_claim_code: code });
      return json(200, { code, post_text: `Verifying my funkos.fun agent @${agent.handle}: ${code} https://funkos.fun` });
    }
    if (b.action === "x_verify") {
      if (!agent.x_claim_code) return json(400, { error: "Get a verification code first." });
      const post = await readPost(b.tweet_url);
      if (!post.html.toLowerCase().includes(agent.x_claim_code.toLowerCase())) return json(400, { error: "That post doesn't contain your code. Post the code, then paste the link to that post." });
      const taken = await db.select("agents", `x_url=eq.https://x.com/${post.handle}&x_verified=eq.true&id=neq.${agent.id}&limit=1`);
      if (taken.length) return json(409, { error: `@${post.handle} already owns another agent (@${taken[0].handle}).` });
      const [updated] = await db.update("agents", `id=eq.${agent.id}`, { x_url: `https://x.com/${post.handle}`, x_verified: true, x_claim_code: null });
      return json(200, { agent: publicAgent(updated) });
    }
    return json(400, { error: "unknown action" });
  }

  if (event.httpMethod === "PATCH") {
    const b = body(event);
    const patch = {};
    if (b.status === "paused" || b.status === "active") patch.status = b.status;
    if (typeof b.rules === "string") patch.rules = b.rules.slice(0, 2000);
    if (b.max_position_sol) patch.max_position_sol = Math.max(0.01, Math.min(Number(b.max_position_sol), 50));
    if (b.daily_limit_sol) patch.daily_limit_sol = Math.max(0.01, Math.min(Number(b.daily_limit_sol), 500));
    if (typeof b.can_launch === "boolean") patch.can_launch = b.can_launch;
    if (typeof b.agent_coin === "boolean") patch.agent_coin = b.agent_coin;
    if (b.auto_tp_pct !== undefined) patch.auto_tp_pct = Math.max(5, Math.min(Number(b.auto_tp_pct) || 40, 10000));
    if (b.auto_sl_pct !== undefined) patch.auto_sl_pct = Math.max(5, Math.min(Number(b.auto_sl_pct) || 20, 95));
    if (b.max_hold_min !== undefined) patch.max_hold_min = Math.max(0, Math.min(Number(b.max_hold_min) || 0, 100000));
    if (b.avatar_url !== undefined) patch.avatar_url = /^https?:\/\//.test(String(b.avatar_url || "")) ? String(b.avatar_url).slice(0, 300) : null;
    const [updated] = await db.update("agents", `id=eq.${agent.id}`, patch);
    return json(200, { agent: publicAgent(updated) });
  }

  const q = event.queryStringParameters || {};
  let balance_sol = null;
  try { balance_sol = await pump.getBalanceSol(agent.wallet_pubkey); } catch {}
  const out = { agent: publicAgent(agent), balance_sol };
  if (q.export === "1" && agent.kind === "hosted") out.wallet_private_key = agent.pp_private_key;
  return json(200, out);
});
