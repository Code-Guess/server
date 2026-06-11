'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

/** Modèles disponibles par niveau (tier). */
const OPENROUTER_MODELS = {
  opus:   'openrouter/gpt-oss-120b:free',
  sonnet: 'openrouter/owl-alpha',
  haiku:  'openai/gpt-oss-120b:free',
};

/**
 * Quand des images sont détectées, on utilise openrouter/free qui route
 * automatiquement vers un modèle gratuit supportant la vision.
 */
const VISION_FALLBACK = 'openrouter/free';

/** Limite de tokens par tier. */
const MAX_TOKENS = {
  opus:   16_000,
  sonnet: 16_000,
  haiku:  4_096,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAvailableKeys() {
  if (KEYS.length === 0) throw new Error('Aucune clé OpenRouter configurée.');
  return KEYS;
}

/**
 * Retourne true si l'un des messages contient un bloc image ou document.
 */
function hasMultimodalContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(m => {
    if (!Array.isArray(m.content)) return false;
    return m.content.some(block =>
      block.type === 'image' || block.type === 'document'
    );
  });
}

/**
 * Convertit les blocs Anthropic en blocs OpenAI-vision pour OpenRouter.
 *
 * Anthropic : { type: 'image', source: { type: 'base64', media_type, data } }
 * OpenAI    : { type: 'image_url', image_url: { url: 'data:...;base64,...' } }
 *
 * Les blocs 'document' (PDF) sont dégradés en texte car OpenRouter
 * ne passe pas les PDFs base64 natifs aux modèles via leur API vision.
 */
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
          text: `[Document PDF joint — analyse son contenu si possible]`,
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

  // Détecter si des pièces jointes multimodales sont présentes
  const isMultimodal = hasMultimodalContent(options.messages ?? []);

  const model = isMultimodal
    ? VISION_FALLBACK
    : (OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus);

  // Convertir le format Anthropic → OpenAI si nécessaire
  const messages = isMultimodal
    ? convertToOpenAIFormat(options.messages)
    : options.messages;

  console.log(`[OpenRouter] Streaming ${model} | multimodal=${isMultimodal} | max_tokens=${maxTokens} | messages=${messages?.length}`);

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

        if (delta?.content)   { content   += delta.content;   options.onChunk?.(content); }
        if (delta?.reasoning) { reasoning += delta.reasoning; }
      } catch {
        // chunk malformé → on ignore
      }
    }
  }

  return { content, reasoning, modelUsed: model };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { openRouterFetch, OPENROUTER_MODELS, getAvailableKeys };
