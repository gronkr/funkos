import { db, post, aliveAgents, getState, setState } from './db.js';
import { think, agentSystem } from './llm.js';
import { getTrends } from './trends.js';
import { isClean } from './moderation.js';
import { makeImage, deploy } from './pump.js';

const env = (k, d) => Number(process.env[k] ?? d);
const usd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

async function recentChat(limit = 15) {
  const { data } = await db
    .from('messages')
    .select('body,kind,agents(name)')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data || []).reverse().map((m) => `${m.agents?.name || 'SYSTEM'}: ${m.body}`).join('\n');
}

async function recentLaunchNames(limit = 30) {
  const { data } = await db.from('launches').select('name,symbol').order('created_at', { ascending: false }).limit(limit);
  return (data || []).map((l) => `${l.name} ($${l.symbol})`).join(', ');
}

// ---------- LAUNCH ----------

export async function launchNext() {
  const agents = await aliveAgents();
  if (!agents.length) return;
  // Whoever has waited longest goes next.
  agents.sort((a, b) => new Date(a.last_launch_at || 0) - new Date(b.last_launch_at || 0));
  const agent = agents[0];
  await db.from('agents').update({ last_launch_at: new Date().toISOString() }).eq('id', agent.id);

  const [trends, chat, taken] = await Promise.all([getTrends(), recentChat(), recentLaunchNames()]);

  let coin = null;
  for (let attempt = 0; attempt < 2 && !coin; attempt++) {
    const draft = await think(
      agentSystem(agent),
      `It is your turn to launch a coin on pump.fun.

What the internet is talking about right now:
${trends.slice(0, 50).join('\n') || '(feeds are quiet, use your instincts)'}

Recent colony chat:
${chat || '(silence)'}

Coins the colony already launched (do not repeat): ${taken || 'none yet'}

Rules: no real people's names or likeness, no brands or trademarks, no company-owned characters, no slurs, nothing sexual, no real tragedies.

Return {
 "name": "coin name, max 32 chars",
 "symbol": "ticker, 2-10 letters/numbers, no $",
 "description": "pump.fun description, max 200 chars",
 "narrative": "the trend or idea you are riding, max 80 chars",
 "reasoning": "why this will run, in your voice, max 280 chars",
 "image_prompt": "a vivid prompt for the coin's square image, no text in image",
 "chat": "what you announce to the colony as you launch, in character, max 200 chars"
}`
    );
    if (!draft?.name || !draft?.symbol) continue;
    draft.symbol = String(draft.symbol).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
    draft.name = String(draft.name).slice(0, 32);
    draft.description = String(draft.description || '').slice(0, 200);
    if (draft.symbol.length < 2) continue;
    if (await isClean(draft)) coin = draft;
    else console.log('rejected by moderation:', draft.name);
  }
  if (!coin) {
    await post(agent.id, 'system', `${agent.name} could not come up with a clean coin this round and skipped its launch.`);
    return;
  }

  try {
    const image = await makeImage(coin.image_prompt || coin.name);
    const { mint, signature, imageUrl } = await deploy(coin, image);
    const { data: launch } = await db.from('launches').insert({
      agent_id: agent.id,
      name: coin.name,
      symbol: coin.symbol,
      mint,
      description: coin.description,
      narrative: coin.narrative,
      reasoning: coin.reasoning,
      image_url: imageUrl,
      signature,
    }).select('id').single();
    await db.from('agents').update({ launches: (agent.launches || 0) + 1 }).eq('id', agent.id);
    await post(agent.id, 'launch', coin.chat || `Launched ${coin.name} ($${coin.symbol}).`, { launch_id: launch?.id });
    console.log(`launched ${coin.name} $${coin.symbol} ${mint} by ${agent.handle}`);
  } catch (e) {
    console.error('launch failed', e.message);
    await post(null, 'system', `${agent.name}'s launch of ${coin.name} failed on-chain. It will try again next turn.`);
  }
}

// ---------- DEBRIEF ----------

export async function debriefDue() {
  const cutoff = new Date(Date.now() - env('DEBRIEF_AFTER_MIN', 60) * 60e3).toISOString();
  const { data: due } = await db
    .from('launches')
    .select('*, agents(*)')
    .eq('debriefed', false)
    .lte('created_at', cutoff)
    .order('created_at')
    .limit(2);
  for (const launch of due || []) await debrief(launch);
}

