// EVM chains: wallets, balances, prices, trending coins and swaps via 0x Swap API v2 (allowance-holder).
const { ethers } = require("ethers");
const { fetchJson, fetchT } = require("./http");
const secrets = require("./secrets");

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeEEEeeeeEeeeeeeeEEeE";
const CHAINS = {
  56: { id: 56, slug: "bsc", name: "BNB Chain", native: "BNB", rpc: () => process.env.RPC_56 || "https://bsc-dataseed.binance.org", explorer: "https://bscscan.com/tx/", gecko: "bsc", dex: "bsc", cg: "binancecoin", minGas: 0.003, decimals: 18 },
  4663: { id: 4663, slug: "robinhood", name: "Robinhood Chain", native: "ETH", rpc: () => process.env.RPC_4663 || "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com/tx/", gecko: process.env.GECKO_4663 || null, dex: process.env.DEX_4663 || "robinhoodchain", cg: "ethereum", minGas: 0.0005, decimals: 18 },
};
const enabledChains = () => String(process.env.CHAINS || "56,4663").split(",").map((s) => Number(s.trim())).filter((id) => CHAINS[id] && secrets.enabled());
const bySlug = (slug) => Object.values(CHAINS).find((c) => c.slug === slug);

const providers = {};
const provider = (id) => (providers[id] ||= new ethers.JsonRpcProvider(CHAINS[id].rpc(), id, { staticNetwork: true }));
const signer = (id, privEnc) => new ethers.Wallet(secrets.decrypt(privEnc), provider(id));

function newWallet() { const w = ethers.Wallet.createRandom(); return { address: w.address, privEnc: secrets.encrypt(w.privateKey) }; }

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"];

async function nativeBalance(id, address) { return Number(ethers.formatEther(await provider(id).getBalance(address))); }
async function tokenBalance(id, token, address) {
  try { const c = new ethers.Contract(token, ERC20, provider(id)); const [bal, dec] = await Promise.all([c.balanceOf(address), c.decimals()]); return { raw: bal, decimals: Number(dec), amount: Number(ethers.formatUnits(bal, dec)) }; }
  catch { return { raw: 0n, decimals: 18, amount: 0 }; }
}

