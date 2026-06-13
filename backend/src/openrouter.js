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

// ─── Round-robin state ────────────────────────────────────────────────────────
// Index courant partagé entre les appels pour distribuer les requêtes
let keyIndex = 0;

function getNextKey() {
  const keys = KEYS;
  if (keys.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  const key = keys[keyIndex % keys.length];
  keyIndex = (keyIndex + 1) % keys.length;
  return key;
}

// Gardé pour compatibilité avec les exports existants
function getAvailableKeys() {
  if (KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  return KEYS;
}

// ─── Arith Prefill ────────────────────────────────────────────────────────────

const ARITH_TRIGGERS = [
  // Conversion de base — patterns spécifiques EN PREMIER
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
  // Binaire (addition / multiplication) — avant le catch-all binaire
  {
    regex:   /(?:addition|multiplica|opéra).{0,30}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-operation",',
  },
  // Table d'opération binaire — avant le catch-all binaire
  {
    regex:   /table\s+(?:d.addition|de\s+multiplication).{0,20}(?:binaire|base\s*2)/i,
    prefill: '```arith-table\n{"kind":"binary-op-table",',
  },
  // Euclide / PGCD — avant le catch-all binaire
  {
    regex:   /pgcd|euclide|algorithme\s+d.euclide/i,
    prefill: '```arith-table\n{"kind":"euclid-algorithm",',
  },
  // Bézout — avant le catch-all binaire
  {
    regex:   /b[eé]zout/i,
    prefill: '```arith-table\n{"kind":"bezout-table",',
  },
  // Factorisation — avant le catch-all binaire
  {
    regex:   /factori(?:ser?|sation)|décompos.{0,30}premier/i,
    prefill: '```arith-table\n{"kind":"prime-factorization",',
  },
  // Crible d'Ératosthène — avant le catch-all binaire
  {
    regex:   /crible|[eé]ratosth[eè]ne/i,
    prefill: '```arith-table\n{"kind":"sieve-eratosthenes",',
  },
  // Diviseurs — avant le catch-all binaire
  {
    regex:   /diviseurs?\s+de\s+\d+/i,
    prefill: '```arith-table\n{"kind":"divisors-search",',
  },
  // ⚠️ Catch-all binaire EN DERNIER pour ne pas écraser les triggers ci-dessus
  {
    regex:   /binaire|base\s*2/i,
    prefill: '```arith-table\n{"kind":"base-conversion",',
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
  // stream: true par défaut sauf si explicitement false
  const useStream = options.stream !== false;

  const isMultimodal = hasMultimodalContent(options.messages ?? []);

  const model = isMultimodal
    ? VISION_FALLBACK
    : (OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus);

  let messages = isMultimodal
    ? convertToOpenAIFormat(options.messages ?? [])
    : (options.messages ?? []);

  // ── Prefill arith-table (seulement en mode stream, pas multimodal) ──────
  const prefill = (isMultimodal || !useStream) ? null : getArithPrefill(messages);

  if (prefill) {
    messages = [...messages, { role: 'assistant', content: prefill }];
  }

  // ── Round-robin : essayer chaque clé jusqu'à succès ─────────────────────
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
      continue; // essayer la clé suivante
    }

    // Retry sur 429 (quota) ou 5xx (erreur serveur transitoire)
    if (res.status === 429 || res.status >= 500) {
      const body = await res.json().catch(() => ({}));
      console.warn(`[OpenRouter] HTTP ${res.status} (clé ...${key.slice(-6)}):`, body?.error?.message ?? '');
      lastError = new Error(body?.error?.message ?? `Erreur HTTP ${res.status}`);
      continue; // essayer la clé suivante
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message ?? `Erreur HTTP ${res.status}`);
    }

    // ── Mode NON-stream (ex: rephraseForSearch) ────────────────────────────
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
          const { choices } = JSON.parse(payload);
          const delta = choices?.[0]?.delta;

          if (delta?.content) {
            content += delta.content;
            // ← on passe delta.content (le nouveau morceau uniquement),
            //   pas `content` cumulé, pour que le caller puisse streamer
            //   correctement sans dupliquer le texte.
            options.onChunk?.(delta.content);
          }
          if (delta?.reasoning) {
            reasoning += delta.reasoning;
          }
        } catch {
          // chunk malformé → on ignore
        }
      }
    }

    // ── Recoller le prefill si OpenRouter ne le répète pas ─────────────────
    // Vérification défensive : si le stream a déjà inclus le prefill,
    // ne pas le dupliquer.
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
