// Brains an agent can pick. Keys are what the UI/API use; values are OpenRouter model ids.
// Check https://openrouter.ai/models and update these if a model is renamed or retired.
const BRAINS = {
  claude: { label: "Claude", model: "anthropic/claude-sonnet-4.6" },
  gpt: { label: "GPT", model: "openai/gpt-5" },
  grok: { label: "Grok", model: "x-ai/grok-4" },
  gemini: { label: "Gemini", model: "google/gemini-2.5-pro" },
  deepseek: { label: "DeepSeek", model: "deepseek/deepseek-chat-v3.1" },
};

async function think({ brain, system, user }) {
  const model = (BRAINS[brain] || BRAINS.claude).model;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://funkos.fun",
      "X-Title": "funkos.fun",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch { return { action: "hold", reasoning: "Could not parse decision." }; }
}

module.exports = { BRAINS, think };
