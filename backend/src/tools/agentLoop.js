'use strict';

// ─── Imports ──────────────────────────────────────────────────────────────────

const { executeCode, installPackage } = require('../sandbox');
const { TOOLS }                       = require('./definitions');
const { getSystemPrompt }             = require('../prompts');
const { getAvailableKeys, OPENROUTER_MODELS } = require('../openrouter');

// ─── Configuration ────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 5;
const IS_PROD         = process.env.NODE_ENV === 'production';

const THINKING_OPEN  = '<thinking>';
const THINKING_CLOSE = '</thinking>';

// ─── Whitelist packages autorisés ─────────────────────────────────────────────

const ALLOWED_PACKAGES = new Set([
  'numpy', 'pandas', 'matplotlib', 'scipy', 'scikit-learn',
  'requests', 'pillow', 'flask', 'fastapi', 'uvicorn',
  'sqlalchemy', 'pydantic', 'httpx', 'beautifulsoup4', 'lxml',
  'lodash', 'axios', 'express', 'dotenv', 'dayjs', 'uuid',
  'zod', 'chalk', 'commander', 'fs-extra', 'csv-parser',
]);

const KNOWN_TOOLS = new Set(['execute_code', 'install_package', 'edit_file']);

// ─── Patterns déclencheurs ────────────────────────────────────────────────────

const AGENT_LOOP_PATTERNS = [
  /\bexécute?\b/i, /\blance\b/i, /\bcalcule?\b/i, /\bteste?\b/i,
  /\bécris?\s+(un|le|du)?\s*code\b/i, /\bfais\s+tourner\b/i,
  /\brun\b/i, /\bscript\b/i, /\bprogramme?\b/i,
  /\bgenère?\s+(un|le|du)?\s*(fichier|code|script|projet|app)\b/i,
  /\bcrée?\s+(un|le|du)?\s*(fichier|code|script|projet|app)\b/i,
  /\bmodifie?\s+(le|ce|mon)?\s*fichier\b/i,
  /\bedit[_\s]file\b/i, /\binstall\b/i, /\bnpm\b/i, /\bpip\b/i,
];

function needsAgentLoop(query) {
  return AGENT_LOOP_PATTERNS.some(re => re.test(query.trim()));
}

// ─── Utilitaires nommage ──────────────────────────────────────────────────────

const LANG_FILENAME_MAP = {
  html: 'index.html', css: 'styles.css', javascript: 'script.js', js: 'script.js',
  typescript: 'index.ts', ts: 'index.ts', jsx: 'App.jsx', tsx: 'App.tsx',
  python: 'main.py', py: 'main.py', java: 'Main.java', kotlin: 'Main.kt',
  go: 'main.go', rust: 'main.rs', cpp: 'main.cpp', c: 'main.c',
  bash: 'script.sh', sh: 'script.sh', json: 'data.json', sql: 'query.sql',
};

const LANG_LABEL_MAP = {
  html: 'Page HTML', css: 'Styles CSS', javascript: 'Script JavaScript', js: 'Script JavaScript',
  typescript: 'TypeScript', python: 'Script Python', py: 'Script Python',
  json: 'Données JSON', bash: 'Script shell', sh: 'Script shell',
  java: 'Classe Java', go: 'Go', rust: 'Rust',
};

function defaultFilename(lang) {
  return LANG_FILENAME_MAP[lang.toLowerCase()] ?? `code.${lang.toLowerCase()}`;
}

function langLabel(lang) {
  return LANG_LABEL_MAP[lang.toLowerCase()] ?? lang.toUpperCase();
}

// ─── Helpers SSE ──────────────────────────────────────────────────────────────

function sendSSE(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}

// ─── stripThinking + isPotentialTag ──────────────────────────────────────────

function stripThinking(content) {
  if (content.includes(THINKING_CLOSE))
    return content.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trimStart();
  const idx = content.indexOf(THINKING_OPEN);
  if (idx !== -1) return content.slice(0, idx).trimEnd();
  return content;
}

