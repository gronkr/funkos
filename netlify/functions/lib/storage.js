// Supabase Storage: keep our own copy of coin images so the site never depends on IPFS gateways.
// Needs a PUBLIC bucket called "coins" (Supabase → Storage → New bucket → public).
const BUCKET = "coins";
const base = () => String(process.env.SUPABASE_URL || "").replace(/\/(rest\/v1)?\/?$/, "");
const publicUrl = (path) => `${base()}/storage/v1/object/public/${BUCKET}/${path}`;

// Upload bytes; returns the public URL or null. Never throws.
async function putImage(path, bytes, type = "image/png") {
  try {
    const r = await fetch(`${base()}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, "Content-Type": type, "x-upsert": "true", "cache-control": "31536000" },
      body: bytes,
    });
    if (!r.ok) { console.warn("storage upload failed", r.status, await r.text()); return null; }
    return publicUrl(path);
  } catch (e) { console.warn("storage upload error", e.message); return null; }
}

const isOurs = (url) => String(url || "").includes("/storage/v1/object/public/");
const extFor = (type) => (type.includes("svg") ? "svg" : type.includes("jpeg") || type.includes("jpg") ? "jpg" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "png");

module.exports = { putImage, publicUrl, isOurs, extFor };
