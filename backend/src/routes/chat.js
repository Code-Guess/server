// src/routes/chat.js
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();
const { openRouterFetch }                    = require('../openrouter');
const { getSystemPrompt }                    = require('../prompts');
const { runSearchAgent }                     = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');
const { runAgentLoop, needsAgentLoop }       = require('../tools/agentLoop');

// ── Requêtes qui ne nécessitent PAS de recherche web ─────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    message,
    history      = [],
    model        = 'opus',
    deepResearch = false,
    max_tokens,
    temperature,
  } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

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

      const previousMessages = (history ?? [])
        .filter(m => m.role && m.content)
        .map(m => ({
          role:    m.role,
          content: m.role === 'assistant'
            ? m.content.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trimStart()
            : m.content,
        }))
        .filter(m => m.content.trim().length > 0);

      const messages = [
        { role: 'system', content: systemPrompt },
        ...previousMessages,
        { role: 'user', content: message },
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

    // ── 3. Recherche systématique ─────────────────────────────────────────────
    let systemContext = '';
    let sources       = [];

    if (needsSearch(message)) {
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
          send({ type: 'searching', status: 'done', label: 'Aucun résultat trouvé — je réponds avec mes connaissances.', icon: 'globe' });
        }

      } catch (err) {
        console.warn('[chat] Recherche échouée :', err.message);
        send({ type: 'searching', status: 'error', label: 'Recherche indisponible — réponse directe.', icon: 'globe' });
      }
    }

    // ── 4. Construction du prompt ─────────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);

    const previousMessages = (history ?? [])
      .filter(m => m.role && m.content)
      .map(m => ({
        role:    m.role,
        content: m.role === 'assistant'
          ? m.content.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trimStart()
          : m.content,
      }))
      .filter(m => m.content.trim().length > 0);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...previousMessages,
      { role: 'user', content: message },
    ];

    // ── 5. Appel LLM en streaming ─────────────────────────────────────────────
    let streamedContent = '';

    const result = await openRouterFetch({
      model:       model ?? 'opus',
      max_tokens:  max_tokens  ?? 8192,
      temperature: temperature ?? 0.7,
      messages,

      onChunk: (chunk) => {
        streamedContent = chunk;

        // Gestion bloc <thinking>
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

        // Attendre la fin du bloc <thinking> avant d'envoyer le contenu affiché
        if (!streamedContent.includes('</thinking>')) return;

        const displayContent = streamedContent
          .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
          .trimStart();

        if (!displayContent) return;
        send({ type: 'chunk', content: displayContent });
      },
    });

    // Flush final
    const finalDisplay = streamedContent
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
      .trimStart();

    if (finalDisplay) {
      send({ type: 'chunk', content: finalDisplay });
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