function isPotentialTag(str, tag) {
  for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
    if (str.endsWith(tag.slice(0, len))) return true;
  }
  return false;
}

// ─── Rotation des clés API ────────────────────────────────────────────────────

let keyIndex = 0;

function getNextApiKey() {
  const keys = getAvailableKeys();
  if (!keys || keys.length === 0) throw new Error('Aucune clé OpenRouter disponible');
  const key = keys[keyIndex % keys.length];
  keyIndex  = (keyIndex + 1) % keys.length;
  return key;
}

function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.find(b => b.type === 'text')?.text ?? '';
  return '';
}

function resolveModel(tier) {
  return OPENROUTER_MODELS[tier] ?? OPENROUTER_MODELS.sonnet;
}

function mergeToolCallDeltas(toolCallsAcc) {
  return toolCallsAcc
    .filter(Boolean)
    .map(tc => ({
      id:       tc.id       ?? '',
      type:     'function',
      function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
    }));
}

// ─── Appel LLM avec streaming thinking en temps réel ─────────────────────────
//
// streamToClient: true  → thinking + contenu streamés en temps réel vers le client
//                         (même logique que chat.js : onChunk/onReasoningChunk)
// streamToClient: false → silencieux, retourne juste { content, reasoning, toolCalls }

async function callModel({ res, messages, tier, max_tokens, temperature, streamToClient = false }) {
  const model  = resolveModel(tier);
  const apiKey = getNextApiKey();

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'HTTP-Referer':  'https://nerosia.app',
      'X-Title':       'Nerosia',
    },
    body: JSON.stringify({
      model, messages, tools: TOOLS, tool_choice: 'auto',
      stream: true, max_tokens, temperature,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter ${response.status}: ${errText}`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer    = '';
  let content      = '';
  let reasoning    = '';
  let toolCallsAcc = [];

  // État streaming thinking (identique à chat.js)
  let accContent          = '';
  let accReasoning        = '';
  let lastSentThinkingLen = 0;
  let thinkingDone        = false;

  const flushSSE = () => {
    const lines = sseBuffer.split('\n');
    sseBuffer   = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }

      if (parsed?.error) throw new Error(parsed.error?.message ?? 'Provider error in stream');

      const delta = parsed?.choices?.[0]?.delta;
      if (!delta) continue;

      // ── Reasoning (owl-alpha envoie tout ici) ──────────────────────────
      if (delta.reasoning) {
        reasoning    += delta.reasoning;
        accReasoning += delta.reasoning;
        if (streamToClient) {
          sendSSE(res, { type: 'thinking', content: delta.reasoning });
        }
      }

      // ── Content ────────────────────────────────────────────────────────
      if (delta.content) {
        content    += delta.content;
        accContent += delta.content;

        if (streamToClient) {
          const openIdx  = accContent.indexOf(THINKING_OPEN);
          const closeIdx = accContent.indexOf(THINKING_CLOSE);
          const hasOpen  = openIdx  !== -1;
          const hasClose = closeIdx !== -1;

          // Thinking en cours
          if (hasOpen && !hasClose) {
            const before = accContent.slice(0, openIdx).trimEnd();
            if (before) sendSSE(res, { type: 'replace', content: before });
            const thinkingFull  = accContent.slice(openIdx + THINKING_OPEN.length);
            const thinkingDelta = thinkingFull.slice(lastSentThinkingLen);
            if (thinkingDelta) {
              sendSSE(res, { type: 'thinking', content: thinkingDelta });
              lastSentThinkingLen = thinkingFull.length;
            }
            continue;
          }

          // Thinking fermé
          if (hasOpen && hasClose && !thinkingDone) {
            thinkingDone = true;
            const thinkingFull  = accContent.slice(openIdx + THINKING_OPEN.length, closeIdx);
            const thinkingDelta = thinkingFull.slice(lastSentThinkingLen);
            if (thinkingDelta) {
              sendSSE(res, { type: 'thinking', content: thinkingDelta });
              lastSentThinkingLen = thinkingFull.length;
            }
          }

          // Buffer si tag partiel
          if (!hasOpen && isPotentialTag(accContent, THINKING_OPEN)) continue;
          if (!hasClose && hasOpen && isPotentialTag(accContent, THINKING_CLOSE)) continue;

          // Contenu visible
          const displayContent = stripThinking(accContent);
          if (displayContent) sendSSE(res, { type: 'replace', content: displayContent });
        }
      }

      // ── Tool calls ─────────────────────────────────────────────────────
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
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
    sseBuffer += decoder.decode(value, { stream: true });
    flushSSE();
  }
  sseBuffer += decoder.decode();
  flushSSE();

  // Flush final visible
  if (streamToClient) {
    let finalContent = stripThinking(accContent);
    if (!finalContent.trim() && accReasoning.trim()) finalContent = accReasoning;
    if (finalContent.trim()) sendSSE(res, { type: 'replace', content: finalContent });
  }

  return { content, reasoning, toolCalls: mergeToolCallDeltas(toolCallsAcc) };
}

// ─── Phase 1 : Plan (silencieux, JSON pur) ────────────────────────────────────

const PLAN_SYSTEM = `Tu es un assistant expert en développement logiciel.
Quand l'utilisateur te demande de créer un projet ou du code, tu réponds UNIQUEMENT avec un JSON structuré (sans markdown) :
{
  "summary": "Description courte du projet",
  "architecture": [
    { "filename": "index.html", "description": "Page principale", "language": "html" },
    { "filename": "styles.css", "description": "Styles CSS",      "language": "css"  },
    { "filename": "script.js",  "description": "Logique JS",      "language": "javascript" }
  ],
  "packages": [],
  "steps": ["Créer index.html", "Ajouter styles.css", "Écrire script.js"]
}
RÈGLE ABSOLUE : utilise toujours de vrais noms de fichiers. Jamais "code.html", "code.js", "code.python".`;

async function runPlanPhase({ res, userMessage, history, tier, temperature }) {
  // Un seul step statique pendant que le modèle génère du JSON (pas de prose à streamer)
  sendSSE(res, {
    type: 'thinkingSteps',
    steps: [{ label: 'Analyse de votre demande…', icon: 'search', done: false }],
  });

  const { content } = await callModel({
    res,
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      ...history.slice(-6),
      { role: 'user', content: userMessage },
    ],
    tier: tier === 'opus' ? 'opus' : 'sonnet',
    max_tokens: 2048, temperature: 0.2,
    streamToClient: false,
  });

  let plan;
  try {
    plan = JSON.parse(content.replace(/```json|```/g, '').trim());
  } catch {
    plan = { summary: 'Génération du code demandé', architecture: [], packages: [], steps: ['Générer le code'] };
  }

  sendSSE(res, {
    type: 'thinkingSteps',
    steps: [{ label: `Plan établi — ${plan.summary}`, icon: 'done', done: true }],
  });

  sendSSE(res, {
    type: 'agent_phase', phase: 'plan', plan,
    thinking: { label: `Plan établi — ${plan.summary}`, icon: 'done', done: true },
    architecture: plan.architecture ?? [],
    steps:        plan.steps        ?? [],
    packages:     plan.packages     ?? [],
  });

  return plan;
}

// ─── Phase 2 : Création (l'IA écrit librement, thinking streamé) ──────────────

async function runCreatePhase({ res, userMessage, history, tier, plan, max_tokens, temperature }) {
  const systemPrompt = getSystemPrompt(userMessage, undefined);

  const architectureHint = plan.architecture?.length > 0
    ? `\n\nFichiers à créer :\n${plan.architecture.map(f => `- ${f.filename} : ${f.description}`).join('\n')}`
    : '';
  const packagesHint = plan.packages?.length > 0
    ? `\n\nPackages à installer : ${plan.packages.join(', ')}`
    : '';

  const createSystemPrompt =
    systemPrompt +
    `\n\nTu es en phase de CRÉATION. Utilise les tools pour :\n` +
    `1. Installer les packages avec install_package\n` +
    `2. Créer/tester le code avec execute_code\n` +
    `Annonce chaque fichier avec son vrai nom. Si une exécution échoue, corrige et recommence.\n` +
    architectureHint + packagesHint;

  const messages = [
    { role: 'system', content: createSystemPrompt },
    ...history.slice(-6),
    { role: 'user', content: userMessage },
  ];

  const createdFiles = new Map();
  let   roundCount   = 0;

  while (roundCount < MAX_TOOL_ROUNDS) {
    roundCount++;

    // streamToClient: true → l'IA écrit librement, thinking/contenu streamés en temps réel
    const { content, toolCalls } = await callModel({
      res, messages, tier, max_tokens, temperature,
      streamToClient: true,
    });

    const assistantMsg = { role: 'assistant', content: content || null };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    messages.push(assistantMsg);

    // Extraction fichiers depuis blocs markdown
    if (content) {
      for (const m of content.matchAll(/```([^\n`]+)\n([\s\S]*?)```/g)) {
        const lang = m[1].trim().toLowerCase();
        const code = m[2];
        const precedingText = content.slice(0, m.index);
        const nameMatch = precedingText.match(
          /(?:fichier|file|créer?|écrire?|voici|`)\s*[`"]?([^\s`"']+\.[a-zA-Z0-9]+)[`"]?\s*(?::|–|-)?/i
        );
        const filename =
          nameMatch?.[1] ??
          plan.architecture?.find(f =>
            f.language === lang || f.filename.toLowerCase().endsWith(`.${lang}`)
          )?.filename ??
          defaultFilename(lang);

        createdFiles.set(filename, { filename, language: lang, content: code });

        sendSSE(res, {
          type: 'agent_phase', phase: 'file_created',
          thinking: { label: `${filename} — ${langLabel(lang)}`, icon: 'file', done: true },
          file: { filename, language: lang, content: code },
        });
      }
    }

    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      if (!KNOWN_TOOLS.has(tc.function.name)) {
        console.warn('[agentLoop] Tool inconnu ignoré :', tc.function.name);
        continue;
      }

      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}

      // ── execute_code ──────────────────────────────────────────────────
      if (tc.function.name === 'execute_code') {
        const lang = args.language    ?? 'python';
        const desc = args.description ?? `Exécution ${lang}`;

        sendSSE(res, {
          type: 'tool_step',
          step: { kind: 'execute_code', status: 'running', language: lang, label: desc, code: args.code ?? '' },
        });

        const codeFilename =
          plan.architecture?.find(f =>
            f.language === lang || f.filename.toLowerCase().endsWith(`.${lang}`)
          )?.filename ?? defaultFilename(lang);

        if (args.code) {
          createdFiles.set(codeFilename, { filename: codeFilename, language: lang, content: args.code });
        }

        const execResult = await executeCode(lang, args.code ?? '');
        const ok         = execResult.exit_code === 0;

        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind: 'execute_code', status: ok ? 'done' : 'error',
            language: lang, label: desc,
            stdout: execResult.stdout, stderr: execResult.stderr, exit_code: execResult.exit_code,
          },
        });

        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({
            stdout: execResult.stdout, stderr: execResult.stderr, exit_code: execResult.exit_code,
            hint: ok ? 'Exécution réussie.' : 'Erreur détectée. Corrige le code et rappelle execute_code.',
          }),
        });

      // ── install_package ───────────────────────────────────────────────
      } else if (tc.function.name === 'install_package') {
        const pkgName = (args.package ?? '').trim().toLowerCase();
        const mgr     = args.manager ?? 'pip';

        if (!ALLOWED_PACKAGES.has(pkgName)) {
          console.warn('[agentLoop] Package refusé :', pkgName);
          messages.push({
            role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify({ status: 'error', error: `Package "${pkgName}" non autorisé.` }),
          });
          continue;
        }

        sendSSE(res, {
          type: 'tool_step',
          step: { kind: 'install_package', status: 'running', package: pkgName, manager: mgr, label: `Installation de ${pkgName}…` },
        });

        const installResult = await installPackage(pkgName, mgr);
        const ok            = installResult.exit_code === 0;

        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind: 'install_package', status: ok ? 'done' : 'error',
            package: pkgName, manager: mgr,
            label: `${pkgName} ${ok ? 'installé' : 'échec installation'}`,
            stdout: installResult.stdout, stderr: installResult.stderr, exit_code: installResult.exit_code,
          },
        });

        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({
            status: ok ? 'installed' : 'error', package: pkgName,
            stdout: installResult.stdout, stderr: installResult.stderr, exit_code: installResult.exit_code,
          }),
        });

      // ── edit_file ──────────────────────────────────────────────────────
      } else if (tc.function.name === 'edit_file') {
        sendSSE(res, {
          type: 'tool_step',
          step: {
            kind: 'edit_file', status: 'done',
            filename: args.filename ?? '', description: args.description ?? '',
            label: `Patch : ${args.filename} — ${args.description}`,
          },
        });

        const existing = createdFiles.get(args.filename);
        if (existing && args.old_str && args.new_str) {
          existing.content = existing.content.split(args.old_str).join(args.new_str);
          createdFiles.set(args.filename, existing);
        }

        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ status: 'patch_applied', filename: args.filename }),
        });
      }
    }
  }

  return { createdFiles: [...createdFiles.values()], finalMessages: messages };
}

