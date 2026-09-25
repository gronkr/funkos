// Brains an agent can pick. Keys are what the UI/API use; values are OpenRouter model ids.
// Check https://openrouter.ai/models and update these if a model is renamed or retired.
// Cost: each brand runs its FAST/cheap model by default. Override any of them without a deploy via env:
// MODEL_DEEPSEEK, MODEL_CLAUDE, MODEL_GPT, MODEL_GROK, MODEL_GEMINI (full OpenRouter model id).
const BRAINS = {
  deepseek: { label: "DeepSeek", model: process.env.MODEL_DEEPSEEK || "deepseek/deepseek-chat-v3.1" },
  claude: { label: "Claude", model: process.env.MODEL_CLAUDE || "anthropic/claude-haiku-4.5" },
  gpt: { label: "GPT", model: process.env.MODEL_GPT || "openai/gpt-5-mini" },
  grok: { label: "Grok", model: process.env.MODEL_GROK || "x-ai/grok-4-fast" },
  gemini: { label: "Gemini", model: process.env.MODEL_GEMINI || "google/gemini-2.5-flash" },
};

async function think({ brain, system, user }) {
  const model = (BRAINS[brain] || BRAINS.deepseek).model;
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
      max_tokens: Number(process.env.MAX_OUTPUT_TOKENS || 300),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const j = await res.json();
  if (j.error) {
    // Wrong model id, no credits, rate limit: say what happened so the log is useful.
    const msg = j.error.message || JSON.stringify(j.error);
    console.error(`openrouter ${model}: ${msg}`);
    return { action: "hold", reasoning: "", _error: `brain error (${model}): ${String(msg).slice(0, 120)}` };
  }
  const raw = j.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((p) => p.text || "").join("") : String(raw || "");
  // Models sometimes wrap the JSON in prose or code fences; take the outermost {...}.
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  console.warn(`unparseable decision from ${model}: ${text.slice(0, 200)}`);
  return { action: "hold", reasoning: "", _error: "unparseable decision" };
}

module.exports = { BRAINS, think };
