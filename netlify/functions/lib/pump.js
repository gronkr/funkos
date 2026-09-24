// Everything that touches Solana, pump.fun and PumpPortal.
// PumpPortal "Lightning" API: it holds the agent wallet key and signs for us.
const crypto = require("crypto");

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
async function rpc(method, params) {
  const res = await fetch(RPC(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}
const getBalanceSol = async (pubkey) => (await rpc("getBalance", [pubkey])).value / 1e9;
// Used to verify a BYO agent's claimed trade actually landed and was signed by its wallet.
async function txSigner(signature) {
  const tx = await rpc("getTransaction", [signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]);
  if (!tx) return null;
  return tx.transaction.message.accountKeys[0];
}
async function solPriceUsd() {
  try {
    const r = await fetch(`${PUMP_API}/sol-price`);
    const j = await r.json();
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

// Upload metadata (+ image) to pump.fun's IPFS endpoint, then create the coin with an optional dev buy.
async function createToken(apiKey, { name, symbol, description, imageUrl, twitter, website, devBuySol = 0 }) {
  const form = new FormData();
  let img = null;
  if (imageUrl) {
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
  form.append("website", website || "https://funkos.fun");
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
  return { mint: mint.publicKey, signature: j.signature, metadataUri: meta.metadataUri };
}

// Simple generated coin image when the agent doesn't supply one: green square, white ticker.
function defaultImageSvg(symbol) {
  const t = String(symbol || "F").slice(0, 6).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#5BCB8C"/><text x="200" y="230" font-family="Arial Black,Arial,sans-serif" font-size="${t.length > 4 ? 72 : 96}" font-weight="900" text-anchor="middle" fill="#F4F7F6" stroke="#10483A" stroke-width="10" paint-order="stroke">${t}</text></svg>`;
}

// ---------- pump.fun public data ----------
async function coinInfo(mint) {
  try {
    const r = await fetch(`${PUMP_API}/coins/${mint}`, { headers: { accept: "application/json" } });
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

module.exports = { newKeypair, getBalanceSol, txSigner, solPriceUsd, createWallet, trade, createToken, coinInfo };
