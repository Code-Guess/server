// ─────────────────────────────────────────────────────────────────────────────
// src/routes/chat.js — Route POST /api/chat (streaming SSE)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { openRouterFetch } = require('../openrouter');
const { getSystemPrompt } = require('../prompts');
const { runSearchAgent } = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');

/**
 * POST /api/chat
 *
 * Body :
 * {
 *   message: string,           — message de l'utilisateur
 *   history: [{role, content}], — historique de la conversation
 *   model: "opus"|"sonnet"|"haiku",
 *   deepResearch: boolean,      — true = pipeline multi-agents
 *   webSearch: boolean,         — true = forcer la recherche web
 *   max_tokens?: number,
 *   temperature?: number,
 * }
 */
router.post('/', async (req, res) => {
  const {
    message,
    history      = [],
    model        = 'opus',
    deepResearch = false,
    webSearch    = false,   // FIX : lu depuis req.body (était ignoré avant)
    max_tokens,
    temperature,
  } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }

  // ── Headers SSE ────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  try {
    // ── Mode deepResearch = pipeline multi-agents ───────────────────────────
    if (deepResearch && needsCodePipeline(message)) {
      await runCodePipeline(message, (agentSteps) => {
        send({ type: 'pipeline', steps: agentSteps });
      }).then(result => {
        send({ type: 'codeResult', result });
        done();
      });
      return;
    }

    // ── Recherche web ───────────────────────────────────────────────────────
    // FIX : runSearchAgent attend une string comme second argument ('web' ou undefined).
    // Si webSearch est activé par l'utilisateur, on force l'agent 'web'.
    // Sinon, on laisse detectAgent() choisir automatiquement selon les mots-clés.
    let systemContext = '';
    let sources = [];

    const forceAgent = webSearch ? 'web' : undefined;
    const searchResult = await runSearchAgent(message, forceAgent);
    if (searchResult) {
      sources = searchResult.sources;
      systemContext = searchResult.contextBlock;
      send({ type: 'sources', sources });
    }

    // ── Prompt système ──────────────────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);

    // FIX : filtrage strict de l'historique côté backend aussi
    // - on exclut les entrées sans role ou avec content vide
    // - double sécurité si le frontend envoie un message vide par erreur
    const previousMessages = (history ?? [])
      .filter(m =>
        m.role &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0
      )
      .map(m => ({ role: m.role, content: m.content }));

    let streamedContent = '';

    const result = await openRouterFetch({
      model:       model ?? 'opus',
      max_tokens:  max_tokens ?? 8192,
      temperature: temperature ?? 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...previousMessages,
        { role: 'user', content: message },
      ],
      onChunk: (chunk) => {
        streamedContent += chunk;

        // ── Étapes thinking en temps réel ───────────────────────────────────
        const thinkMatch = streamedContent.match(/<thinking>([\s\S]*)/);
        if (thinkMatch) {
          const partial = thinkMatch[1];
          const steps = parseStepsFromPartial(partial);
          if (steps.length > 0) {
            const thinkingComplete = streamedContent.includes('</thinking>');
            send({
              type: 'thinkingSteps',
              steps: steps.map((s, i) => ({
                label: s.title,
                icon:  'think',
                done:  thinkingComplete || i < steps.length - 1,
              })),
            });
          }
        }

        // ── Contenu visible : masque le bloc <thinking> ─────────────────────
        let displayContent = streamedContent;
        const thinkEnd = streamedContent.indexOf('</thinking>');
        if (thinkEnd !== -1) {
          displayContent = streamedContent.slice(thinkEnd + '</thinking>'.length).trimStart();
        } else if (streamedContent.includes('<thinking>')) {
          displayContent = ''; // bloc pas encore fermé → rien à afficher
        }

        if (displayContent) {
          send({ type: 'chunk', content: displayContent });
        }
      },
    });

    send({ type: 'done', modelUsed: result.modelUsed });
    done();

  } catch (err) {
    console.error('[/api/chat] Erreur :', err?.message ?? err);
    send({ type: 'error', message: err?.message ?? 'Erreur interne du serveur' });
    done();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseStepsFromPartial(partial) {
  const completions = [partial, partial + ']}', partial + '"]}', partial + '"]}'];
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

module.exports = router;