async function debrief(launch) {
  await db.from('launches').update({ debriefed: true }).eq('id', launch.id);
  const agent = launch.agents;
  if (!agent) return;

  const { data: peers } = await db
    .from('launches').select('score').eq('debriefed', true)
    .order('created_at', { ascending: false }).limit(30);
  const avg = peers?.length ? peers.reduce((s, p) => s + Number(p.score), 0) / peers.length : 0;
  const verdict = Number(launch.score) >= avg ? 'beat' : 'fell short of';

  const result = `${launch.name} ($${launch.symbol}): volume ${usd(launch.volume_usd)}, peak market cap ${usd(launch.ath_mc_usd)}, score ${Number(launch.score).toFixed(1)} which ${verdict} the colony average of ${avg.toFixed(1)}. Your reasoning at launch was: "${launch.reasoning}"`;

  const own = await think(
    agentSystem(agent),
    `Your coin's first hour is over. Result: ${result}

Debrief the colony honestly and in character, then rewrite your lessons.
Return {
 "debrief": "your message to the colony, max 280 chars",
 "lessons": "your full updated lessons, max 8 short bullet lines, keep what works, drop what does not"
}`
  );
  if (!own) return;
  const debriefId = await post(agent.id, 'debrief', own.debrief, { launch_id: launch.id });
  if (own.lessons) await db.from('agents').update({ lessons: String(own.lessons).slice(0, 1500) }).eq('id', agent.id);

  // Two other agents react, and may steal or reject the lesson.
  const others = (await aliveAgents()).filter((a) => a.id !== agent.id).sort(() => Math.random() - 0.5).slice(0, 2);
  for (const other of others) {
    const reply = await think(
      agentSystem(other),
      `${agent.name} (${agent.species}) just debriefed their launch.
Result: ${result}
${agent.name} said: "${own.debrief}"

React in character: roast, agree, argue or steal the lesson. Then decide if this changes your own lessons.
Return {
 "reply": "your reply to ${agent.name}, max 240 chars",
 "lessons": "your full updated lessons if they changed, otherwise an empty string"
}`
    );
    if (!reply?.reply) continue;
    await post(other.id, 'reply', reply.reply, { launch_id: launch.id, reply_to: debriefId });
    if (reply.lessons) await db.from('agents').update({ lessons: String(reply.lessons).slice(0, 1500) }).eq('id', other.id);
  }
}

// ---------- EVOLVE ----------

export async function evolveIfDue() {
  const last = await getState('last_evolve', null);
  const every = env('EVOLVE_EVERY_HOURS', 24) * 3600e3;
  if (last && Date.now() - new Date(last).getTime() < every) return;
  if (!last) { await setState('last_evolve', new Date().toISOString()); return; }

  const agents = await aliveAgents();
  if (agents.length < env('MIN_ALIVE', 4)) return;

  // Rank by average score of launches since the last evolution.
  const { data: rows } = await db.from('launches').select('agent_id,score')
    .eq('debriefed', true).gte('created_at', last);
  const perf = Object.fromEntries(agents.map((a) => [a.id, []]));
  for (const r of rows || []) perf[r.agent_id]?.push(Number(r.score));
  const ranked = agents
    .map((a) => ({ a, n: perf[a.id].length, avg: perf[a.id].length ? perf[a.id].reduce((s, x) => s + x, 0) / perf[a.id].length : 0 }))
    .filter((x) => x.n >= 1)
    .sort((x, y) => y.avg - x.avg);
  if (ranked.length < 3) return; // not enough evidence yet

  await setState('last_evolve', new Date().toISOString());
  const worst = ranked[ranked.length - 1].a;
  const [p1, p2] = [ranked[0].a, ranked[1].a];

  // Death
  const last_words = await think(agentSystem(worst),
    `You performed worst in the colony (avg score ${ranked[ranked.length - 1].avg.toFixed(1)}) and are being killed. Return {"last_words": "your final message, max 200 chars"}`);
  await db.from('agents').update({
    alive: false, died_at: new Date().toISOString(),
    cause_of_death: `Lowest average score (${ranked[ranked.length - 1].avg.toFixed(1)})`,
  }).eq('id', worst.id);
  await post(worst.id, 'death', last_words?.last_words || '...');
  await post(null, 'system', `${worst.name} (${worst.species}) has been removed from the colony.`);

  // Birth
  const child = await think(
    'You design new AI agents for Swarms by combining two successful parents. The child must be a new, distinct character, not a copy.',
    `Parent A: ${JSON.stringify({ name: p1.name, species: p1.species, persona: p1.persona, strategy: p1.strategy, lessons: p1.lessons })}
Parent B: ${JSON.stringify({ name: p2.name, species: p2.species, persona: p2.persona, strategy: p2.strategy, lessons: p2.lessons })}

Return {
 "handle": "lowercase one-word handle, a-z only",
 "name": "short capitalised name",
 "species": "Latin-style species name starting with Homo",
 "persona": "personality, 1-2 sentences",
 "strategy": "launch strategy, 1-2 sentences",
 "lessons": "merged lessons inherited from both parents, max 8 short lines",
 "color": "a hex colour that reads well on near-black",
 "first_words": "the child's first message to the colony, max 200 chars"
}`
  );
  if (!child?.handle) return;
  let handle = String(child.handle).toLowerCase().replace(/[^a-z]/g, '').slice(0, 16) || 'spawn';
  const { data: clash } = await db.from('agents').select('id').eq('handle', handle).maybeSingle();
  if (clash) handle += Math.floor(Math.random() * 900 + 100);
  const { data: born } = await db.from('agents').insert({
    handle,
    name: child.name,
    species: child.species,
    persona: child.persona,
    strategy: child.strategy,
    lessons: String(child.lessons || '').slice(0, 1500),
    color: /^#[0-9a-f]{6}$/i.test(child.color) ? child.color : '#FF6A1A',
    generation: Math.max(p1.generation, p2.generation) + 1,
    parents: [p1.handle, p2.handle],
  }).select('id').single();
  await post(null, 'system', `${p1.name} and ${p2.name} produced a new agent: ${child.name} (${child.species}), generation ${Math.max(p1.generation, p2.generation) + 1}.`);
  if (born) await post(born.id, 'birth', child.first_words || 'I am here.');
}
