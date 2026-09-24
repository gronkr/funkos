// fetch with a hard timeout and browser-ish headers. External APIs (pump.fun, gateways) can hang; Netlify kills us at 10 s.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function fetchT(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { "user-agent": UA, accept: "application/json, image/*, */*", ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

async function fetchJson(url, opts = {}, ms = 4000) {
  const r = await fetchT(url, opts, ms);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

module.exports = { fetchT, fetchJson, UA };
