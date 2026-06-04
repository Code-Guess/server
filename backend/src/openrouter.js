// ─────────────────────────────────────────────────────────────────────────────
// src/openrouter.js — Proxy sécurisé vers OpenRouter
// Les clés API restent ici, côté serveur — jamais dans l'app mobile
// ─────────────────────────────────────────────────────────────────────────────

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
].filter(Boolean);

const OPENROUTER_MODELS = {
  opus:   'openrouter/owl-alpha',
  sonnet: 'openai/gpt-oss-120b:free',
  haiku:  'openai/gpt-oss-20b:free',
};

const MODEL_FALLBACK_CHAIN = [
  'openrouter/owl-alpha',
  'openai/gpt-oss-120b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'openai/gpt-oss-20b:free',
];

const MODEL_TIMEOUTS = {
  'openrouter/owl-alpha':                   90000,
  'nvidia/nemotron-3-super-120b-a12b:free': 300000,
  'openai/gpt-oss-120b:free':               45000,
  'google/gemma-4-31b-it:free':             45000,
  'openai/gpt-oss-20b:free':                30000,
};
const DEFAULT_TIMEOUT = 45000;

// ── Rotation de clés ──────────────────────────────────────────────────────────

const KEY_COOLDOWN_MS = 10 * 60 * 1000;
const keyStates = new Map(
  OPENROUTER_KEYS.map(k => [k, { failedAt: null, failCount: 0 }])
);

function isKeyAvailable(key) {
  const state = keyStates.get(key);
  if (!state || state.failedAt === null) return true;
  return Date.now() - state.failedAt > KEY_COOLDOWN_MS;
}
function markKeyFailed(key) {
  const state = keyStates.get(key) ?? { failedAt: null, failCount: 0 };
  keyStates.set(key, { failedAt: Date.now(), failCount: state.failCount + 1 });
}
function markKeySuccess(key) {
  keyStates.set(key, { failedAt: null, failCount: 0 });
}
function getAvailableKeys() {
  const available = OPENROUTER_KEYS.filter(isKeyAvailable);
  if (available.length > 0) return available;
  let oldest = OPENROUTER_KEYS[0];
  let oldestTime = Infinity;
  for (const key of OPENROUTER_KEYS) {
    const t = keyStates.get(key)?.failedAt ?? 0;
    if (t < oldestTime) { oldestTime = t; oldest = key; }
  }
  markKeySuccess(oldest);
  return [oldest];
}

// ── Cooldown modèles ──────────────────────────────────────────────────────────

const MODEL_COOLDOWN_MS = 5 * 60 * 1000;
const modelFailedAt = new Map();

function isModelAvailable(model) {
  const t = modelFailedAt.get(model);
  if (t === undefined) return true;
  return Date.now() - t > MODEL_COOLDOWN_MS;
}
function markModelFailed(model) {
  modelFailedAt.set(model, Date.now());
  console.warn(`[OpenRouter] Modèle en cooldown 5min : ${model}`);
}
function markModelSuccess(model) {
  modelFailedAt.delete(model);
}

// ── Classify error ────────────────────────────────────────────────────────────

const QUOTA_STATUS = new Set([429, 402]);
const QUOTA_MESSAGES = ['rate limit', 'quota', 'exceeded', 'insufficient', 'no credits', 'billing'];

function classifyError(status, message) {
  const msg = (message ?? '').toLowerCase();
  if (QUOTA_STATUS.has(status) || QUOTA_MESSAGES.some(p => msg.includes(p))) return 'quota';
  if (status === 200) return 'provider';
  if (status >= 500 || msg.includes('provider returned error') || msg.includes('no endpoints')) return 'provider';
  if (status === 404) return 'provider';
  return 'fatal';
}

// ── Tentative unique ──────────────────────────────────────────────────────────

async function tryOnce(model, key, messages, options) {
  const timeoutMs = MODEL_TIMEOUTS[model] ?? DEFAULT_TIMEOUT;
  console.log(`[OpenRouter] Essai ${model} | key=...${key.slice(-8)} | timeout=${timeoutMs / 1000}s`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'https://nerosia.app',
        'X-Title': 'Nerosia',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: options.max_tokens ?? 8192,
        temperature: options.temperature ?? 0.7,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[OpenRouter] Timeout/réseau ${model} : ${err?.message}`);
    return null;
  }
  clearTimeout(timer);

  const data = await res.json().catch(() => ({}));
  const content = data?.choices?.[0]?.message?.content;
  const reasoning = data?.choices?.[0]?.message?.reasoning ?? data?.choices?.[0]?.message?.reasoning_content;

  if (res.ok && content && content.trim().length > 0) {
    markKeySuccess(key);
    markModelSuccess(model);
    console.log(`[OpenRouter] Succès via ${model} (${content.length} chars)`);
    return { content, reasoning, modelUsed: model };
  }

  const errMsg = data?.error?.message ?? data?.message ?? res.statusText ?? 'Réponse vide';
  const kind = classifyError(res.status, errMsg);

  if (kind === 'quota') {
    markKeyFailed(key);
    console.warn(`[OpenRouter] Clé épuisée (${res.status}) : ${errMsg}`);
  } else {
    markModelFailed(model);
    console.warn(`[OpenRouter] ${model} : ${errMsg}`);
  }

  return null;
}

// ── Point d'entrée principal ──────────────────────────────────────────────────

async function openRouterFetch(options) {
  if (OPENROUTER_KEYS.length === 0) {
    throw new Error('Aucune clé OpenRouter configurée côté serveur.');
  }

  const tier = options.model ?? 'opus';
  const preferredModel = OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.opus;

  const modelsToTry = [
    preferredModel,
    ...MODEL_FALLBACK_CHAIN.filter(m => m !== preferredModel),
  ].filter(isModelAvailable);

  const keys = getAvailableKeys();
  const messages = (options.messages ?? [])
    .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }))
    .filter(m => m.content.trim().length > 0);

  for (const model of modelsToTry) {
    for (const key of keys) {
      const result = await tryOnce(model, key, messages, options);
      if (result) return result;
    }
  }

  throw new Error('Tous les modèles sont indisponibles. Réessaie dans quelques secondes.');
}

module.exports = { openRouterFetch, OPENROUTER_MODELS };
