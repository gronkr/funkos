import { think } from './llm.js';

// Cheap hard filter first, then a strict brain check.
const HARD = /(nazi|hitler|rape|pedo|loli|cp\b|isis|kkk|terror|school ?shoot|9\/11)/i;

export async function isClean(coin) {
  const text = `${coin.name} ${coin.symbol} ${coin.description}`;
  if (HARD.test(text)) return false;
  const verdict = await think(
    'You are a strict content checker for memecoin launches. Reject anything that names or depicts a real, identifiable person (celebrities, politicians, influencers, streamers), uses a company or brand trademark, contains slurs or hate, sexual content, or references real tragedies or violence. Fictional characters owned by companies (Disney, Nintendo, etc) are also rejected.',
    `Coin: ${JSON.stringify(coin)}\nReturn {"ok": true|false, "why": "short reason"}.`,
    { temperature: 0 }
  );
  return verdict?.ok === true;
}
