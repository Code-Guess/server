// src/tools/agentLoop.js
// ─────────────────────────────────────────────────────────────────────────────
// Boucle agent : le modèle peut appeler des tools autant de fois que nécessaire
// avant de rendre sa réponse finale.
//
// Flux SSE émis vers le client :
//   { type: 'tool_step', step: { kind, ... } }   ← thinking step visible
//   { type: 'chunk', content: '...' }             ← token texte final
//   { type: 'done', modelUsed: '...' }
//
// Comportement sur erreur d'exécution :
//   Le résultat stderr est renvoyé au modèle → il corrige et réessaie
//   automatiquement (jusqu'à MAX_TOOL_ROUNDS rounds).
// ─────────────────────────────────────────────────────────────────────────────

const { executeCode } = require('../sandbox');
const { TOOLS }       = require('./definitions');

const MAX_TOOL_ROUNDS = 6;

// ── Patterns qui déclenchent la boucle agent ──────────────────────────────────
const AGENT_LOOP_PATTERNS = [
  /\bexécute?\b/i,
  /\blance\b/i,
  /\bcalcule?\b/i,
  /\bteste?\b/i,
  /\bécris?\s+(un|le|du)?\s*code\b/i,
  /\bfais\s+tourner\b/i,
  /\brun\b/i,
  /\bscript\b/i,
  /\bprogramme?\b/i,
  /\bgenère?\s+(un|le|du)?\s*(fichier|code|script)\b/i,
  /\bmodifie?\s+(le|ce|mon)?\s*fichier\b/i,
  /\bedit[_\s]file\b/i,
];

/**
 * Détecte si la requête nécessite la boucle agent (execute_code / edit_file)
 */
function needsAgentLoop(query) {
  return AGENT_LOOP_PATTERNS.some(re => re.test(query.trim()));
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envoie un event SSE au client
 */
function sendSSE(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}

/**
 * Reconstruit les tool_calls depuis les deltas accumulés pendant le stream
 */
function mergeToolCallDeltas(toolCallsAcc) {
  return toolCallsAcc
    .filter(Boolean)
    .map(tc => ({
      id:       tc.id       ?? '',
      type:     'function',
      function: {
        name:      tc.name      ?? '',
        arguments: tc.arguments ?? '',
      },
    }));
}

/**
 * runAgentLoop — Point d'entrée principal
 *
 * @param {object} params
 * @param {import('express').Response} params.res         — réponse SSE Express
 * @param {object[]}                  params.messages     — historique OpenAI
 * @param {string}                    params.model        — model string OpenRouter
 * @param {string}                    params.apiKey       — clé OpenRouter
 * @param {number}                    params.max_tokens
 * @param {number}                    params.temperature
 */
async function runAgentLoop({ res, messages, model, apiKey, max_tokens, temperature }) {
  const history = [...messages];

  let accumulatedContent = '';
  let roundCount         = 0;

  while (roundCount < MAX_TOOL_ROUNDS) {
    roundCount++;

    // ── Appel au modèle ────────────────────────────────────────────────────
    let response;
    try {
      response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'https://nerosia.app',
          'X-Title':       'Nerosia',
        },
        body: JSON.stringify({
          model,
          messages:    history,
          tools:       TOOLS,
          tool_choice: 'auto',
          stream:      true,
          max_tokens,
          temperature,
        }),
      });
    } catch (fetchErr) {
      sendSSE(res, { type: 'error', message: `Erreur réseau : ${fetchErr.message}` });
      return;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      sendSSE(res, { type: 'error', message: `Erreur OpenRouter ${response.status}: ${errText}` });
      return;
    }

    // ── Lecture du stream ──────────────────────────────────────────────────
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    let roundContent = '';
    let toolCallsAcc = [];
    let finishReason = null;

    const flush = async () => {
      const lines = buffer.split('\n');
      buffer      = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;

        let delta;
        try { delta = JSON.parse(raw)?.choices?.[0]; } catch { continue; }
        if (!delta) continue;

        finishReason = delta.finish_reason ?? finishReason;

        if (delta.delta?.content) {
          roundContent       += delta.delta.content;
          accumulatedContent += delta.delta.content;
          sendSSE(res, { type: 'chunk', content: accumulatedContent });
        }

        if (delta.delta?.tool_calls) {
          for (const tc of delta.delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCallsAcc[i]) toolCallsAcc[i] = { id: '', name: '', arguments: '' };
            if (tc.id)                  toolCallsAcc[i].id        += tc.id;
            if (tc.function?.name)      toolCallsAcc[i].name      += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[i].arguments += tc.function.arguments;
          }
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await flush();
    }
    buffer += decoder.decode();
    await flush();

    const toolCalls = mergeToolCallDeltas(toolCallsAcc);

    // ── Ajouter le message assistant dans l'historique ─────────────────────
    const assistantMsg = {
      role:    'assistant',
      content: roundContent || null,
    };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    history.push(assistantMsg);

    // ── Pas de tool call → réponse finale ─────────────────────────────────
    if (toolCalls.length === 0) break;

    // ── Exécution des tools ────────────────────────────────────────────────
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}

      // ── execute_code ───────────────────────────────────────────────────
      if (tc.function.name === 'execute_code') {
        const lang = args.language    ?? 'python';
        const desc = args.description ?? `Exécution ${lang}`;

        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind:     'execute_code',
            status:   'running',
            language: lang,
            label:    desc,
            code:     args.code ?? '',
          },
        });

        const result = await executeCode(lang, args.code ?? '');
        const ok     = result.exit_code === 0;

        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind:      'execute_code',
            status:    ok ? 'done' : 'error',
            language:  lang,
            label:     desc,
            stdout:    result.stdout,
            stderr:    result.stderr,
            exit_code: result.exit_code,
          },
        });

        history.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      JSON.stringify({
            stdout:    result.stdout,
            stderr:    result.stderr,
            exit_code: result.exit_code,
            hint: ok
              ? 'Exécution réussie.'
              : 'Erreur détectée. Corrige le code et rappelle execute_code.',
          }),
        });

      // ── edit_file ──────────────────────────────────────────────────────
      } else if (tc.function.name === 'edit_file') {
        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind:        'edit_file',
            status:      'done',
            filename:    args.filename    ?? '',
            old_str:     args.old_str     ?? '',
            new_str:     args.new_str     ?? '',
            description: args.description ?? '',
            label:       `Patch : ${args.filename} — ${args.description}`,
          },
        });

        history.push({
          role:         'tool',
          tool_call_id: tc.id,
          content:      JSON.stringify({ status: 'patch_applied', filename: args.filename }),
        });
      }
    }
  }

  sendSSE(res, { type: 'done', modelUsed: model });
}

module.exports = { runAgentLoop, needsAgentLoop };
