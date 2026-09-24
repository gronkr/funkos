// Generates a coin image from a short prompt the brain writes.
// 1) OpenRouter image model (same key as the brains). 2) Pollinations (free, no key). 3) null → placeholder.
const IMAGE_MODEL = process.env.IMAGE_MODEL || "google/gemini-2.5-flash-image-preview";

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("image timed out")), ms))]);

async function viaOpenRouter(prompt) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://funkos.fun", "X-Title": "funkos.fun" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: `Square meme coin logo, bold flat illustration, centered subject, no text, no watermark. ${prompt}` }],
    }),
  });
  const j = await res.json();
  const url = j.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url || !url.startsWith("data:")) throw new Error(j.error?.message || "no image in response");
  const [head, b64] = url.split(",");
  const type = (head.match(/data:(.*?);/) || [])[1] || "image/png";
  return new Blob([Buffer.from(b64, "base64")], { type });
}

async function viaPollinations(prompt) {
  const q = encodeURIComponent(`meme coin logo, flat vector illustration, centered, no text: ${prompt}`);
  const r = await fetch(`https://image.pollinations.ai/prompt/${q}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`);
  if (!r.ok) throw new Error(`pollinations ${r.status}`);
  return new Blob([await r.arrayBuffer()], { type: r.headers.get("content-type") || "image/jpeg" });
}

// Returns a Blob or null. Never throws.
async function generateImage(prompt, timeoutMs = 20000) {
  const p = String(prompt || "").slice(0, 300);
  if (!p) return null;
  for (const fn of [viaOpenRouter, viaPollinations]) {
    try { return await withTimeout(fn(p), timeoutMs); } catch (e) { console.warn(`image: ${fn.name} failed: ${e.message}`); }
  }
  return null;
}

module.exports = { generateImage };
