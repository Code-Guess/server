'use strict';

// src/routes/chat.js
// ─────────────────────────────────────────────────────────────────────────────
// Support des pièces jointes (images + PDF) avec détection multimodale
// La conversion Anthropic → OpenAI est gérée dans openrouter.js
// Le prefill arith-table est géré automatiquement dans openrouter.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { openRouterFetch }                    = require('../openrouter');
const { getSystemPrompt }                    = require('../prompts');
const { runSearchAgent }                     = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');
const { runAgentLoop, needsAgentLoop }       = require('../tools/agentLoop');

// ── Limites de sécurité ───────────────────────────────────────────────────────

const LIMITS = {
  MESSAGE_MAX_LENGTH:    20_000,
  MAX_ATTACHMENTS:       5,
  MAX_TOKENS_CAP:        8_192,
  MAX_BASE64_SIZE_BYTES: 10 * 1024 * 1024,
  TEMPERATURE_MIN:       0,
  TEMPERATURE_MAX:       1,
};

// ── Types MIME acceptés ───────────────────────────────────────────────────────

const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

const ACCEPTED_DOC_TYPES = new Set([
  'application/pdf',
]);

// ── Validation des inputs ─────────────────────────────────────────────────────

function validateInputs(message, attachments, max_tokens, temperature) {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return 'message requis';
  }
  if (message.length > LIMITS.MESSAGE_MAX_LENGTH) {
    return `message trop long (max ${LIMITS.MESSAGE_MAX_LENGTH} caractères)`;
  }
  if (!Array.isArray(attachments)) {
    return 'attachments doit être un tableau';
  }
  if (attachments.length > LIMITS.MAX_ATTACHMENTS) {
    return `trop de pièces jointes (max ${LIMITS.MAX_ATTACHMENTS})`;
  }
  for (const att of attachments) {
    if (att.base64 && att.base64.length * 0.75 > LIMITS.MAX_BASE64_SIZE_BYTES) {
      return `pièce jointe trop volumineuse : ${att.name ?? 'inconnue'} (max 10 Mo)`;
    }
  }
  if (max_tokens !== undefined) {
    const n = Number(max_tokens);
    if (!Number.isInteger(n) || n < 1) return 'max_tokens invalide';
  }
  if (temperature !== undefined) {
    const t = Number(temperature);
    if (isNaN(t) || t < LIMITS.TEMPERATURE_MIN || t > LIMITS.TEMPERATURE_MAX) {
      return `temperature doit être entre ${LIMITS.TEMPERATURE_MIN} et ${LIMITS.TEMPERATURE_MAX}`;
    }
  }
  return null;
}

// ── Résolution du type de pièce jointe ───────────────────────────────────────

function resolveAttachmentType(att) {
  if (!att.mimeType) return null;
  let mime = att.mimeType.toLowerCase().trim();

  if (mime === 'image/jpg') mime = 'image/jpeg';

  if (['application/octet-stream', 'application/x-unknown', ''].includes(mime)) {
    const name = att.name?.toLowerCase() ?? '';
    if (name.endsWith('.pdf'))                                mime = 'application/pdf';
    else if (name.endsWith('.jpg') || name.endsWith('.jpeg')) mime = 'image/jpeg';
    else if (name.endsWith('.png'))                           mime = 'image/png';
    else if (name.endsWith('.gif'))                           mime = 'image/gif';
    else if (name.endsWith('.webp'))                          mime = 'image/webp';
    else return null;
  }

  if (ACCEPTED_IMAGE_TYPES.has(mime)) return { resolvedType: 'image',    resolvedMime: mime };
  if (ACCEPTED_DOC_TYPES.has(mime))   return { resolvedType: 'document', resolvedMime: mime };
  return null;
}

// ── Construction du contenu user avec pièces jointes ─────────────────────────

function buildUserContent(message, attachments = []) {
  if (!attachments || attachments.length === 0) return message;

  const blocks = [];

  for (const att of attachments) {
    if (!att.base64 || !att.mimeType) {
      console.warn('[chat] Attachment ignoré — base64 ou mimeType manquant :', att.name);
      continue;
    }
    const resolved = resolveAttachmentType(att);
    if (!resolved) {
      console.warn('[chat] Attachment ignoré — type non supporté :', att.mimeType, att.name);
      continue;
    }

    const { resolvedType, resolvedMime } = resolved;

    if (resolvedType === 'image') {
      blocks.push({
        type:   'image',
        source: { type: 'base64', media_type: resolvedMime, data: att.base64 },
      });
    } else if (resolvedType === 'document') {
      blocks.push({
        type:   'document',
        source: { type: 'base64', media_type: resolvedMime, data: att.base64 },
      });
    }
  }

  if (blocks.length === 0) return message;
  if (message?.trim().length > 0) blocks.push({ type: 'text', text: message });
  return blocks;
}

