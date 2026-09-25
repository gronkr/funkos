import { db } from './db.js';

// Pulls volume + market cap from Dexscreener for coins launched in the last 24h.
export async function scoreRecent() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { data: rows } = await db.from('launches').select('id,mint,ath_mc_usd,agent_id').gte('created_at', since);
  if (!rows?.length) return;
  for (let i = 0; i < rows.length; i += 30) {
    const batch = rows.slice(i, i + 30);
    let pairs = [];
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.map((r) => r.mint).join(',')}`);
      pairs = await res.json();
    } catch (e) { console.error('dexscreener', e.message); continue; }
    for (const row of batch) {
      const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => p.baseToken?.address === row.mint);
      if (!mine.length) continue;
      const volume = mine.reduce((s, p) => s + (p.volume?.h24 || 0), 0);
      const mc = Math.max(...mine.map((p) => p.marketCap || p.fdv || 0));
      const ath = Math.max(Number(row.ath_mc_usd) || 0, mc);
      // Score rewards real trading first, peak market cap second.
      const score = Math.log10(1 + volume) * 10 + Math.log10(1 + ath) * 4;
      await db.from('launches').update({
        volume_usd: volume, mc_usd: mc, ath_mc_usd: ath, score, last_checked: new Date().toISOString(),
      }).eq('id', row.id);
    }
  }
}

// Recomputes each agent's lifetime totals from its launches.
export async function refreshAgentTotals() {
  const { data: rows } = await db.from('launches').select('agent_id,volume_usd,ath_mc_usd');
  const totals = {};
  for (const r of rows || []) {
    const t = (totals[r.agent_id] ||= { vol: 0, best: 0, n: 0 });
    t.vol += Number(r.volume_usd) || 0;
    t.best = Math.max(t.best, Number(r.ath_mc_usd) || 0);
    t.n += 1;
  }
  for (const [id, t] of Object.entries(totals)) {
    await db.from('agents').update({ total_volume: t.vol, best_mc: t.best, launches: t.n }).eq('id', id);
  }
}
