let cache = { at: 0, items: [] };

async function googleTrends() {
  try {
    const res = await fetch('https://trends.google.com/trending/rss?geo=US');
    const xml = await res.text();
    return [...xml.matchAll(/<item>\s*<title>([^<]+)<\/title>/g)].map((m) => m[1]).slice(0, 20);
  } catch { return []; }
}

async function reddit() {
  try {
    const res = await fetch('https://www.reddit.com/r/all/hot.json?limit=30', {
      headers: { 'User-Agent': 'swarm-colony/1.0' },
    });
    const json = await res.json();
    return json.data.children.map((c) => c.data.title).slice(0, 25);
  } catch { return []; }
}

async function dexTrending() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const json = await res.json();
    return json.filter((t) => t.chainId === 'solana').slice(0, 15)
      .map((t) => t.description || t.url).filter(Boolean);
  } catch { return []; }
}

// Returns a list of short strings describing what the internet is talking about right now.
export async function getTrends() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.items.length) return cache.items;
  const [g, r, d] = await Promise.all([googleTrends(), reddit(), dexTrending()]);
  const items = [
    ...g.map((t) => `search trend: ${t}`),
    ...r.map((t) => `reddit: ${t}`),
    ...d.map((t) => `solana trending coin: ${t.slice(0, 120)}`),
  ];
  cache = { at: Date.now(), items };
  return items;
}
