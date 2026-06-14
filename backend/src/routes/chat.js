'use strict';

const express = require('express');
const router  = express.Router();

const { openRouterFetch }                    = require('../openrouter');
const { getSystemPrompt }                    = require('../prompts');
const { runSearchAgent }                     = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');

const LIMITS = {
  MESSAGE_MAX_LENGTH:    20_000,
  MAX_ATTACHMENTS:       5,
  MAX_TOKENS_CAP:        8_192,
  MAX_BASE64_SIZE_BYTES: 10 * 1024 * 1024,
  TEMPERATURE_MIN:       0,
  TEMPERATURE_MAX:       1,
};

const THINKING_OPEN  = '<thinking>';
const THINKING_CLOSE = '</thinking>';

const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ACCEPTED_DOC_TYPES   = new Set(['application/pdf']);

function isPotentialTag(str, tag) {
  for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
    if (str.endsWith(tag.slice(0, len))) return true;
  }
  return false;
}

function validateInputs(message, attachments, max_tokens, temperature) {
  if (typeof message !== 'string' || message.trim().length === 0) return 'message requis';
  if (message.length > LIMITS.MESSAGE_MAX_LENGTH) return `message trop long (max ${LIMITS.MESSAGE_MAX_LENGTH} caractères)`;
  if (!Array.isArray(attachments)) return 'attachments doit être un tableau';
  if (attachments.length > LIMITS.MAX_ATTACHMENTS) return `trop de pièces jointes (max ${LIMITS.MAX_ATTACHMENTS})`;
  for (const att of attachments) {
    if (att.base64 && att.base64.length * 0.75 > LIMITS.MAX_BASE64_SIZE_BYTES)
      return `pièce jointe trop volumineuse : ${att.name ?? 'inconnue'} (max 10 Mo)`;
  }
  if (max_tokens !== undefined) {
    const n = Number(max_tokens);
    if (!Number.isInteger(n) || n < 1) return 'max_tokens invalide';
  }
  if (temperature !== undefined) {
    const t = Number(temperature);
    if (isNaN(t) || t < LIMITS.TEMPERATURE_MIN || t > LIMITS.TEMPERATURE_MAX)
      return `temperature doit être entre ${LIMITS.TEMPERATURE_MIN} et ${LIMITS.TEMPERATURE_MAX}`;
  }
  return null;
}

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

function buildUserContent(message, attachments = []) {
  if (!attachments || attachments.length === 0) return message;
  const blocks = [];
  for (const att of attachments) {
    if (!att.base64 || !att.mimeType) { console.warn('[chat] Attachment ignoré :', att.name); continue; }
    const resolved = resolveAttachmentType(att);
    if (!resolved) { console.warn('[chat] Type non supporté :', att.mimeType, att.name); continue; }
    const { resolvedType, resolvedMime } = resolved;
    if (resolvedType === 'image')
      blocks.push({ type: 'image', source: { type: 'base64', media_type: resolvedMime, data: att.base64 } });
    else if (resolvedType === 'document')
      blocks.push({ type: 'document', source: { type: 'base64', media_type: resolvedMime, data: att.base64 } });
  }
  if (blocks.length === 0) return message;
  if (message?.trim().length > 0) blocks.push({ type: 'text', text: message });
  return blocks;
}

const NO_SEARCH_PATTERNS = [
  // Salutations & formules courtes
  /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\b/i,
  /^(merci|thanks|thank you)\b/i,
  /^\d[\d\s+\-*/^().,]*$/,
  /^(résume|reformule|traduis|corrige|améliore)\s/i,
  /^(continue|vas-y|ok|oui|non|d'accord)\b/i,
  /^(quel est ton nom|qui es-tu|tu es qui|what are you)\b/i,
  // Demandes code & modification
  /\b(code|fixe|corrige|modifie|ajoute|supprime|refactorise|optimise|debug|débogu)\b/i,
  /\b(fonction|composant|script|fichier|classe|méthode|variable|hook|api|route|endpoint)\b/i,
  /\b(crée?|génère?|écris?)\s.*(app|site|page|formulaire|bouton|modal|interface)\b/i,
  // Message contient déjà du code
  /```[\s\S]*```/,
];

function needsSearch(query) {
  const q = query.trim();
  if (q.length < 8) return false;
  return !NO_SEARCH_PATTERNS.some(re => re.test(q));
}

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
  const titles = sources.slice(0, 3)
    .map(s => `• ${s.title.slice(0, 60)}${s.title.length > 60 ? '…' : ''}`)
    .join('\n');
  return `J'ai trouvé ${count} ${label} :\n${titles}${count > 3 ? `\n• … et ${count - 3} de plus` : ''}\n\nJe synthétise maintenant…`;
}

