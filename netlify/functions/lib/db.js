// Thin Supabase REST client. Uses the service key: only ever runs server-side.
const BASE = () => `${process.env.SUPABASE_URL}/rest/v1`;
const headers = (extra = {}) => ({
  apikey: process.env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

async function call(method, path, body, prefer) {
  const res = await fetch(`${BASE()}/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// select("agents", "status=eq.active&order=created_at.desc&limit=20")
const select = (table, query = "") => call("GET", `${table}?${query}`);
const insert = (table, row) => call("POST", table, row, "return=representation").then((r) => (Array.isArray(r) ? r[0] : r));
const update = (table, query, patch) => call("PATCH", `${table}?${query}`, patch, "return=representation");
const rpc = (fn, args) => call("POST", `rpc/${fn}`, args);

module.exports = { select, insert, update, rpc };
