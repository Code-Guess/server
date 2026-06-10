'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

/** Modèles disponibles par niveau (tier). */
const OPENROUTER_MODELS = {
  opus:   'openrouter/owl-alpha',
  sonnet: 'openrouter/owl-alpha',
  haiku:  'openai/gpt-oss-20b:free',
};

/** Limite de tokens par tier. */
const MAX_TOKENS = {
  opus:   16_000,
  sonnet: 16_000,
  haiku:  4_096,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Retourne les clés API disponibles.
 * @throws {Error} Si aucune clé n'est configurée.
 */
function getAvailableKeys() {
  if (KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  return KEYS;
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

/**
 * Envoie une requête streaming à OpenRouter et reconstruit la réponse complète.
 *
 * Note : le paramètre `thinking:enabled` est volontairement absent.
 * Lorsqu'il est transmis à owl-alpha, le modèle ignore le rôle "system".
 * Le bloc <thinking> dans les réponses provient du prompt texte, pas de ce flag.
 *
 * @param {object}   options
 * @param {string}   [options.model='opus']      - Tier : 'opus' | 'sonnet' | 'haiku'
 * @param {object[]} options.messages            - Historique de messages (format OpenAI)
 * @param {number}   [options.max_tokens]        - Surcharge du quota de tokens
 * @param {number}   [options.temperature=0.7]   - Température de génération
 * @param {Function} [options.onChunk]           - Callback appelé à chaque token reçu (contenu cumulé)
 * @returns {Promise<{ content: string, reasoning: string, modelUsed: string }>}
 */
async function openRouterFetch(options) {
  const keys = getAvailableKeys();

  const tier      = options.model ?? 'opus';
  const model     = OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus;
  const maxTokens = options.max_tokens ?? MAX_TOKENS[tier] ?? 16_000;

  console.log(`[OpenRouter] Streaming ${model} | max_tokens=${maxTokens} | messages=${options.messages?.length}`);

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
      messages:    options.messages,
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

        if (delta?.content)   { content   += delta.content;   options.onChunk?.(content); }
        if (delta?.reasoning) { reasoning += delta.reasoning; }
      } catch {
        // chunk malformé → on ignore silencieusement
      }
    }
  }

  return { content, reasoning, modelUsed: model };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { openRouterFetch, OPENROUTER_MODELS, getAvailableKeys };
