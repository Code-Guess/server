'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,  
  process.env.OPENROUTER_KEY_3,
  process.env.OPENROUTER_KEY_4,
  process.env.OPENROUTER_KEY_5,
].filter(Boolean);
const OPENROUTER_MODELS = {
  opus:   'deepseek/deepseek-r1:free',      // raisonnement fort
  sonnet: 'meta-llama/llama-3.3-70b-instruct:free', // général/fallback
  haiku:  'meta-llama/llama-3.3-70b-instruct:free',
};

const VISION_FALLBACK = 'openrouter/free';

const MAX_TOKENS = {
  opus:   16_000,
  sonnet: 16_000,
  haiku:  4_096,
};

// ─── Round-robin state ────────────────────────────────────────────────────────
let keyIndex = 0;

function getNextKey() {
  const keys = KEYS;
  if (keys.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  const key = keys[keyIndex % keys.length];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

function getAvailableKeys() {
  if (KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  return KEYS;
}

// ─── Arith Prefill ────────────────────────────────────────────────────────────

const ARITH_TRIGGERS = [
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
  {
    regex:   /(?:addition|multiplica|opéra).{0,30}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-operation",',
  },
  {
    regex:   /table\s+(?:d.addition|de\s+multiplication).{0,20}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-op-table",',
  },
  {
    regex:   /pgcd|euclide|algorithme\s+d.euclide/i,
    prefill: '```arith-table\n{"kind":"euclid-algorithm",',
  },
  {
    regex:   /b[eé]zout/i,
    prefill: '```arith-table\n{"kind":"bezout-table",',
  },
  {
    regex:   /factori(?:ser?|sation)|décompos.{0,30}premier/i,
    prefill: '```arith-table\n{"kind":"prime-factorization",',
  },
  {
    regex:   /crible|[eé]ratosth[eè]ne/i,
    prefill: '```arith-table\n{"kind":"sieve-eratosthenes",',
  },
  {
    regex:   /diviseurs?\s+de\s+\d+/i,
    prefill: '```arith-table\n{"kind":"divisors-search",',
  },
  {
    regex:   /binaire|base\s*2/i,
    prefill: '```arith-table\n{"kind":"base-conversion",',
  },
];

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
  const tier      = options.model ?? 'opus';
  const maxTokens = options.max_tokens ?? MAX_TOKENS[tier] ?? 16_000;
  const useStream = options.stream !== false;

  const isMultimodal = hasMultimodalContent(options.messages ?? []);

  const model = isMultimodal
    ? VISION_FALLBACK
    : (OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus);

  let messages = isMultimodal
    ? convertToOpenAIFormat(options.messages ?? [])
    : (options.messages ?? []);

  const prefill = (isMultimodal || !useStream) ? null : getArithPrefill(messages);

  if (prefill) {
    messages = [...messages, { role: 'assistant', content: prefill }];
  }

  const keys = getAvailableKeys();
  let lastError = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = getNextKey();

    console.log(
      `[OpenRouter] model=${model} | prefill=${prefill ? 'oui' : 'non'} | multimodal=${isMultimodal} | stream=${useStream} | max_tokens=${maxTokens} | key=...${key.slice(-6)} | attempt=${attempt + 1}/${keys.length}`
    );

    let res;
    try {
      res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
          'HTTP-Referer':  'https://nerosia.app',
          'X-Title':       'Nerosia',
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens:  maxTokens,
          temperature: options.temperature ?? 0.7,
          stream:      useStream,
        }),
      });
    } catch (fetchErr) {
      console.warn(`[OpenRouter] Fetch réseau échoué (clé ...${key.slice(-6)}):`, fetchErr.message);
      lastError = fetchErr;
      continue;
    }

    // ── Gestion des erreurs HTTP ───────────────────────────────────────────
    if (!res.ok) {
      let errBody = {};
      try { errBody = await res.json(); } catch {}

      const errMsg  = errBody?.error?.message ?? `Erreur HTTP ${res.status}`;
      const isProviderError = errBody?.error?.code === 'provider_error'
        || errMsg.toLowerCase().includes('provider')
        || errMsg.toLowerCase().includes('overloaded')
        || errMsg.toLowerCase().includes('unavailable');

      console.warn(
        `[OpenRouter] HTTP ${res.status} (clé ...${key.slice(-6)}) | provider_error=${isProviderError} | msg: ${errMsg}`
      );

      // 429, 5xx, ou erreur provider → retry avec la clé suivante
      if (res.status === 429 || res.status >= 500 || isProviderError) {
        lastError = new Error(errMsg);
        continue;
      }

      // Autres 4xx (400 malformed, 401 auth…) → fail immédiat
      throw new Error(errMsg);
    }

    // ── Mode NON-stream ────────────────────────────────────────────────────
    if (!useStream) {
      const data = await res.json();
      const rawContent = data.choices?.[0]?.message?.content ?? '';
      return { content: rawContent, reasoning: '', modelUsed: model };
    }

    // ── Mode stream ────────────────────────────────────────────────────────
    if (!res.body) {
      throw new Error('[OpenRouter] res.body est null — stream impossible');
    }

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
          const parsed = JSON.parse(payload);

          // FIX : certains streams renvoient une erreur provider DANS le stream
          // (HTTP 200 mais body contient { error: ... })
          // On la détecte ici pour retry proprement.
          if (parsed?.error) {
            const streamErrMsg = parsed.error?.message ?? 'Provider error in stream';
            console.warn(`[OpenRouter] Erreur dans le stream (clé ...${key.slice(-6)}):`, streamErrMsg);
            lastError = new Error(streamErrMsg);
            // Fermer le reader et passer à la clé suivante
            try { await reader.cancel(); } catch {}
            break;
          }

          const { choices } = parsed;
          const delta = choices?.[0]?.delta;

          if (delta?.content) {
            content += delta.content;
            options.onChunk?.(delta.content);
          }
          if (delta?.reasoning) {
            reasoning += delta.reasoning;
            options.onReasoningChunk?.(delta.reasoning);
          }
        } catch {
          // chunk malformé → on ignore
        }
      }

      // Si on a détecté une erreur dans le stream, sortir du while
      if (lastError && content === '' && reasoning === '') break;
    }

    // Si erreur stream sans contenu → retry
    if (lastError && content === '' && reasoning === '') continue;

    // ── Recoller le prefill si besoin ──────────────────────────────────────
    const finalContent = prefill
      ? (content.startsWith(prefill) ? content : prefill + content)
      : content;

    return { content: finalContent, reasoning, modelUsed: model };
  }

  // Toutes les clés ont échoué
  throw lastError ?? new Error('[OpenRouter] Toutes les clés ont échoué.');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { openRouterFetch, OPENROUTER_MODELS, getAvailableKeys };
