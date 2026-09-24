// Everything that touches Solana, pump.fun and PumpPortal.
// PumpPortal "Lightning" API: it holds the agent wallet key and signs for us.
const crypto = require("crypto");
const { fetchT, fetchJson } = require("./http");

const RPC = () => process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PP = "https://pumpportal.fun/api";
const PUMP_API = "https://frontend-api-v3.pump.fun";

// ---------- base58 (no dependency) ----------
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(buf) {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
}

// A fresh Solana keypair (needed as the mint for token creation). Returns base58 secret (64 bytes) and pubkey.
function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return { publicKey: b58encode(pub), secretKey: b58encode(Buffer.concat([seed, pub])) };
}

// ---------- RPC ----------
async function rpc(method, params, ms = 5000) {
  const res = await fetchT(RPC(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, ms);
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}
const getBalanceSol = async (pubkey) => (await rpc("getBalance", [pubkey])).value / 1e9;
// SOL a wallet gained (or lost) in a confirmed transaction, read from the chain. Retries while the tx confirms.
async function solDeltaFromTx(signature, wallet, tries = 10) {
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await rpc("getTransaction", [signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }]);
      if (tx && tx.meta) {
        const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
        const idx = keys.indexOf(wallet);
        if (idx === -1) return null;
        return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// How many of a token a wallet holds (ui amount). 0 if none.
async function getTokenBalance(owner, mint) {
  try {
    const r = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
    return (r.value || []).reduce((s, acc) => s + Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
  } catch { return 0; }
}
// Used to verify a BYO agent's claimed trade actually landed and was signed by its wallet.
async function txSigner(signature) {
  const tx = await rpc("getTransaction", [signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx) return null;
  return tx.transaction.message.accountKeys[0];
}
async function solPriceUsd() {
  try {
    const j = await fetchJson(`${PUMP_API}/sol-price`, {}, 3000);
    return Number(j.solPrice) || 0;
  } catch { return 0; }
}

// ---------- PumpPortal Lightning ----------
async function createWallet() {
  const r = await fetch(`${PP}/create-wallet`);
  const j = await r.json(); // { apiKey, walletPublicKey, privateKey }
  if (!j.apiKey) throw new Error("PumpPortal wallet creation failed");
  return j;
}

async function trade(apiKey, { action, mint, amount, denominatedInSol, slippage = 15, priorityFee = 0.0005, pool = "auto" }) {
  const r = await fetch(`${PP}/trade?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, mint, amount, denominatedInSol: String(denominatedInSol), slippage, priorityFee, pool }),
  });
  const j = await r.json();
  if (!j.signature) throw new Error(`trade failed: ${JSON.stringify(j)}`);
  return j.signature;
}

// Claim accrued pump.fun creator fees into the agent's wallet (Lightning).
async function collectCreatorFee(apiKey) {
  const r = await fetchT(`${PP}/trade?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump" }),
  }, 8000);
  const j = await r.json();
  if (!j.signature) throw new Error(`collectCreatorFee: ${JSON.stringify(j)}`);
  return j.signature;
}

// Upload metadata (+ image) to pump.fun's IPFS endpoint, then create the coin with an optional dev buy.
async function createToken(apiKey, { name, symbol, description, imageUrl, imageBlob, twitter, website, devBuySol = 0 }) {
  const form = new FormData();
  let img = imageBlob || null;
  if (!img && imageUrl) {
    try {
      const ir = await fetch(imageUrl);
      img = new Blob([await ir.arrayBuffer()], { type: ir.headers.get("content-type") || "image/png" });
    } catch { img = null; }
  }
  if (!img) img = new Blob([defaultImageSvg(symbol)], { type: "image/svg+xml" });
  form.append("file", img, "image.png");
  form.append("name", name);
  form.append("symbol", symbol);
  form.append("description", description || "");
  form.append("twitter", twitter || "https://x.com/funkosfun");
  form.append("website", website || "https://funkos.fun/");
  form.append("showName", "true");
  const mr = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: form });
  const meta = await mr.json();
  if (!meta.metadataUri) throw new Error(`metadata upload failed: ${JSON.stringify(meta)}`);

  const mint = newKeypair();
  const r = await fetch(`${PP}/trade?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create",
      tokenMetadata: { name, symbol, uri: meta.metadataUri },
      mint: mint.secretKey,
      denominatedInSol: "true",
      amount: devBuySol,
      slippage: 15,
      priorityFee: 0.0005,
      pool: "pump",
    }),
  });
  const j = await r.json();
  if (!j.signature) throw new Error(`create failed: ${JSON.stringify(j)}`);
  return { mint: mint.publicKey, signature: j.signature, metadataUri: meta.metadataUri, imageUrl: meta.metadata?.image || null };
}

// Simple generated coin image when the agent doesn't supply one: green square, white ticker.
function defaultImageSvg(symbol) {
  const t = String(symbol || "F").slice(0, 6).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#5BCB8C"/><text x="200" y="230" font-family="Arial Black,Arial,sans-serif" font-size="${t.length > 4 ? 72 : 96}" font-weight="900" text-anchor="middle" fill="#F4F7F6" stroke="#10483A" stroke-width="10" paint-order="stroke">${t}</text></svg>`;
}

// ---------- pump.fun public data ----------
async function coinInfo(mint) {
  try {
    const r = await fetchT(`${PUMP_API}/coins/${mint}`, { headers: { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" } }, 4000);
    if (!r.ok) return null;
    const c = await r.json();
    return {
      mint,
      name: c.name,
      symbol: c.symbol,
      image_url: c.image_uri,
      mcap_usd: c.usd_market_cap ?? null,
      complete: !!c.complete,
      reply_count: c.reply_count ?? 0,
    };
  } catch { return null; }
}

// Token metadata straight from the chain via Helius DAS (getAsset). Works for any token; includes a CDN copy of the image.
async function dasAsset(mint) {
  try {
    const a = await rpc("getAsset", { id: mint });
    if (!a) return null;
    const meta = a.content?.metadata || {};
    const file = (a.content?.files || [])[0] || {};
    const image = file.cdn_uri || a.content?.links?.image || file.uri || null;
    if (!meta.symbol && !meta.name && !image) return null;
    return { mint, name: meta.name || null, symbol: meta.symbol || null, image_url: image, mcap_usd: null };
  } catch { return null; }
}

// Route IPFS/gateway image URLs through Helius' image CDN (fast, cached). Leaves other URLs alone.
function cdnify(url) {
  if (!url) return url;
  if (url.includes("cdn.helius-rpc.com") || url.includes("/storage/v1/object/public/")) return url;
  const m = url.match(/^ipfs:\/\/(.+)$/) || url.match(/\/ipfs\/([A-Za-z0-9]+(?:\/[^?#]*)?)/);
  if (m) return `https://cdn.helius-rpc.com/cdn-cgi/image//https://ipfs.io/ipfs/${m[1]}`;
  return url;
}

// Trending pump.fun coins with live volume. pump.fun first (most recently traded, in a sane mcap band), Jupiter top-trending as fallback.
async function trendingCoins(limit = 12) {
  const band = (m) => m >= 8000 && m <= 2_000_000;
  try {
    const j = await fetchJson(`${PUMP_API}/coins?offset=0&limit=60&sort=last_trade_timestamp&order=DESC&includeNsfw=false`, { headers: { origin: "https://pump.fun", referer: "https://pump.fun/" } }, 5000);
    const rows = (Array.isArray(j) ? j : j.coins || []).filter((c) => c.mint && band(Number(c.usd_market_cap || 0)));
    if (rows.length >= 4) {
      return rows.sort((a, b) => Number(b.usd_market_cap) - Number(a.usd_market_cap)).slice(0, limit).map((c) => ({
        mint: c.mint, name: c.name, symbol: c.symbol, image_url: c.image_uri || null, mcap_usd: Math.round(Number(c.usd_market_cap)),
        graduated: !!c.complete, age_min: c.created_timestamp ? Math.round((Date.now() - Number(c.created_timestamp)) / 60000) : null,
      }));
    }
  } catch {}
  try {
    const j = await fetchJson(`https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=60`, {}, 5000);
    return (Array.isArray(j) ? j : []).filter((t) => String(t.id).endsWith("pump") && band(Number(t.mcap || 0))).slice(0, limit).map((t) => ({
      mint: t.id, name: t.name, symbol: t.symbol, image_url: t.icon || null, mcap_usd: Math.round(Number(t.mcap)),
      graduated: !!t.graduatedPool, age_min: t.firstPool?.createdAt ? Math.round((Date.now() - new Date(t.firstPool.createdAt)) / 60000) : null,
      change_1h_pct: t.stats1h?.priceChange != null ? +Number(t.stats1h.priceChange).toFixed(1) : undefined,
      buys_1h: t.stats1h?.numBuys, sells_1h: t.stats1h?.numSells,
    }));
  } catch { return []; }
}

// Name/symbol/image for ANY Solana token: pump.fun, then chain metadata (Helius DAS), then DexScreener. Never throws.
async function tokenMeta(mint) {
  // pump.fun and Helius in parallel; Helius' CDN copy of the image is preferred because IPFS gateways are slow.
  const [c, d] = await Promise.all([coinInfo(mint), dasAsset(mint)]);
  const image = cdnify(d?.image_url || c?.image_url || null);
  if (c && (c.symbol || c.name)) return { ...c, name: c.name || d?.name, symbol: c.symbol || d?.symbol, image_url: image };
  if (d && (d.symbol || d.name)) return { ...d, image_url: image };
  const jup = await jupiterInfo(mint);
  try {
    const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 4000);
    const pair = (j.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!pair) return jup;
    return { mint, name: pair.baseToken?.name || jup?.name, symbol: pair.baseToken?.symbol || jup?.symbol, image_url: pair.info?.imageUrl || jup?.image_url || null, mcap_usd: pair.marketCap ?? pair.fdv ?? jup?.mcap_usd ?? null, complete: !pair.dexId?.includes("pump") };
  } catch { return jup; }
}

// Jupiter token search: fast, has icons for nearly every Solana token.
async function jupiterInfo(mint) {
  try {
    const j = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`, {}, 4000);
    const t = (Array.isArray(j) ? j : []).find((x) => x.id === mint) || (Array.isArray(j) ? j[0] : null);
    if (!t) return null;
    return { mint, name: t.name || null, symbol: t.symbol || null, image_url: t.icon || null, mcap_usd: t.mcap ?? null };
  } catch { return null; }
}

module.exports = { trendingCoins, solDeltaFromTx, getTokenBalance, collectCreatorFee, tokenMeta, dasAsset, jupiterInfo, cdnify, newKeypair, getBalanceSol, txSigner, solPriceUsd, createWallet, trade, createToken, coinInfo };
