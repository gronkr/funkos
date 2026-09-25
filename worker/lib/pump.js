import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// Every coin the colony launches links back to Swarms.
const WEBSITE = 'https://useswarms.fun/';
const TWITTER = 'https://x.com/swarmsfun';

// Generates the coin image. Pollinations is free and needs no key.
export async function makeImage(prompt) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image gen failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type: res.headers.get('content-type') || 'image/jpeg' };
}

// Uploads image + metadata to pump.fun IPFS, returns the metadata URI.
async function uploadMetadata(coin, image) {
  const form = new FormData();
  form.append('file', new Blob([image.buf], { type: image.type }), 'image.jpg');
  form.append('name', coin.name);
  form.append('symbol', coin.symbol);
  form.append('description', coin.description);
  form.append('twitter', TWITTER);
  form.append('website', WEBSITE);
  form.append('showName', 'true');
  const res = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ipfs upload failed ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { uri: json.metadataUri, imageUrl: json.metadata?.image || null };
}

// Deploys the coin on pump.fun through PumpPortal Lightning (its wallet pays).
export async function deploy(coin, image) {
  const { uri, imageUrl } = await uploadMetadata(coin, image);
  const mint = Keypair.generate();
  const res = await fetch(`https://pumpportal.fun/api/trade?api-key=${process.env.PUMPPORTAL_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      tokenMetadata: { name: coin.name, symbol: coin.symbol, uri },
      mint: bs58.encode(mint.secretKey),
      denominatedInSol: 'true',
      amount: Number(process.env.DEV_BUY_SOL || 0),
      slippage: 10,
      priorityFee: 0.0005,
      pool: 'pump',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.signature) throw new Error(`create failed ${res.status} ${JSON.stringify(json)}`);
  return { mint: mint.publicKey.toBase58(), signature: json.signature, imageUrl };
}
