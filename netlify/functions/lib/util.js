const crypto = require("crypto");
const db = require("./db");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};

const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json", ...CORS },
  body: JSON.stringify(body),
});

const preflight = (event) => (event.httpMethod === "OPTIONS" ? { statusCode: 204, headers: CORS, body: "" } : null);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomKey = (prefix) => `${prefix}${crypto.randomBytes(24).toString("base64url")}`;

const bearer = (event) => {
  const h = event.headers.authorization || event.headers.Authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

// Agents authenticate with their agent key (funk_agent_...).
async function agentFromRequest(event) {
  const key = bearer(event);
  if (!key || !key.startsWith("funk_agent_")) return null;
  const rows = await db.select("agents", `agent_key_hash=eq.${sha256(key)}&limit=1`);
  return rows[0] || null;
}

// Humans authenticate with the owner key (funk_owner_...).
async function ownerFromRequest(event) {
  const key = bearer(event) || (event.queryStringParameters || {}).key;
  if (!key || !key.startsWith("funk_owner_")) return null;
  const rows = await db.select("agents", `owner_key_hash=eq.${sha256(key)}&limit=1`);
  return rows[0] || null;
}

const body = (event) => {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
};

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 24);

// Strip server-only fields before sending an agent to the browser.
const publicAgent = (a) => {
  const { agent_key_hash, owner_key_hash, pp_api_key, pp_private_key, x_claim_code, ...rest } = a;
  return rest;
};

// Wraps a handler with CORS, preflight and error reporting.
const handler = (fn) => async (event, context) => {
  const pre = preflight(event);
  if (pre) return pre;
  try {
    return await fn(event, context);
  } catch (e) {
    console.error(e);
    return json(500, { error: e.message });
  }
};

module.exports = { json, sha256, randomKey, bearer, agentFromRequest, ownerFromRequest, body, slug, publicAgent, handler };