// ── Détection requête code (pas de recherche web pour le code) ────────────────
// FIX: les requêtes de code ne doivent pas déclencher runSearchAgent
// car ça bloque l'UI pendant toute la durée de la recherche sans feedback

const CODE_QUERY_PATTERNS = [
  /\b(code|programme|script|fonction|algorithme|debug|debugg|api|react|python|javascript|typescript|html|css|sql|nodejs|node\.js|express|composant|component)\b/i,
  /\b(crée|génère|écris|développe|implémente|fais|rédige|refactor|corrige|fixe|améliore).{0,40}\b(application|app|site|web|composant|component|api|backend|frontend|serveur|server|fonction|function|classe|class|module)\b/i,
  /\b(bug|erreur|error|exception|crash|segfault|stacktrace|stack trace)\b/i,
];

function isCodeQuery(query) {
  if (!query || typeof query !== 'string') return false;
  return CODE_QUERY_PATTERNS.some(re => re.test(query));
}

// ── Détection de la nécessité d'une recherche web ────────────────────────────

const NO_SEARCH_PATTERNS = [
  /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\b/i,
  /^(merci|thanks|thank you)\b/i,
  /^\d[\d\s+\-*/^().,]*$/,
  /^(resumes?|reformule|traduis|corrige|ameliore|resume)\s/i,
  /^(r[eé]sum[eé]|r[eé]formule|traduis|corrige|am[eé]liore)\s/i,
  /^(continue|vas-y|ok|oui|non|d'accord)\b/i,
  /^(quel est ton nom|qui es-tu|tu es qui|what are you)\b/i,
];

function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function needsSearch(query) {
  if (!query || typeof query !== 'string') return false;
  const q     = query.trim();
  const qNorm = normalize(q);
  if (q.length < 8) return false;
  // FIX: pas de recherche pour les requêtes code — ça bloque l'UI inutilement
  if (isCodeQuery(q)) return false;
  return !NO_SEARCH_PATTERNS.some(re => re.test(q) || re.test(qNorm));
}

// ── Helpers affichage recherche ───────────────────────────────────────────────

function getAgentLabel(agent) {
  switch (agent) {
    case 'image':     return 'images';
    case 'academic':  return 'articles académiques';
    case 'reddit':    return 'discussions Reddit';
    case 'wikipedia': return 'articles Wikipedia';
    default:          return 'sources web';
  }
}

function buildSearchSummary(searchResult) {
  if (!searchResult || searchResult.sources.length === 0) return null;
  const { agent, sources } = searchResult;
  const count  = sources.length;
  const label  = getAgentLabel(agent);
  const titles = sources
    .slice(0, 3)
    .map(s => `• ${s.title.slice(0, 60)}${s.title.length > 60 ? '…' : ''}`)
    .join('\n');
  return `J'ai trouvé ${count} ${label} :\n${titles}${count > 3 ? `\n• … et ${count - 3} de plus` : ''}\n\nJe synthétise maintenant…`;
}

// ── Parser les étapes de thinking partiel ────────────────────────────────────

function parseStepsFromPartial(partial) {
  const completions = [partial, partial + ']}', partial + '"]}', partial + '"}]}'];
  for (const attempt of completions) {
    try {
      const parsed = JSON.parse(attempt.trim());
      if (parsed?.steps && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        return parsed.steps.map(s => ({ title: String(s.title ?? '') }));
      }
    } catch {}
  }

  const matches = [...partial.matchAll(/"title"\s*:\s*"([^"\\]+)"/g)];
  if (matches.length > 0) return matches.map(m => ({ title: m[1] }));

  return [];
}

// ── Nettoyage du contenu affiché (retire les balises <thinking>) ──────────────
// FIX: robuste sur tags partiels, insensible à la casse, gère aussi </thinking>
// FIX 2: tolère les balises malformées type "<th<thinking>" générées par
// certains modèles lorsqu'un prefill se chevauche avec le début du flux.

function stripThinking(content) {
  if (!content) return content;

  // Normaliser les balises ouvrantes malformées (ex: "<th<thinking>" → "<thinking>")
  content = content.replace(/<[a-zA-Z]{0,9}(<thinking>)/gi, '$1');

  // Tags complets (toutes variantes)
  if (/<\/thinking>/i.test(content)) {
    return content
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
      .trimStart();
  }

  // Tag ouvert non fermé → couper à partir de là
  const idx = content.search(/<thinking>/i);
  if (idx !== -1) {
    return content.slice(0, idx).trimEnd();
  }

  return content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route principale
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    message,
    history     = [],
    model,
    max_tokens,
    temperature,
    attachments = [],
  } = req.body;

  const deepResearch = req.body.deepResearch === true;

  // ── Validation des inputs ─────────────────────────────────────────────────
  const validationError = validateInputs(message, attachments, max_tokens, temperature);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // ── Valeurs sécurisées ────────────────────────────────────────────────────
  const resolvedModel   = typeof model === 'string' && model.trim().length > 0
    ? model.trim()
    : 'opus';
  const safeMaxTokens   = Math.min(Number(max_tokens)  || 8192, LIMITS.MAX_TOKENS_CAP);
  const safeTemperature = Math.max(
    LIMITS.TEMPERATURE_MIN,
    Math.min(LIMITS.TEMPERATURE_MAX, Number(temperature) || 0.7)
  );

  if (attachments.length > 0) {
    console.log(
      `[chat] ${attachments.length} pièce(s) jointe(s) :`,
      attachments.map(a =>
        `${a.name} (${a.mimeType}, ${
          a.base64 ? Math.round(a.base64.length / 1024) + ' Ko' : 'ABSENT'
        })`
      ).join(', ')
    );
  }

  // ── SSE setup ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isDone = false;

  const send = (data) => {
    if (isDone || res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const done = () => {
    if (isDone) return;
    isDone = true;
    if (!res.writableEnded && !res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };

  const VALID_ROLES = new Set(['user', 'assistant']);

  function buildHistory() {
    return (Array.isArray(history) ? history : [])
      .filter(m =>
        m &&
        typeof m === 'object' &&
        VALID_ROLES.has(m.role) &&
        m.content &&
        typeof m.content === 'string'
      )
      .map(m => ({
        role:    m.role,
        content: m.role === 'assistant' ? stripThinking(m.content) : m.content,
      }))
      .filter(m => m.content.trim().length > 0);
  }

  try {

    // ── 1. Pipeline code (deep research) ──────────────────────────────────────
    if (deepResearch && needsCodePipeline(message)) {
      const result = await runCodePipeline(message, (agentSteps) => {
        send({ type: 'pipeline', steps: agentSteps });
      });
      send({ type: 'codeResult', result });
      done();
      return;
    }

    // ── 2. Agent loop (execute_code / edit_file) ───────────────────────────────
    if (!deepResearch && needsAgentLoop(message)) {
      const systemPrompt = getSystemPrompt(message, undefined);
      const userContent  = buildUserContent(message, attachments);

      const messages = [
        { role: 'system', content: systemPrompt },
        ...buildHistory(),
        { role: 'user', content: userContent },
      ];

      await runAgentLoop({
        res,
        messages,
        model:       'sonnet',
        max_tokens:  safeMaxTokens,
        temperature: safeTemperature,
      });
      return;
    }

    // ── 3. Recherche web ───────────────────────────────────────────────────────
    // FIX: needsSearch retourne false pour les requêtes code → pas de blocage
    let systemContext = '';
    let sources       = [];

    if (needsSearch(message)) {
      // FIX: envoyer un thinkingStep immédiatement pour que l'UI ne soit pas bloquée
      send({
        type:  'thinkingSteps',
        steps: [{ label: 'Recherche en cours…', icon: 'globe', done: false }],
      });
      send({ type: 'searching', status: 'loading', label: 'Recherche en cours…', icon: 'globe' });

      try {
        const searchResult = await runSearchAgent(message);

        if (searchResult?.sources?.length > 0 || searchResult?.images?.length > 0) {
          sources       = searchResult.sources;
          systemContext = searchResult.contextBlock;

          if (sources.length > 0) {
            send({ type: 'sources', sources, agent: searchResult.agent });
          }
          if (searchResult.images?.length > 0) {
            send({ type: 'images', images: searchResult.images, intent: searchResult.imageIntent ?? 'none' });
          }

          const summary = buildSearchSummary(searchResult);
          send({ type: 'searching', status: 'done', label: summary, icon: 'globe', count: sources.length, agent: searchResult.agent });

        } else {
          send({ type: 'searching', status: 'done', label: 'Aucun résultat — je réponds avec mes connaissances.', icon: 'globe' });
        }

      } catch (err) {
        console.warn('[chat] Recherche échouée :', err.message);
        send({ type: 'searching', status: 'error', label: 'Recherche indisponible — réponse directe.', icon: 'globe' });
      }
    }

    // ── 4. Construction des messages ───────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);
    const userContent  = buildUserContent(message, attachments);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...buildHistory(),
      { role: 'user', content: userContent },
    ];

    // ── 5. Appel LLM ──────────────────────────────────────────────────────────
    let streamedContent = '';

    // FIX: flag pour n'envoyer le contenu "avant <thinking>" qu'une seule fois
    // L'ancien code renvoyait `before` à chaque chunk → duplication côté client
    let thinkingStartSent = false;

    // FIX MAJEUR: on envoie désormais des DELTAS au client (pas le total
    // accumulé). L'ancien code envoyait `stripThinking(streamedContent)`
    // (= tout le texte affiché depuis le début) à CHAQUE chunk, et le client
    // fait `result.content += event.content` → accumulation d'accumulations,
    // donc répétition exponentielle du texte ("Salut ! Je suis NerosiaSalut !
    // Je suis Nerosia. Comment puis-..."). On ne renvoie maintenant que la
    // portion nouvelle de `displayContent` par rapport à ce qui a déjà été
    // envoyé (sentDisplayLength).
    let sentDisplayLength = 0;

    const result = await openRouterFetch({
      model:       resolvedModel,
      max_tokens:  safeMaxTokens,
      temperature: safeTemperature,
      messages,

      onChunk: (chunk) => {
        streamedContent += chunk;

        const hasOpen  = /<thinking>/i.test(streamedContent);
        const hasClose = /<\/thinking>/i.test(streamedContent);

        // Thinking en cours (tag ouvert, pas encore fermé)
        if (hasOpen && !hasClose) {
          if (!thinkingStartSent) {
            // FIX: envoyer "before" une seule fois, pas à chaque chunk
            thinkingStartSent = true;
            const openIdx = streamedContent.search(/<thinking>/i);
            const before  = streamedContent.slice(0, openIdx).trimEnd();
            if (before) {
              send({ type: 'chunk', content: before });
              sentDisplayLength = before.length;
            }
          }

          const partial = streamedContent.split(/<thinking>/i)[1] ?? '';
          const steps   = parseStepsFromPartial(partial);
          if (steps.length > 0) {
            send({
              type:  'thinkingSteps',
              steps: steps.map(s => ({ label: s.title, icon: 'think', done: false })),
            });
          }
          return;
        }

        // Thinking fermé : envoyer les étapes finales
        if (hasOpen && hasClose) {
          const parts   = streamedContent.split(/<thinking>/i);
          const partial = (parts[1] ?? '').split(/<\/thinking>/i)[0] ?? '';
          const steps   = parseStepsFromPartial(partial);
          if (steps.length > 0) {
            send({
              type:  'thinkingSteps',
              steps: steps.map(s => ({ label: s.title, icon: 'think', done: true })),
            });
          }
        }

        // Envoyer uniquement le delta du contenu nettoyé (sans balises thinking)
        const displayContent = stripThinking(streamedContent);
        if (displayContent.length > sentDisplayLength) {
          const delta = displayContent.slice(sentDisplayLength);
          if (delta) send({ type: 'chunk', content: delta });
          sentDisplayLength = displayContent.length;
        }
      },
    });

    // FIX: certains modèles placent TOUTE leur réponse à l'intérieur de
    // <thinking>...</thinking> sans rien après. Dans ce cas, stripThinking
    // retire le bloc entier → displayContent vide → rien n'est jamais
    // envoyé → "Réponse vide reçue du serveur" côté client.
    // Fallback : si aucun chunk n'a été envoyé, on retire seulement les
    // BALISES <thinking>/</thinking> (pas leur contenu) et on envoie le
    // résultat comme contenu final.
    if (sentDisplayLength === 0) {
      const fallback = streamedContent.replace(/<\/?thinking>/gi, '').trim();
      if (fallback) {
        send({ type: 'chunk', content: fallback });
        sentDisplayLength = fallback.length;
      }
    }

    send({ type: 'done', modelUsed: result.modelUsed });
    done();

  } catch (err) {
    console.error('[/api/chat] Erreur :', err?.message ?? err);
    send({ type: 'error', message: err?.message ?? 'Erreur interne du serveur' });
    done();
  }
});

module.exports = router;
