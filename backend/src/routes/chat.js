const express = require('express');
const router = express.Router();
const { openRouterFetch } = require('../openrouter');
const { getSystemPrompt } = require('../prompts');
const { runSearchAgent } = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');

router.post('/', async (req, res) => {
  const { message, history = [], model = 'opus', deepResearch = false, webSearch = false, max_tokens, temperature } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message requis' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  try {
    if (deepResearch && needsCodePipeline(message)) {
      await runCodePipeline(message, (agentSteps) => {
        send({ type: 'pipeline', steps: agentSteps });
      }).then(result => {
        send({ type: 'codeResult', result });
        done();
      });
      return;
    }

    let systemContext = '';
    let sources = [];

    if (webSearch) {
      const searchResult = await runSearchAgent(message);
      if (searchResult) {
        sources = searchResult.sources;
        systemContext = searchResult.contextBlock;
        send({ type: 'sources', sources });
      }
    }

    const systemPrompt = getSystemPrompt(message, systemContext || undefined);

    const previousMessages = (history ?? [])
      .filter(m => m.role && m.content)
      .map(m => ({ role: m.role, content: m.content }));

    let streamedContent = '';

    const result = await openRouterFetch({
      model: model ?? 'opus',
      max_tokens: max_tokens ?? 8192,
      temperature: temperature ?? 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        ...previousMessages,
        { role: 'user', content: message },
      ],
      onChunk: (chunk) => {
        streamedContent = chunk;

        // Étapes thinking en temps réel
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
                icon: 'think',
                done: thinkingComplete || i < steps.length - 1,
              })),
            });
          }
        }

        // Masquer le bloc <thinking>
        let displayContent = streamedContent;
        displayContent = displayContent.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '');
        if (displayContent.includes('<thinking>')) {
          displayContent = displayContent.replace(/<thinking>[\s\S]*/g, '');
        }
        displayContent = displayContent.trimStart();

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
  const lines = partial.split('\n').map(l => l.replace(/^[-*•#>\d.)\s]+/, '').trim()).filter(l => l.length > 4);
  if (lines.length > 0) return lines.slice(0, 4).map(l => ({ title: l.slice(0, 80) }));
  return [];
}

module.exports = router;
