const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'openrouter/owl-alpha',
  sonnet: 'openrouter/owl-alpha',
  haiku:  'openai/gpt-oss-20b:free',
};

// ── Budget thinking selon le modèle ──────────────────────────────────────────
// budget_tokens DOIT être < max_tokens
const THINKING_BUDGET = {
  opus:   10000,
  sonnet: 8000,
  haiku:  0,      // modèle léger → pas de thinking
};

const MAX_TOKENS = {
  opus:   16000,
  sonnet: 16000,
  haiku:  4096,
};

// ── Modèles qui ne supportent PAS role:"system" ───────────────────────────────
// owl-alpha avec thinking activé exige temperature=1 et ne supporte pas system.
// On convertit le premier message system en user pour ces modèles.
const MODELS_WITHOUT_SYSTEM_ROLE = new Set([
  'openrouter/owl-alpha',
]);

function getAvailableKeys() {
  if (OPENROUTER_KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée');
  return OPENROUTER_KEYS;
}

// ── Prépare les messages selon les contraintes du modèle ──────────────────────
// Si le modèle ne supporte pas role:"system", on injecte le contenu du system
// prompt comme premier message user avec un préfixe clair.
function prepareMessages(messages, model) {
  if (!MODELS_WITHOUT_SYSTEM_ROLE.has(model)) {
    return messages;
  }

  const result = [];
  let systemInjected = false;

  for (const msg of messages) {
    if (msg.role === 'system' && !systemInjected) {
      // Injecte le system prompt comme message user initial
      result.push({
        role: 'user',
        content: `[Instructions système — tu dois les suivre à la lettre pour toute la conversation]\n\n${msg.content}`,
      });
      // Ajoute une réponse assistant fictive pour simuler l'acquittement
      result.push({
        role: 'assistant',
        content: 'Compris. Je vais suivre ces instructions à la lettre.',
      });
      systemInjected = true;
    } else {
      result.push(msg);
    }
  }

  return result;
}

async function openRouterFetch(options) {
  if (OPENROUTER_KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');

  const tier   = options.model ?? 'opus';
  const model  = OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus;
  const key    = getAvailableKeys()[0];

  const maxTokens      = options.max_tokens ?? MAX_TOKENS[tier] ?? 16000;
  const thinkingBudget = THINKING_BUDGET[tier] ?? 0;

  // ── CORRECTION CRITIQUE ───────────────────────────────────────────────────
  // owl-alpha avec thinking activé EXIGE temperature=1.
  // Toute autre valeur → le modèle ignore le system prompt ou retourne une
  // erreur silencieuse. On force donc temp=1 quand thinking est actif.
  const temperature = thinkingBudget > 0 ? 1 : (options.temperature ?? 0.7);

  // Prépare les messages (convertit system→user pour owl-alpha)
  const messages = prepareMessages(options.messages, model);

  console.log(`[OpenRouter] Streaming ${model} | max_tokens=${maxTokens} | thinking_budget=${thinkingBudget} | temperature=${temperature} | messages=${messages.length}`);

  // ── Body de la requête ────────────────────────────────────────────────────
  const body = {
    model,
    messages,
    max_tokens:  maxTokens,
    temperature,
    stream:      true,
  };

  // Ajouter le thinking seulement si budget > 0
  if (thinkingBudget > 0) {
    body.thinking = {
      type:          'enabled',
      budget_tokens: thinkingBudget,
    };
  }

  const res = await fetch(OPENROUTER_BASE_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://nerosia.app',
      'X-Title':      'Nerosia',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Erreur ${res.status}`);
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
        if (delta?.content)   { fullContent += delta.content;   options.onChunk?.(fullContent); }
        if (delta?.reasoning) { reasoning   += delta.reasoning; }
      } catch {}
    }
  }

  return { content: fullContent, reasoning, modelUsed: model };
}

module.exports = { openRouterFetch, OPENROUTER_MODELS };
