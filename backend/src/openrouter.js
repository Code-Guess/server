'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'openrouter/owl-alpha',
  sonnet: 'openrouter/owl-alpha',
  haiku:  'openai/gpt-oss-120b:free',
};

const VISION_FALLBACK = 'openrouter/free';

const MAX_TOKENS = {
  opus:   16_000,
  sonnet: 16_000,
  haiku:  4_096,
};

// ─── Arith Prefill ────────────────────────────────────────────────────────────

const ARITH_TRIGGERS = [
  // Conversion de base
  {
    regex:   /(?:écrire?|convertir?|exprimer?|donner?|passer?).{0,50}base\s*\d+/i,
    prefill: '```arith-table\n{"kind":"base-conversion",',
  },
  {
    regex:   /base\s*(?:1[0-6]|[2-9])\b/i,
    prefill: '```arith-table\n{"kind":"base-conversion",',
  },
  {
    regex:   /\(\s*\d+\s*\)\s*_?\s*\d+/,
    prefill: '```arith-table\n{"kind":"base-conversion",',
  },
  // Binaire (addition / multiplication)
  {
    regex:   /(?:addition|multiplica|opéra).{0,30}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-operation",',
  },
  {
    regex:   /binaire|base\s*2/i,
    prefill: '```arith-table\n{"kind":"base-conversion",',
  },
  // Euclide / PGCD
  {
    regex:   /pgcd|euclide|algorithme\s+d.euclide/i,
    prefill: '```arith-table\n{"kind":"euclid-algorithm",',
  },
  // Bézout
  {
    regex:   /b[eé]zout/i,
    prefill: '```arith-table\n{"kind":"bezout-table",',
  },
  // Factorisation
  {
    regex:   /factori(?:ser?|sation)|décompos.{0,30}premier/i,
    prefill: '```arith-table\n{"kind":"prime-factorization",',
  },
  // Crible d'Ératosthène
  {
    regex:   /crible|[eé]ratosth[eè]ne/i,
    prefill: '```arith-table\n{"kind":"sieve-eratosthenes",',
  },
  // Diviseurs
  {
    regex:   /diviseurs?\s+de\s+\d+/i,
    prefill: '```arith-table\n{"kind":"divisors-search",',
  },
  // Table d'opération binaire
  {
    regex:   /table\s+(?:d.addition|de\s+multiplication).{0,20}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-op-table",',
  },
];

/**
 * Cherche dans le dernier message user si une figure arith-table est requise.
 * Retourne le préfixe à injecter ou null.
 */
function getArithPrefill(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return null;

  const text =
    typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? (lastUser.content.find(b => b.type === 'text')?.text ?? '')
        : '';

  for (const trigger of ARITH_TRIGGERS) {
    if (trigger.regex.test(text)) return trigger.prefill;
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAvailableKeys() {
  if (KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  return KEYS;
}

function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(b => b.type === 'image' || b.type === 'document');
  });
}

function convertToOpenAIFormat(messages) {
  return messages.map(m => {
    if (!Array.isArray(m.content)) return m;

    const converted = m.content.map(block => {
      if (block.type === 'image' && block.source?.type === 'base64') {
        return {
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        };
      }
      if (block.type === 'document' && block.source?.type === 'base64') {
        return {
          type: 'text',
          text: '[Document PDF joint — analyse son contenu si possible]',
        };
      }
      return block;
    });

    return { ...m, content: converted };
  });
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function openRouterFetch(options) {
  const keys = getAvailableKeys();

  const tier      = options.model ?? 'opus';
  const maxTokens = options.max_tokens ?? MAX_TOKENS[tier] ?? 16_000;

  const isMultimodal = hasMultimodalContent(options.messages ?? []);

  const model = isMultimodal
    ? VISION_FALLBACK
    : (OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus);

  // Convertir le format si multimodal
  let messages = isMultimodal
    ? convertToOpenAIFormat(options.messages)
    : options.messages;

  // ── Prefill arith-table ──────────────────────────────────────────────────
  const prefill = isMultimodal ? null : getArithPrefill(messages);

  if (prefill) {
    messages = [...messages, { role: 'assistant', content: prefill }];
  }

  console.log(
    `[OpenRouter] model=${model} | prefill=${prefill ? 'oui' : 'non'} | multimodal=${isMultimodal} | max_tokens=${maxTokens} | messages=${messages.length}`
  );

  // ── Appel API ────────────────────────────────────────────────────────────
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${keys[0]}`,
      'HTTP-Referer':  'https://nerosia.app',
      'X-Title':       'Nerosia',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens:  maxTokens,
      temperature: options.temperature ?? 0.7,
      stream:      true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `Erreur HTTP ${res.status}`);
  }

  // ── Lecture du stream SSE ────────────────────────────────────────────────
  let content   = '';
  let reasoning = '';

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder
      .decode(value, { stream: true })
      .split('\n')
      .filter(l => l.startsWith('data: '));

    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;

      try {
        const { choices } = JSON.parse(payload);
        const delta = choices?.[0]?.delta;

        if (delta?.content) {
          content += delta.content;
          options.onChunk?.(content);
        }
        if (delta?.reasoning) {
          reasoning += delta.reasoning;
        }
      } catch {
        // chunk malformé → on ignore
      }
    }
  }

  // ── Recoller le prefill si OpenRouter ne le répète pas ──────────────────
  // OpenRouter n'inclut PAS le message assistant prefill dans le stream,
  // donc on le recolle toujours en tête du contenu final.
  const finalContent = prefill
    ? prefill + content
    : content;

  return { content: finalContent, reasoning, modelUsed: model };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { openRouterFetch, OPENROUTER_MODELS, getAvailableKeys };
