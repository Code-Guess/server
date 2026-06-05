const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'nvidia/nemotron-3-ultra-550b-a55b:free',
  sonnet: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  haiku:  'nvidia/nemotron-3-ultra-550b-a55b:free',
};

// ── Budget thinking selon le modèle ────────────────────────────────────────
// budget_tokens DOIT être < max_tokens
const THINKING_BUDGET = {
  opus:   10000,  // modèle fort → plus de réflexion
  sonnet: 8000,
  haiku:  0,      // modèle léger → pas de thinking (trop lent/inutile)
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
  const thinkingBudget = THINKING_BUDGET[tier] ?? 0;

  console.log(`[OpenRouter] Streaming ${model} | max_tokens=${maxTokens} | thinking_budget=${thinkingBudget}`);

  // ── Body de la requête ────────────────────────────────────────────────────
  const body = {
    model,
    messages: options.messages,
    max_tokens: maxTokens,
    temperature: options.temperature ?? 0.7,
    stream: true,
  };

  // Ajouter le thinking seulement si budget > 0
  if (thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    };
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
        if (delta?.reasoning) reasoning += delta.reasoning;
      } catch {}
    }
  }

  return { content: fullContent, reasoning, modelUsed: model };
}

module.exports = { openRouterFetch, OPENROUTER_MODELS };