function parseStepsFromPartial(partial) {
  const completions = [partial, partial + ']}', partial + '"]}', partial + '"}]}'];
  for (const attempt of completions) {
    try {
      const parsed = JSON.parse(attempt.trim());
      if (parsed?.steps && Array.isArray(parsed.steps) && parsed.steps.length > 0)
        return parsed.steps.map(s => ({ title: String(s.title ?? '') }));
    } catch {}
  }
  const matches = [...partial.matchAll(/"title"\s*:\s*"([^"\\]+)"/g)];
  if (matches.length > 0) return matches.map(m => ({ title: m[1] }));
  return [];
}

function stripThinking(content) {
  if (content.includes(THINKING_CLOSE))
    return content.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trimStart();
  const idx = content.indexOf(THINKING_OPEN);
  if (idx !== -1) return content.slice(0, idx).trimEnd();
  return content;
}

// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { message, history = [], model, max_tokens, temperature, attachments = [] } = req.body;
  const deepResearch = req.body.deepResearch === true;

  const validationError = validateInputs(message, attachments, max_tokens, temperature);
  if (validationError) return res.status(400).json({ error: validationError });

  const resolvedModel   = typeof model === 'string' && model.trim().length > 0 ? model.trim() : 'opus';
  const safeMaxTokens   = Math.min(Number(max_tokens) || 8192, LIMITS.MAX_TOKENS_CAP);
  const safeTemperature = Math.max(LIMITS.TEMPERATURE_MIN, Math.min(LIMITS.TEMPERATURE_MAX, Number(temperature) || 0.7));

  if (attachments.length > 0) {
    console.log(`[chat] ${attachments.length} pièce(s) jointe(s) :`,
      attachments.map(a => `${a.name} (${a.mimeType}, ${a.base64 ? Math.round(a.base64.length / 1024) + ' Ko' : 'ABSENT'})`).join(', '));
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let isDone = false;
  const done = () => {
    if (isDone) return;
    isDone = true;
    res.write('data: [DONE]\n\n');
    res.end();
  };

  const VALID_ROLES = new Set(['user', 'assistant']);
  function buildHistory() {
    return (Array.isArray(history) ? history : [])
      .filter(m => m && typeof m === 'object' && VALID_ROLES.has(m.role) && m.content && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.role === 'assistant' ? stripThinking(m.content) : m.content }))
      .filter(m => m.content.trim().length > 0);
  }

  try {

    // ── 1. Pipeline code ──────────────────────────────────────────────────────
    if (deepResearch && needsCodePipeline(message)) {
      await runCodePipeline(message, (agentSteps) => send({ type: 'pipeline', steps: agentSteps }))
        .then(result => { send({ type: 'codeResult', result }); done(); });
      return;
    }

    // ── 2. Agent loop désactivé ───────────────────────────────────────────────

    // ── 3. Recherche web ──────────────────────────────────────────────────────
    let systemContext = '';
    let sources       = [];
    const shouldSearch = message.trim().length >= 8 && needsSearch(message);

    if (shouldSearch) {
      send({ type: 'searching', status: 'loading', label: 'Recherche en cours…', icon: 'globe' });
      try {
        const searchResult = await runSearchAgent(message);
        if (searchResult?.sources?.length > 0 || searchResult?.images?.length > 0) {
          sources       = searchResult.sources;
          systemContext = searchResult.contextBlock;
          if (sources.length > 0) send({ type: 'sources', sources, agent: searchResult.agent });
          if (searchResult.images?.length > 0) send({ type: 'images', images: searchResult.images, intent: searchResult.imageIntent ?? 'none' });
          send({ type: 'searching', status: 'done', label: buildSearchSummary(searchResult), icon: 'globe', count: sources.length, agent: searchResult.agent });
        } else {
          send({ type: 'searching', status: 'done', label: 'Aucun résultat — je réponds avec mes connaissances.', icon: 'globe' });
        }
      } catch (err) {
        console.warn('[chat] Recherche échouée :', err.message);
        send({ type: 'searching', status: 'error', label: 'Recherche indisponible — réponse directe.', icon: 'globe' });
      }
    }

    // ── 4. Construction des messages ──────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);
    const userContent  = buildUserContent(message, attachments);
    const messages = [{ role: 'system', content: systemPrompt }, ...buildHistory(), { role: 'user', content: userContent }];

    // ── 5. Appel LLM ──────────────────────────────────────────────────────────
    let accContent          = '';
    let accReasoning        = '';
    let lastSentThinkingLen = 0;
    let thinkingDone        = false;
    let lastSentDisplayLen  = 0;
    let lastReplaceTime     = 0;

    const result = await openRouterFetch({
      model:       resolvedModel,
      max_tokens:  safeMaxTokens,
      temperature: safeTemperature,
      messages,

      onChunk: (delta) => {
        accContent += delta;

        const openIdx  = accContent.indexOf(THINKING_OPEN);
        const closeIdx = accContent.indexOf(THINKING_CLOSE);
        const hasOpen  = openIdx  !== -1;
        const hasClose = closeIdx !== -1;

        // ── Thinking en cours ───────────────────────────────────────────────
        if (hasOpen && !hasClose) {
          const before = accContent.slice(0, openIdx).trimEnd();
          if (before && before.length > lastSentDisplayLen) {
            send({ type: 'replace', content: before });
            lastSentDisplayLen = before.length;
          }
          const thinkingFull  = accContent.slice(openIdx + THINKING_OPEN.length);
          const thinkingDelta = thinkingFull.slice(lastSentThinkingLen);
          if (thinkingDelta.length > 0) {
            send({ type: 'thinking', content: thinkingDelta });
            lastSentThinkingLen = thinkingFull.length;
          }
          const steps = parseStepsFromPartial(thinkingFull);
          if (steps.length > 0)
            send({ type: 'thinkingSteps', steps: steps.map(s => ({ label: s.title, icon: 'think', done: false })) });
          return;
        }

        // ── Thinking fermé ──────────────────────────────────────────────────
        if (hasOpen && hasClose && !thinkingDone) {
          thinkingDone = true;
          const thinkingFull  = accContent.slice(openIdx + THINKING_OPEN.length, closeIdx);
          const thinkingDelta = thinkingFull.slice(lastSentThinkingLen);
          if (thinkingDelta.length > 0) {
            send({ type: 'thinking', content: thinkingDelta });
            lastSentThinkingLen = thinkingFull.length;
          }
          const steps = parseStepsFromPartial(thinkingFull);
          if (steps.length > 0)
            send({ type: 'thinkingSteps', steps: steps.map(s => ({ label: s.title, icon: 'think', done: true })) });
          // attend le prochain chunk avant d'envoyer le contenu visible
          return;
        }

        // ── Buffer tags partiels ────────────────────────────────────────────
        if (!hasOpen && isPotentialTag(accContent, THINKING_OPEN))          return;
        if (!hasClose && hasOpen && isPotentialTag(accContent, THINKING_CLOSE)) return;

        // ── Contenu visible avec throttle sur les blocs de code ────────────
        const displayContent = stripThinking(accContent);
        if (!displayContent || !displayContent.trim()) return;

        const now             = Date.now();
        const insideCodeBlock = (displayContent.match(/```/g) ?? []).length % 2 === 1;
        const throttle        = insideCodeBlock ? 150 : 0;

        if (now - lastReplaceTime < throttle) return;
        lastReplaceTime = now;

        send({ type: 'replace', content: displayContent });
      },

      onReasoningChunk: (delta) => {
        accReasoning += delta;
        send({ type: 'thinking', content: delta });
      },
    });

    // ── Flush final ────────────────────────────────────────────────────────────
    let finalContent = stripThinking(accContent);
    if (!finalContent.trim() && accReasoning.trim()) finalContent = accReasoning;
    if (finalContent.trim()) send({ type: 'replace', content: finalContent });

    send({ type: 'done', modelUsed: result.modelUsed });
    done();

  } catch (err) {
    console.error('[/api/chat] Erreur :', err?.message ?? err);
    send({ type: 'error', message: err?.message ?? 'Erreur interne du serveur' });
    done();
  }
});

module.exports = router;
