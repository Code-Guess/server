'use strict';

// src/routes/chat.js
// ─────────────────────────────────────────────────────────────────────────────
// Support des pièces jointes (images + PDF) avec détection multimodale
// La conversion Anthropic → OpenAI est gérée dans openrouter.js
// Le prefill arith-table est géré automatiquement dans openrouter.js
//
// FIX : stripThinking() ne gérait que <thinking>...</thinking> FERMÉ.
// Si un message assistant de l'historique a été sauvegardé alors qu'il
// était encore en train de streamer (thinking non fermé, ou JSON "steps"
// orphelin), ce contenu brut ("Génération du code demandé", etc.) restait
// dans l'historique et était renvoyé au modèle, qui le prenait pour sa
// propre réponse précédente -> réponses parasites incohérentes.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const { openRouterFetch }                    = require('../openrouter');
const { getSystemPrompt }                    = require('../prompts');
const { runSearchAgent }                     = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');
const { runAgentLoop, needsAgentLoop }       = require('../tools/agentLoop');

// ── Types MIME acceptés ───────────────────────────────────────────────────────

const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
]);

const ACCEPTED_DOC_TYPES = new Set([
  'application/pdf',
]);

// ── Construction du contenu user avec pièces jointes ─────────────────────────

function buildUserContent(message, attachments = []) {
  if (!attachments || attachments.length === 0) return message;

  const blocks = [];

  for (const att of attachments) {
    if (!att.base64 || !att.mimeType) {
      console.warn('[chat] Attachment ignoré — base64 ou mimeType manquant :', att.name);
      continue;
    }

    if (att.type === 'image') {
      let mimeType = att.mimeType.toLowerCase();
      if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
      if (!ACCEPTED_IMAGE_TYPES.has(mimeType)) {
        console.warn('[chat] Image ignorée — mimeType non supporté :', mimeType);
        continue;
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: att.base64 },
      });

    } else if (att.type === 'document') {
      let mimeType = att.mimeType.toLowerCase();
      if (['application/octet-stream', 'application/x-unknown', ''].includes(mimeType)) {
        if (att.name?.toLowerCase().endsWith('.pdf')) {
          mimeType = 'application/pdf';
        } else {
          console.warn('[chat] Document ignoré — mimeType non déterminable :', att.name);
          continue;
        }
      }
      if (!ACCEPTED_DOC_TYPES.has(mimeType)) {
        console.warn('[chat] Document ignoré — mimeType non supporté :', mimeType);
        continue;
      }
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: mimeType, data: att.base64 },
      });
    }
  }

  if (blocks.length === 0) return message;
  if (message?.trim().length > 0) blocks.push({ type: 'text', text: message });
  return blocks;
}

// ── Détection de la nécessité d'une recherche web ────────────────────────────

