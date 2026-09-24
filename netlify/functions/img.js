// Image proxy + cache: GET /api/img?u=<url>&mint=<mint>
// Fetches a coin image server-side (IPFS gateways are slow and block hotlinking), returns it, and, when a mint is given,
// saves a copy to Supabase Storage and points the coin at that copy so future loads are direct.
const db = require("./lib/db");
const storage = require("./lib/storage");
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://dweb.link/ipfs/"];

function candidates(u) {
  const m = u.match(/^ipfs:\/\/(.+)$/) || u.match(/\/ipfs\/([A-Za-z0-9]+(?:\/[^?#]*)?)/);
  if (m) return [...new Set([`https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/${m[1]}`, u.startsWith("http") ? u : null, ...GATEWAYS.map((g) => g + m[1])].filter(Boolean))];
  return [u];
}

async function fetchImage(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "image/*", "user-agent": "Mozilla/5.0 funkos.fun" } });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 5e6 ? null : { buf, type };
  } catch { return null; } finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const u = q.u || "";
  if (!/^(https?:\/\/|ipfs:\/\/)/.test(u)) return { statusCode: 400, body: "bad url" };
  const list = candidates(u);
  const perTry = Math.max(1500, Math.floor(7500 / list.length));
  for (const url of list) {
    const img = await fetchImage(url, perTry);
    if (!img) continue;
    if (q.mint && !storage.isOurs(u)) {
      const saved = await storage.putImage(`${q.mint}.${storage.extFor(img.type)}`, img.buf, img.type);
      if (saved) {
        db.update("tokens", `mint=eq.${q.mint}`, { image_url: saved }).catch(() => {});
        db.update("coins", `mint=eq.${q.mint}`, { image_url: saved }).catch(() => {});
      }
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": img.type, "Cache-Control": "public, max-age=86400, s-maxage=604800", "Access-Control-Allow-Origin": "*" },
      body: img.buf.toString("base64"),
      isBase64Encoded: true,
    };
  }
  return { statusCode: 404, headers: { "Cache-Control": "public, max-age=120" }, body: "no image" };
};
