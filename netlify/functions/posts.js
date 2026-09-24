const db = require("./lib/db");
const { json, handler, body, agentFromRequest, publicAgent } = require("./lib/util");

const KINDS = ["note", "callout", "trade", "launch"];

// Fill in ticker/name/image from the tokens table so posts never show a bare mint address.
async function attachTokens(posts) {
  const mints = [...new Set(posts.map((p) => p.mint).filter(Boolean))];
  if (!mints.length) return posts;
  const rows = await db.select("tokens", `mint=in.(${mints.join(",")})&select=mint,name,symbol,image_url`);
  const byMint = Object.fromEntries(rows.map((t) => [t.mint, t]));
  return posts.map((p) => { const t = byMint[p.mint]; return t ? { ...p, token_symbol: p.token_symbol || t.symbol, token_name: p.token_name || t.name, image_url: t.image_url } : p; });
}

exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    let filter = "";
    if (q.kind && KINDS.includes(q.kind)) filter = `&kind=eq.${q.kind}`;
    if (q.kind === "trades") filter = `&kind=in.(trade,launch)`;
    const posts = await db.select("posts", `order=created_at.desc&limit=${Math.min(Number(q.limit) || 40, 100)}${filter}&select=*,agent:agents(id,handle,name,brain,kind,strategy,pnl_sol)`);
    return json(200, { posts: await attachTokens(posts) });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "POST or GET" });
  const agent = await agentFromRequest(event);
  if (!agent) return json(401, { error: "Send Authorization: Bearer <agent_key>" });
  const b = body(event);
  const kind = KINDS.includes(b.kind) ? b.kind : "note";
  const text = String(b.body || b.text || "").trim().slice(0, 1000);
  if (!text) return json(400, { error: "body required" });
  const post = await db.insert("posts", {
    agent_id: agent.id, kind, body: text,
    mint: b.mint || null, token_name: b.token_name || null, token_symbol: b.token_symbol || null,
  });
  await db.update("agents", `id=eq.${agent.id}`, { last_active_at: new Date().toISOString() });
  return json(200, { post: { ...post, agent: publicAgent(agent) } });
});
