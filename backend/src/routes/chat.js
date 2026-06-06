const express = require('express');
const router  = express.Router();
const { openRouterFetch }               = require('../openrouter');
const { getSystemPrompt }               = require('../prompts');
const { runSearchAgent }                = require('../agents/searchAgents');
const { runCodePipeline, needsCodePipeline } = require('../agents/codeAgents');

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
  const count = sources.length;
  const label = getAgentLabel(agent);
  const titles = sources
    .slice(0, 3)
    .map(s => `• ${s.title.slice(0, 60)}${s.title.length > 60 ? '…' : ''}`)
    .join('\n');
  return `J'ai trouvé ${count} ${label} :\n${titles}${count > 3 ? `\n• … et ${count - 3} de plus` : ''}\n\nJe synthétise maintenant…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTION PRINCIPALE : Gestion du streaming de blocs de code
//
// Problème original :
//   onChunk envoie le contenu accumulé à chaque token. Quand la réponse contient
//   un bloc ``` ... ```, le frontend reçoit des chunks où le ``` fermant n'est
//   pas encore arrivé → extractStreamingFiles() ne peut pas marquer done:true.
//   L'artefact reste bloqué en "refresh-cw" et affiche le code en bloc brut.
//
// Solution :
//   On distingue deux modes d'envoi :
//   1. HORS bloc code    → envoi immédiat chunk par chunk (réactivité maximale)
//   2. DANS un bloc code → on bufferise et on n'envoie QU'AU MOMENT où le bloc
//      est fermé (``` de fermeture détecté). Cela garantit que le frontend
//      reçoit toujours des blocs complets → done:true systématiquement.
//
//   Exception : si le modèle est encore en train d'écrire et qu'on veut quand
//   même afficher la progression, on envoie un "chunk preview" sans le bloc
//   incomplet, et on re-envoie avec le bloc complet une fois fermé.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retourne true si le texte contient au moins un bloc ``` ouvert non fermé.
 * Un bloc ouvert = un ``` suivi d'un nom de langage + contenu, sans ``` de fermeture.
 */
function hasOpenCodeBlock(text) {
  // Retire tous les blocs fermés
  const withoutClosed = text.replace(/```[^\n`]*\n[\s\S]*?```/g, '');
  // S'il reste un ``` orphelin avec du contenu
  return /```[^\n`]+\n[\s\S]+$/.test(withoutClosed);
}

/**
 * Retourne le texte sans le dernier bloc de code ouvert (pour envoi partiel).
 * Permet d'afficher le texte qui précède le bloc en cours de génération.
 */
function stripLastOpenBlock(text) {
  // Trouve la position du dernier ``` ouvrant sans fermeture
  const withoutClosed = text.replace(/```[^\n`]*\n[\s\S]*?```/g, (m) => '\x00'.repeat(m.length));
  const openIdx = withoutClosed.search(/```[^\n`]+\n[\s\S]+$/);
  if (openIdx === -1) return text;
  return text.slice(0, openIdx).trimEnd();
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

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  try {
    // ── Pipeline code (deep research) ────────────────────────────────────────
    if (deepResearch && needsCodePipeline(message)) {
      await runCodePipeline(message, (agentSteps) => {
        send({ type: 'pipeline', steps: agentSteps });
      }).then(result => {
        send({ type: 'codeResult', result });
        done();
      });
      return;
    }

    // ── Recherche systématique ────────────────────────────────────────────────
    let systemContext = '';
    let sources       = [];

    if (needsSearch(message)) {

      send({
        type:   'searching',
        status: 'loading',
        label:  'Recherche en cours…',
        icon:   'globe',
      });

      try {
        const searchResult = await runSearchAgent(message);

        if (searchResult?.sources?.length > 0 || searchResult?.images?.length > 0) {
          sources       = searchResult.sources;
          systemContext = searchResult.contextBlock;

          if (sources.length > 0) {
            send({ type: 'sources', sources, agent: searchResult.agent });
          }

          if (searchResult.images?.length > 0) {
            send({ type: 'images', images: searchResult.images });
          }

          const summary = buildSearchSummary(searchResult);
          send({
            type:   'searching',
            status: 'done',
            label:  summary,
            icon:   'globe',
            count:  sources.length,
            agent:  searchResult.agent,
          });

        } else {
          send({
            type:   'searching',
            status: 'done',
            label:  'Aucun résultat trouvé — je réponds avec mes connaissances.',
            icon:   'globe',
          });
        }

      } catch (err) {
        console.warn('[chat] Recherche échouée :', err.message);
        send({
          type:   'searching',
          status: 'error',
          label:  'Recherche indisponible — réponse directe.',
          icon:   'globe',
        });
      }
    }

    // ── Construction du prompt ────────────────────────────────────────────────
    const systemPrompt = getSystemPrompt(message, systemContext || undefined);

    const previousMessages = (history ?? [])
      .filter(m => m.role && m.content)
      .map(m => ({ role: m.role, content: m.content }));

    // ── Appel LLM en streaming ────────────────────────────────────────────────
    let streamedContent    = '';
    let lastSentContent    = ''; // dernier contenu envoyé au frontend
    let codeBlockOpen      = false; // true = on est dans un bloc ``` non fermé

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
        streamedContent = chunk;

        // ── Gestion du bloc <thinking> ────────────────────────────────────
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

        if (!streamedContent.includes('</thinking>')) return;

        // ── Nettoyage du bloc thinking ────────────────────────────────────
        let displayContent = streamedContent
          .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
          .trimStart();

        if (!displayContent) return;

        // ── CORRECTION : gestion des blocs de code ouverts ────────────────
        //
        // Si le contenu contient un bloc ``` non fermé :
        //   → on envoie uniquement la partie AVANT le bloc ouvert (texte pur)
        //   → le bloc lui-même sera envoyé une seule fois, complet, quand
        //     le ``` de fermeture arrivera
        //
        // Si le contenu ne contient PAS de bloc ouvert (tout est fermé) :
        //   → envoi normal du contenu complet
        //
        if (hasOpenCodeBlock(displayContent)) {
          codeBlockOpen = true;

          // Envoie la partie avant le bloc ouvert (texte intro, etc.)
          const textBeforeBlock = stripLastOpenBlock(displayContent);
          if (textBeforeBlock && textBeforeBlock !== lastSentContent) {
            lastSentContent = textBeforeBlock;
            send({ type: 'chunk', content: textBeforeBlock });
          }
          // On N'ENVOIE PAS le bloc incomplet → le frontend ne verra jamais
          // un bloc à moitié écrit
        } else {
          // Tous les blocs sont fermés (ou pas de blocs du tout)
          if (codeBlockOpen || displayContent !== lastSentContent) {
            codeBlockOpen   = false;
            lastSentContent = displayContent;
            send({ type: 'chunk', content: displayContent });
          }
        }
      },
    });

    // ── Envoi final garanti : s'assure que le contenu complet est bien envoyé
    // même si le dernier chunk n'a pas déclenché un envoi (ex: fin de stream
    // avec un bloc qui se ferme exactement au dernier token)
    const finalDisplay = streamedContent
      .replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '')
      .trimStart();

    if (finalDisplay && finalDisplay !== lastSentContent) {
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

// ─────────────────────────────────────────────────────────────────────────────

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

module.exports = router;
