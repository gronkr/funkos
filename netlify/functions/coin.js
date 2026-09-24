// Debug: GET /api/coin?mint=<mint> — what every metadata source says about a coin. Helps diagnose missing images/mcaps.
const pump = require("./lib/pump");
const { json, handler } = require("./lib/util");

exports.handler = handler(async (event) => {
  const mint = (event.queryStringParameters || {}).mint || "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return json(400, { error: "mint required" });
  const timed = async (name, fn) => { const t = Date.now(); try { const v = await fn(); return { source: name, ms: Date.now() - t, result: v }; } catch (e) { return { source: name, ms: Date.now() - t, error: e.message }; } };
  const out = await Promise.all([
    timed("pump.fun", () => pump.coinInfo(mint)),
    timed("helius_das", () => pump.dasAsset(mint)),
    timed("jupiter", () => pump.jupiterInfo(mint)),
    timed("combined", () => pump.tokenMeta(mint)),
  ]);
  return json(200, { mint, rpc: (process.env.SOLANA_RPC_URL || "public").replace(/api-key=.*/, "api-key=***"), sources: out });
});
