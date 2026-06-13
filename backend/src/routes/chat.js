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

// ── Nettoyage défensif du contenu affiché ────────────────────────────────────
// FIX MAJEUR : THINKING_FORMAT a été retiré du system prompt (voir base.js).
// Le modèle ne devrait donc plus émettre de balises <thinking> dans son
// `content` — le raisonnement natif passe désormais par `delta.reasoning`
// (voir openrouter.js / onReasoningChunk plus bas).
// Cette fonction reste comme filet de sécurité défensif, au cas où le
// modèle émettrait malgré tout des fragments <thinking>, même malformés
// (ex: "<th<thinking>", "<thinking�", balise jamais fermée, etc.).

function stripThinkingArtifacts(content) {
  if (!content) return content;

  // Normaliser les balises ouvrantes malformées (ex: "<th<thinking>" → "<thinking>")
  content = content.replace(/<[a-zA-Z]{0,12}(<thinking[^>]*>?)/gi, '$1');

  // Bloc complet <thinking ...> ... </thinking>
  content = content.replace(/<thinking[^>]*>[\s\S]*?<\/thinking>\s*/gi, '');

  // Balise ouvrante non fermée (avec ou sans '>', avec ou sans caractère
  // mal encodé juste après, ex: "<thinking�") → couper à partir de là
  const idx = content.search(/<thinking[^>]*>?/i);
  if (idx !== -1 && !/<\/thinking>/i.test(content)) {
    return content.slice(0, idx).trimEnd();
  }

  return content.trim();
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
        content: m.role === 'assistant' ? stripThinkingArtifacts(m.content) : m.content,
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

    // FIX MAJEUR: on envoie désormais des DELTAS au client (pas le total
    // accumulé). L'ancien code envoyait le total accumulé à CHAQUE chunk,
    // et le client fait `result.content += event.content` → accumulation
    // d'accumulations → répétition exponentielle du texte. On ne renvoie
    // maintenant que la portion nouvelle de `displayContent` par rapport à
    // ce qui a déjà été envoyé (sentDisplayLength).
    let sentDisplayLength = 0;

    // FIX : THINKING_FORMAT retiré du system prompt (voir base.js). Le
    // raisonnement du modèle arrive maintenant via `delta.reasoning`
    // (canal natif d'owl-alpha), capté ici dans `reasoningContent`.
    // - On s'en sert pour afficher une étape "Réflexion en cours…" pendant
    //   que le modèle réfléchit, puis "Rédaction de la réponse" dès que le
    //   vrai contenu commence à arriver.
    // - On s'en sert aussi en dernier recours si `streamedContent` reste
    //   totalement vide (cas des messages très simples comme "Salut" où le
    //   modèle met parfois toute sa réponse dans `reasoning`).
    let reasoningContent      = '';
    let reasoningStepSent     = false;
    let writingStepSent       = false;

    const result = await openRouterFetch({
      model:       resolvedModel,
      max_tokens:  safeMaxTokens,
      temperature: safeTemperature,
      messages,

      onReasoningChunk: (chunk) => {
        reasoningContent += chunk;
        if (!reasoningStepSent) {
          reasoningStepSent = true;
          send({
            type:  'thinkingSteps',
            steps: [{ label: 'Réflexion en cours…', icon: 'think', done: false }],
          });
        }
      },

      onChunk: (chunk) => {
        streamedContent += chunk;

        // Envoyer uniquement le delta du contenu nettoyé (filet de sécurité
        // défensif contre d'éventuelles balises <thinking> résiduelles)
        const displayContent = stripThinkingArtifacts(streamedContent);
        if (displayContent.length > sentDisplayLength) {
          const delta = displayContent.slice(sentDisplayLength);
          if (delta) {
            if (!writingStepSent) {
              writingStepSent = true;
              send({
                type:  'thinkingSteps',
                steps: [{ label: 'Rédaction de la réponse', icon: 'done', done: true }],
              });
            }
            send({ type: 'chunk', content: delta });
            sentDisplayLength = displayContent.length;
          }
        }
      },
    });

    // FIX : si `streamedContent` est resté totalement vide tout le stream
    // (cas owl-alpha sur messages simples — tout est arrivé via
    // delta.reasoning), on utilise `reasoningContent` comme contenu de la
    // réponse, en retirant juste d'éventuelles balises <thinking> résiduelles.
    // Sans ce fallback, le client reçoit "Réponse vide reçue du serveur".
    if (sentDisplayLength === 0 && reasoningContent.trim()) {
      const fallback = stripThinkingArtifacts(reasoningContent);
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
