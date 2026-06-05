// ─────────────────────────────────────────────────────────────────────────────
// src/agents/searchRouter.js — Recherche systématique avant chaque requête LLM
// Comportement : comme Perplexity — toujours chercher d'abord, puis répondre.
// ─────────────────────────────────────────────────────────────────────────────

const { runSearchAgent } = require('./searchAgents');

// ── Requêtes qui ne nécessitent PAS de recherche web ─────────────────────────
// (maths pures, demandes de reformulation, salutations, etc.)

const NO_SEARCH_PATTERNS = [
  /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\b/i,
  /^(merci|thanks|thank you)\b/i,
  /^\d[\d\s+\-*/^().,]*$/,                        // calcul pur
  /^(résume|reformule|traduis|corrige|améliore)\s/i, // action sur texte fourni
  /^(continue|vas-y|ok|oui|non|d'accord)\b/i,
  /^(quel est ton nom|qui es-tu|tu es qui|what are you)\b/i,
];

function needsSearch(query) {
  const q = query.trim();
  if (q.length < 8) return false; // trop court
  return !NO_SEARCH_PATTERNS.some(re => re.test(q));
}

// ── Injection du contexte de recherche dans les messages ──────────────────────

/**
 * withSearch(query, messages, options)
 *
 * Ajoute automatiquement les résultats de recherche au contexte
 * avant d'appeler le LLM.
 *
 * @param {string}   query        - La question de l'utilisateur
 * @param {Array}    messages     - Historique de conversation [{role, content}]
 * @param {object}   options
 * @param {string}   [options.forceAgent]   - Forcer un agent ('web','image','academic',...)
 * @param {boolean}  [options.skipSearch]   - Désactiver la recherche pour ce tour
 * @param {function} [options.onSearchDone] - Callback appelé après la recherche
 *                                            ({agent, sources, thinkingLabel})
 *
 * @returns {{ messages: Array, searchResult: object|null }}
 */
async function withSearch(query, messages, options = {}) {
  const { forceAgent, skipSearch = false, onSearchDone } = options;

  // 1. Vérifier si la recherche est pertinente
  if (skipSearch || !needsSearch(query)) {
    return { messages, searchResult: null };
  }

  // 2. Lancer la recherche en parallèle (non-bloquant côté perf)
  let searchResult = null;
  try {
    searchResult = await runSearchAgent(query, forceAgent);
  } catch (err) {
    console.warn('[SearchRouter] Recherche échouée:', err.message);
    return { messages, searchResult: null };
  }

  // 3. Callback optionnel (ex: afficher "🔍 5 sources trouvées" dans l'UI)
  if (onSearchDone && searchResult) {
    try { onSearchDone(searchResult); } catch {}
  }

  // 4. Pas de résultats → passer sans contexte
  if (!searchResult?.contextBlock) {
    return { messages, searchResult };
  }

  // 5. Injecter le contexte de recherche dans les messages
  //    On l'ajoute comme dernier message "user" juste avant la requête réelle,
  //    de façon transparente pour le LLM.
  const enrichedMessages = injectSearchContext(messages, query, searchResult.contextBlock);

  return { messages: enrichedMessages, searchResult };
}

/**
 * Injecte le bloc de recherche dans l'historique.
 * Stratégie : remplacer le dernier message user par une version enrichie.
 */
function injectSearchContext(messages, query, contextBlock) {
  const copy = messages.map(m => ({ ...m }));

  // Trouver le dernier message utilisateur
  const lastUserIdx = copy.map(m => m.role).lastIndexOf('user');

  if (lastUserIdx === -1) {
    // Pas de message user trouvé → ajouter directement
    copy.push({
      role: 'user',
      content: `${query}${contextBlock}`,
    });
    return copy;
  }

  // Enrichir le dernier message user avec le contexte
  const lastUser = copy[lastUserIdx];
  const originalContent = typeof lastUser.content === 'string'
    ? lastUser.content
    : lastUser.content?.find?.(b => b.type === 'text')?.text ?? query;

  copy[lastUserIdx] = {
    ...lastUser,
    content: `${originalContent}${contextBlock}`,
  };

  return copy;
}

// ── Système prompt recommandé pour mode Perplexity ────────────────────────────

const PERPLEXITY_SYSTEM_PROMPT = `Tu es un assistant de recherche intelligent. 
Pour chaque réponse :
- Utilise les sources fournies dans le contexte pour répondre avec des informations à jour.
- Cite chaque fait important avec [numéro] en référence aux sources.
- Si les sources sont insuffisantes, complète avec tes connaissances en le précisant.
- Sois factuel, concis et cite toujours tes sources.
- À la fin de ta réponse, liste les sources utilisées sous forme "Sources : [1] titre — url".`;

module.exports = { withSearch, needsSearch, PERPLEXITY_SYSTEM_PROMPT };