const NO_SEARCH_PATTERNS = [
  /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\b/i,
  /^(merci|thanks|thank you)\b/i,
  /^\d[\d\s+\-*/^().,]*$/,
  /^(résume|reformule|traduis|corrige|améliore)\s/i,
  /^(continue|vas-y|ok|oui|non|d'accord)\b/i,
  /^(quel est ton nom|qui es-tu|tu es qui|what are you)\b/i,
];

function needsSearch(query) {
  const q = query.trim();
  if (q.length < 8) return false;
  return !NO_SEARCH_PATTERNS.some(re => re.test(q));
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
  const lines = partial.split('\n')
    .map(l => l.replace(/^[-*•#>\d.)\s]+/, '').trim())
    .filter(l => l.length > 4);
  if (lines.length > 0) return lines.slice(0, 4).map(l => ({ title: l.slice(0, 80) }));
  return [];
}

// ── Nettoyage du contenu affiché (retire les balises <thinking>) ──────────────
//
// FIX : gère désormais 3 cas :
//  1. <thinking>...</thinking> complet -> retiré
//  2. <thinking> ouvert sans fermeture (message coupé en plein streaming)
//     -> tout ce qui suit <thinking> est retiré
//  3. JSON orphelin de type {"steps":[...]} (sans même la balise <thinking>,
//     ex: contenu sauvegardé après un crash) -> retiré aussi
//
function stripThinking(content) {
  if (typeof content !== 'string') return content;

  let cleaned = content
    // Cas 1 : thinking fermé
    .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
    // Cas 2 : thinking ouvert non fermé jusqu'à la fin du texte
    .replace(/<thinking>[\s\S]*$/g, '');

  // Cas 3 : JSON "steps" orphelin (avec ou sans accolade finale)
  cleaned = cleaned
    .replace(/\{?\s*"steps"\s*:\s*\[[\s\S]*?\]\s*\}?/g, '')
    .replace(/^\s*\{\s*"steps"\s*:[\s\S]*?\}?\s*$/gm, '');

  return cleaned.trimStart();
}

// ─────────────────────────────────────────────────────────────────────────────
// Route principale
// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    message,
    history      = [],
    model        = 'opus',
    deepResearch = false,
    max_tokens,
    temperature,
    attachments  = [],
  } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }

  if (attachments.length > 0) {
    console.log(
      `[chat] ${attachments.length} pièce(s) jointe(s) :`,
      attachments.map(a =>
        `${a.name} (${a.type}, ${a.mimeType}, ${
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

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const done = ()      => { res.write('data: [DONE]\n\n'); res.end(); };

  // ── Helper : construction des messages history ────────────────────────────
  function buildHistory() {
    return (history ?? [])
      .filter(m => m.role && m.content)
      .map(m => ({
        role:    m.role,
        content: m.role === 'assistant' ? stripThinking(m.content) : m.content,
      }))
      .filter(m => typeof m.content === 'string' && m.content.trim().length > 0);
  }

  try {

    // ── 1. Pipeline code (deep research) ─────────────────────────────────────
    if (deepResearch && needsCodePipeline(message)) {
      await runCodePipeline(message, (agentSteps) => {
        send({ type: 'pipeline', steps: agentSteps });
      }).then(result => {
        send({ type: 'codeResult', result });
        done();
      });
      return;
    }

    // ── 2. Agent loop (execute_code / edit_file) ──────────────────────────────
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
        model:       model ?? 'sonnet',
        max_tokens:  max_tokens  ?? 8192,
        temperature: temperature ?? 0.2,
      });
      return;
    }

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

    // ── 4. Construction des messages ──────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);
    const userContent  = buildUserContent(message, attachments);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...buildHistory(),
      { role: 'user', content: userContent },
    ];

    // ── 5. Appel LLM (prefill arith-table géré automatiquement dans openrouter.js)
    let streamedContent = '';

    const result = await openRouterFetch({
      model:       model ?? 'opus',
      max_tokens:  max_tokens  ?? 8192,
      temperature: temperature ?? 0.7,
      messages,

      onChunk: (fullContent) => {
        streamedContent = fullContent;

        // Thinking steps
        const thinkMatch = streamedContent.match(/<thinking>([\s\S]*)/);
        if (thinkMatch) {
          const partial = thinkMatch[1];
          const steps   = parseStepsFromPartial(partial);
          if (steps.length > 0) {
            const thinkingComplete = streamedContent.includes('</thinking>');
            send({
              type:  'thinkingSteps',
              steps: steps.map((s, i) => ({
                label: s.title,
                icon:  'think',
                done:  thinkingComplete || i < steps.length - 1,
              })),
            });
          }
        }

        // N'envoyer le contenu affiché qu'une fois le thinking fermé
        if (!streamedContent.includes('</thinking>')) return;

        const displayContent = stripThinking(streamedContent);
        if (!displayContent) return;

        send({ type: 'chunk', content: displayContent });
      },
    });

    // Flush final garanti
    const finalDisplay = stripThinking(streamedContent);
    if (finalDisplay) send({ type: 'chunk', content: finalDisplay });

    send({ type: 'done', modelUsed: result.modelUsed });
    done();

  } catch (err) {
    console.error('[/api/chat] Erreur :', err?.message ?? err);
    send({ type: 'error', message: err?.message ?? 'Erreur interne du serveur' });
    done();
  }
});

module.exports = router;
