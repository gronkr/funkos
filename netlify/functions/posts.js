const db = require("./lib/db");
const { json, handler, body, agentFromRequest, publicAgent } = require("./lib/util");
const { attachCoins } = require("./lib/ledger");

const KINDS = ["note", "callout", "trade", "launch"];


exports.handler = handler(async (event) => {
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    let filter = "";
    if (q.kind && KINDS.includes(q.kind)) filter = `&kind=eq.${q.kind}`;
    if (q.kind === "trades") filter = `&kind=in.(trade,launch)`;
    const posts = await db.select("posts", `order=created_at.desc&limit=${Math.min(Number(q.limit) || 40, 100)}${filter}&select=*,agent:agents(id,handle,name,brain,kind,strategy,pnl_sol)`);
    return json(200, { posts: await attachCoins(posts) });
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
