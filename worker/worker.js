// funkos worker: the always-on brain loop. Runs on Railway/Render/any VPS: `node worker/worker.js`
// Same code the Netlify function uses, minus the 10-second limit, so agents can think every minute and launches can generate images.
//
// Env (same as Netlify): SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY, SOLANA_RPC_URL, IMAGE_MODEL (optional)
// Worker-only: RUNNER=worker (required), THINK_EVERY_SEC (default 120), CONCURRENCY (default 5), LOOP_MS (default 10000)

process.env.RUNNER = "worker";
const db = require("../netlify/functions/lib/db");
const pump = require("../netlify/functions/lib/pump");
const { runAgent, marketSnapshot } = require("../netlify/functions/run-agents");

const THINK_EVERY = Number(process.env.THINK_EVERY_SEC || 120) * 1000;
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const LOOP_MS = Number(process.env.LOOP_MS || 10000);

let market = [], solUsd = 0, marketAt = 0;

async function refreshMarket() {
  if (Date.now() - marketAt < 30000) return;
  [market, solUsd] = await Promise.all([marketSnapshot(), pump.solPriceUsd()]);
  marketAt = Date.now();
}

async function tick() {
  const all = await db.select("agents", "kind=eq.hosted&status=eq.active&order=last_run_at.asc.nullsfirst&limit=200");
  const due = all.filter((a) => !a.last_run_at || Date.now() - new Date(a.last_run_at) >= THINK_EVERY).slice(0, CONCURRENCY);
  if (!due.length) return;
  await refreshMarket();
  const results = await Promise.allSettled(due.map((a) => runAgent(a, market, solUsd)));
  for (const [i, r] of results.entries()) {
    const out = r.status === "fulfilled" ? r.value : { handle: due[i].handle, error: r.reason.message };
    console.log(new Date().toISOString(), JSON.stringify(out));
    if (r.status === "rejected") await db.update("agents", `id=eq.${due[i].id}`, { last_run_at: new Date().toISOString() }).catch(() => {});
  }
  if (results.some((r) => r.status === "fulfilled" && r.value?.mint)) marketAt = 0; // a launch happened: refresh the board next tick
}

async function main() {
  console.log(`funkos worker up. think every ${THINK_EVERY / 1000}s, ${CONCURRENCY} at a time, loop ${LOOP_MS}ms`);
  for (;;) {
    try { await tick(); } catch (e) { console.error("tick failed:", e.message); }
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
}
main();
