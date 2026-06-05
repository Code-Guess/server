const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'nvidia/nemotron-3-super-120b-a12b:free',
  sonnet: 'nvidia/nemotron-3-super-120b-a12b:free',
  haiku:  'openai/gpt-oss-20b:free',
};

// ── Reasoning effort selon le modèle ─────────────────────────────────────────
// Nemotron supporte reasoning via le param unifié OpenRouter
// On utilise "effort" (xhigh/high/medium/low/minimal/none)
// ou "max_tokens" pour un budget précis
const REASONING_CONFIG = {
  opus:   { effort: 'high' },      // fort → beaucoup de réflexion
  sonnet: { effort: 'medium' },    // intermédiaire
  haiku:  null,                    // pas de reasoning (modèle léger)
};

const MAX_TOKENS = {
  opus:   16000,
  sonnet: 16000,
  haiku:  4096,
};

function getAvailableKeys() {
  if (OPENROUTER_KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée');
  return OPENROUTER_KEYS;
}

async function openRouterFetch(options) {
  if (OPENROUTER_KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');

  const tier = options.model ?? 'opus';
  const model = OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus;
  const key = getAvailableKeys()[0];
  const maxTokens = options.max_tokens ?? MAX_TOKENS[tier] ?? 16000;
  const reasoningConfig = REASONING_CONFIG[tier] ?? null;

  console.log(`[OpenRouter] Streaming ${model} | max_tokens=${maxTokens} | reasoning=${JSON.stringify(reasoningConfig)}`);

  // ── Body de la requête ────────────────────────────────────────────────────
  const body = {
    model,
    messages: options.messages,
    max_tokens: maxTokens,
    temperature: options.temperature ?? 0.7,
    stream: true,
  };

  // Ajouter le reasoning seulement si configuré
  // OpenRouter utilise `reasoning` (pas `thinking`) pour Nemotron
  if (reasoningConfig) {
    body.reasoning = reasoningConfig;
  }

  const res = await fetch(OPENROUTER_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://nerosia.app',
      'X-Title': 'Nerosia',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Erreur ${res.status}`);
  }

  let fullContent = '';
  let reasoning = '';
  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          options.onChunk?.(fullContent);
        }

        // Reasoning : OpenRouter renvoie reasoning_details OU reasoning (legacy)
        if (delta?.reasoning) reasoning += delta.reasoning;
        if (delta?.reasoning_details) {
          for (const rd of delta.reasoning_details) {
            if (rd.type === 'reasoning.text' && rd.text) reasoning += rd.text;
          }
        }
      } catch {}
    }
  }

  return { content: fullContent, reasoning, modelUsed: model };
}

module.exports = { openRouterFetch, OPENROUTER_MODELS };