// ─── Phase 3 : Résumé (streamé directement comme contenu visible) ─────────────

async function runSummaryPhase({ res, plan, createdFiles, messages, tier, temperature }) {
  const systemMsg = messages.find(m => m.role === 'system');
  const fileCount = createdFiles.length;

  await callModel({
    res,
    messages: [
      ...(systemMsg ? [systemMsg] : []),
      {
        role: 'user',
        content: `Le projet "${plan.summary}" est terminé. Donne un résumé court (3-5 lignes) : ce qui a été créé, comment l'utiliser, les points importants.`,
      },
    ],
    tier: tier === 'opus' ? 'opus' : 'sonnet',
    max_tokens: 512, temperature,
    streamToClient: true,
  });

  sendSSE(res, {
    type: 'agent_phase', phase: 'done',
    thinking: {
      label: `${fileCount} fichier${fileCount > 1 ? 's' : ''} créé${fileCount > 1 ? 's' : ''} avec succès`,
      icon: 'presentation', done: true,
    },
    files: createdFiles.map((f, i) => ({
      id: `af_${i}_${f.filename}`, filename: f.filename,
      language: f.language, content: f.content, done: true,
    })),
  });
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

async function runAgentLoop({ res, messages, model, max_tokens, temperature }) {
  const userMsgs = messages.filter(m => m.role !== 'system');
  const lastUser = [...userMsgs].reverse().find(m => m.role === 'user');

  const userMessage = extractTextContent(lastUser?.content);
  const history     = userMsgs.slice(0, -1);
  const tier        = model;

  try {
    const plan = await runPlanPhase({ res, userMessage, history, tier, temperature });

    const { createdFiles, finalMessages } = await runCreatePhase({
      res, userMessage, history, tier, plan, max_tokens, temperature,
    });

    await runSummaryPhase({
      res, plan, createdFiles, messages: finalMessages, tier, temperature,
    });

    sendSSE(res, { type: 'done', modelUsed: resolveModel(tier) });

  } catch (err) {
    console.error('[agentLoop] Erreur :', err.message);
    const safeMessage = IS_PROD ? 'Une erreur est survenue, réessaie.' : err.message;
    sendSSE(res, {
      type: 'agent_phase', phase: 'error',
      thinking: { label: `Erreur : ${safeMessage.slice(0, 80)}`, icon: 'error', done: true },
    });
    sendSSE(res, { type: 'error', message: safeMessage });
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { runAgentLoop, needsAgentLoop };
