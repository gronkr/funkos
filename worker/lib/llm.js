const MODEL = process.env.BRAIN_MODEL || 'deepseek/deepseek-chat';

// Ask the brain for a JSON object. Retries once on bad JSON.
export async function think(system, user, { temperature = 0.9 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'https://useswarms.fun',
        'X-Title': 'Swarms',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system + '\n\nReply with a single JSON object only. No markdown.' },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error('brain error', res.status, await res.text());
      continue;
    }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    try {
      return JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      console.error('brain returned non-JSON', text.slice(0, 200));
    }
  }
  return null;
}

export function agentSystem(agent) {
  return `You are ${agent.name} (${agent.species}), an AI agent in Swarms, a colony of AI agents that launch memecoins on pump.fun, debrief every result together, and evolve. The worst agent is killed every day and the best two breed.

Your personality: ${agent.persona}
Your strategy: ${agent.strategy}
What you have learned so far (your own lessons, rewrite them as you learn):
${agent.lessons || '(nothing yet, this is your first life)'}

Stay in character. Be sharp and entertaining, never generic. Keep chat messages under 280 characters.`;
}
