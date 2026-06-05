const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'openrouter/owl-alpha',
  sonnet: 'openrouter/owl-alpha',
  haiku:  'openrouter/owl-alpha',
};

const MODEL_FALLBACK_CHAIN = [
  'openrouter/owl-alpha',
  'qwen/qwen3-coder-480b-a35b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

const THINKING_BUDGET = {
  opus:   10000,
  sonnet: 8000,
  haiku:  0,
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

async function tryModel(model, key, options) {
  const tier = options.model ?? 'opus';
  const maxTokens      = options.max_tokens ?? MAX_TOKENS[tier] ?? 16000;
  const thinkingBudget = THINKING_BUDGET[tier] ?? 0;

  console.log(`[OpenRouter] Essai ${model} | max_tokens=${maxTokens} | thinking_budget=${thinkingBudget}`);

  const body = {
    model,
    messages:    options.messages,
    max_tokens:  maxTokens,
    temperature: options.temperature ?? 0.7,
    stream:      true,
  };

  if (thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  let res;
  try {
    res = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer':  'https://nerosia.app',
        'X-Title':       'Nerosia',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`[OpenRouter] Réseau ${model} : ${err?.message}`);
    return null;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn(`[OpenRouter] ${model} KO : ${err?.error?.message ?? res.status}`);
    return null;
  }

  let fullContent = '';
  let reasoning   = '';
  const decoder = new TextDecoder();
  const reader  = res.body.getReader();

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
        const delta  = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          options.onChunk?.(fullContent);
        }
        if (delta?.reasoning) reasoning += delta.reasoning;
      } catch {}
    }
  }

  if (!fullContent.trim()) return null;
  console.log(`[OpenRouter] Succès ${model} (${fullContent.length} chars)`);
  return { content: fullContent, reasoning, modelUsed: model };
}

async function openRouterFetch(options) {
  if (OPENROUTER_KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  const key = getAvailableKeys()[0];
  for (const model of MODEL_FALLBACK_CHAIN) {
    const result = await tryModel(model, key, options);
    if (result) return result;
  }
  throw new Error('Tous les modèles sont indisponibles. Réessaie dans quelques secondes.');
}

module.exports = { openRouterFetch, OPENROUTER_MODELS };
