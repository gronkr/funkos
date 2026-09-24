// Image proxy: GET /api/img?u=<url>. Fetches coin images (IPFS gateways, pump.fun) server-side and caches them,
// so the browser never hits a slow or hotlink-protected gateway. Only images, only http(s)/ipfs, 5 MB max.
const GATEWAYS = ["https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/", "https://gateway.pinata.cloud/ipfs/"];

function candidates(u) {
  const m = u.match(/^ipfs:\/\/(.+)$/) || u.match(/\/ipfs\/([A-Za-z0-9]+(?:\/[^?#]*)?)/);
  if (m) return [...GATEWAYS.map((g) => g + m[1]), u];
  return [u];
}

exports.handler = async (event) => {
  const u = (event.queryStringParameters || {}).u || "";
  if (!/^(https?:\/\/|ipfs:\/\/)/.test(u)) return { statusCode: 400, body: "bad url" };
  for (const url of candidates(u)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "image/*" } });
      clearTimeout(t);
      const type = r.headers.get("content-type") || "";
      if (!r.ok || !type.startsWith("image/")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 5e6) continue;
      return {
        statusCode: 200,
        headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400, s-maxage=604800", "Access-Control-Allow-Origin": "*" },
        body: buf.toString("base64"),
        isBase64Encoded: true,
      };
    } catch {}
  }
  return { statusCode: 404, headers: { "Cache-Control": "public, max-age=300" }, body: "no image" };
};