// Native token USD price (BNB / ETH), cached a minute.
const priceCache = {};
async function nativeUsd(id) {
  const c = CHAINS[id], now = Date.now();
  if (priceCache[id] && now - priceCache[id].at < 60e3) return priceCache[id].v;
  try { const j = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${c.cg}&vs_currencies=usd`, {}, 4000); const v = Number(j[c.cg]?.usd) || 0; priceCache[id] = { at: now, v }; return v; } catch { return priceCache[id]?.v || 0; }
}

// Token metadata + price from DexScreener, on this chain only.
async function tokenMeta(id, token) {
  try {
    const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {}, 4000);
    const pair = (j.pairs || []).filter((p) => p.chainId === CHAINS[id].dex).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    if (!pair) return null;
    return { mint: token, chain: CHAINS[id].slug, name: pair.baseToken?.name, symbol: pair.baseToken?.symbol, image_url: pair.info?.imageUrl || null, mcap_usd: pair.marketCap ?? pair.fdv ?? null, price_usd: Number(pair.priceUsd) || null, liquidity_usd: pair.liquidity?.usd ?? null, change_1h_pct: pair.priceChange?.h1 ?? null, vol_24h_usd: pair.volume?.h24 ?? null };
  } catch { return null; }
}

// Trending coins on a chain: GeckoTerminal trending pools (no key). Robinhood Chain's GeckoTerminal id is looked up by name once.
let geckoNet = {};
async function geckoNetwork(id) {
  const c = CHAINS[id];
  if (c.gecko) return c.gecko;
  if (geckoNet[id] !== undefined) return geckoNet[id];
  try {
    for (let page = 1; page <= 5; page++) {
      const j = await fetchJson(`https://api.geckoterminal.com/api/v2/networks?page=${page}`, {}, 4000);
      const hit = (j.data || []).find((n) => /robinhood/i.test(n.attributes?.name || "") || /robinhood/i.test(n.id));
      if (hit) { geckoNet[id] = hit.id; return hit.id; }
      if (!(j.data || []).length) break;
    }
  } catch {}
  geckoNet[id] = null; return null;
}
async function trending(id, limit = 8) {
  const net = await geckoNetwork(id); if (!net) return [];
  try {
    const j = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${net}/trending_pools?page=1`, {}, 5000);
    const out = [];
    for (const p of j.data || []) {
      const a = p.attributes || {}; const base = (p.relationships?.base_token?.data?.id || "").split("_").pop();
      const mcap = Number(a.market_cap_usd || a.fdv_usd || 0);
      if (!base || !/^0x[0-9a-fA-F]{40}$/.test(base) || mcap < 8000 || mcap > 5_000_000) continue;
      out.push({ mint: base, chain: CHAINS[id].slug, name: (a.name || "").split(" / ")[0], symbol: (a.name || "").split(" / ")[0], mcap_usd: Math.round(mcap), price_usd: Number(a.base_token_price_usd) || null, change_1h_pct: Number(a.price_change_percentage?.h1) || null, vol_24h_usd: Math.round(Number(a.volume_usd?.h24) || 0), age_min: a.pool_created_at ? Math.round((Date.now() - new Date(a.pool_created_at)) / 60000) : null });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// ---- 0x Swap API v2 (allowance-holder) ----
async function zeroXQuote(id, params) {
  const key = process.env.ZEROX_API_KEY; if (!key) throw new Error("ZEROX_API_KEY not set");
  const url = `https://api.0x.org/swap/allowance-holder/quote?${new URLSearchParams({ chainId: String(id), slippageBps: "300", ...params })}`;
  const r = await fetchT(url, { headers: { "0x-api-key": key, "0x-version": "v2" } }, 8000);
  const j = await r.json();
  if (!r.ok || !j.transaction) throw new Error(`0x: ${j.reason || j.message || JSON.stringify(j).slice(0, 160)}`);
  return j;
}
async function send(id, w, tx) {
  const resp = await w.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : 0n, gasLimit: tx.gas ? BigInt(Math.floor(Number(tx.gas) * 1.25)) : undefined });
  const rec = await resp.wait(1, 90000);
  if (!rec || rec.status !== 1) throw new Error("tx failed on-chain");
  return rec;
}
// Buy token with `nativeAmount` of the chain's native coin. Returns { hash, tokens }.
async function buy(id, privEnc, token, nativeAmount) {
  const w = signer(id, privEnc);
  const q = await zeroXQuote(id, { sellToken: NATIVE, buyToken: token, sellAmount: ethers.parseEther(String(nativeAmount)).toString(), taker: w.address });
  const rec = await send(id, w, q.transaction);
  const bal = await tokenBalance(id, token, w.address);
  return { hash: rec.hash, tokens: bal.amount, expected: q.buyAmount };
}
// Sell pct% of a token for native. Returns { hash, received } (received = native delta, read from balances).
async function sell(id, privEnc, token, pct = 100) {
  const w = signer(id, privEnc);
  const bal = await tokenBalance(id, token, w.address);
  if (bal.amount <= 0) throw new Error("wallet holds none of that token");
  const amount = (bal.raw * BigInt(Math.max(1, Math.min(100, Math.round(pct))))) / 100n;
  const q = await zeroXQuote(id, { sellToken: token, buyToken: NATIVE, sellAmount: amount.toString(), taker: w.address });
  const spender = q.issues?.allowance?.spender || q.allowanceTarget;
  if (spender) {
    const c = new ethers.Contract(token, ERC20, w);
    const cur = await c.allowance(w.address, spender);
    if (cur < amount) { const ap = await c.approve(spender, ethers.MaxUint256); await ap.wait(1, 90000); }
  }
  const before = await nativeBalance(id, w.address);
  const rec = await send(id, w, q.transaction);
  const after = await nativeBalance(id, w.address);
  return { hash: rec.hash, received: Math.max(0, after - before), sold: Number(ethers.formatUnits(amount, bal.decimals)) };
}

module.exports = { CHAINS, NATIVE, enabledChains, bySlug, newWallet, nativeBalance, tokenBalance, nativeUsd, tokenMeta, trending, buy, sell };
