// ─────────────────────────────────────────────────────────────────────────────
// src/agents/searchRouter.js — Recherche systématique avant chaque requête LLM
// Comportement : comme Perplexity — toujours chercher d'abord, puis répondre.
// ─────────────────────────────────────────────────────────────────────────────

const { runSearchAgent } = require('./searchAgents');

// ── Timeout global pour la recherche (ms) ────────────────────────────────────
const SEARCH_TIMEOUT_MS = 12000;

// ── Requêtes qui ne nécessitent PAS de recherche web ─────────────────────────
// Normalise les accents pour matcher "resume", "résume", "reformule", etc.
const NO_SEARCH_PATTERNS = [
  /^(bonjour|salut|hello|hi|hey|bonsoir|coucou)\b/i,
  /^(merci|thanks|thank you)\b/i,
  /^\d[\d\s+\-*/^().,]*$/,                                          // calcul pur
  /^(resumes?|reformule|traduis|corrige|ameliore|resume)\s/i,        // sans accents
  /^(r[eé]sum[eé]|r[eé]formule|traduis|corrige|am[eé]liore)\s/i,    // avec accents
  /^(continue|vas-y|ok|oui|non|d'accord)\b/i,
  /^(quel est ton nom|qui es-tu|tu es qui|what are you)\b/i,
];

// ── Normalise une string (minuscules + sans accents) ──────────────────────────
function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function needsSearch(query) {
  // Validation stricte du type
  if (!query || typeof query !== 'string') return false;

  const q = query.trim();
  if (q.length < 8) return false;

  // Tester sur la version normalisée (sans accents) ET originale
  const qNorm = normalize(q);
  return !NO_SEARCH_PATTERNS.some(re => re.test(q) || re.test(qNorm));
}

// ── withSearch ────────────────────────────────────────────────────────────────
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

  // Validation query
  if (!query || typeof query !== 'string') {
    console.warn('[SearchRouter] Query invalide:', query);
    return { messages: Array.isArray(messages) ? messages : [], searchResult: null };
  }

  // Validation messages
  const safeMessages = Array.isArray(messages) ? messages : [];

  // 1. Vérifier si la recherche est pertinente
  if (skipSearch || !needsSearch(query)) {
    return { messages: safeMessages, searchResult: null };
  }

  // 2. Lancer la recherche avec timeout global
  let searchResult = null;
  try {
    searchResult = await Promise.race([
      runSearchAgent(query, forceAgent),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout recherche après ${SEARCH_TIMEOUT_MS}ms`)), SEARCH_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    console.warn('[SearchRouter] Recherche échouée:', err.message);
    return { messages: safeMessages, searchResult: null };
  }

  // 3. Callback optionnel (ex: afficher "🔍 5 sources trouvées" dans l'UI)
  if (onSearchDone && searchResult) {
    try {
      onSearchDone(searchResult);
    } catch (err) {
      console.warn('[SearchRouter] onSearchDone callback error:', err.message);
    }
  }

  // 4. Pas de résultats → passer sans contexte
  if (!searchResult?.contextBlock) {
    return { messages: safeMessages, searchResult };
  }

  // 5. Injecter le contexte de recherche dans les messages
  const enrichedMessages = injectSearchContext(safeMessages, query, searchResult.contextBlock);

  return { messages: enrichedMessages, searchResult };
}

// ── injectSearchContext ───────────────────────────────────────────────────────
/**
 * Injecte le bloc de recherche dans l'historique.
 * Stratégie : enrichir le dernier message user en préservant
 * le format original (string OU array multipart).
 */
function injectSearchContext(messages, query, contextBlock) {
  const copy = messages.map(m => ({ ...m }));

  // Trouver le dernier message utilisateur
  const lastUserIdx = copy.findLastIndex
    ? copy.findLastIndex(m => m.role === 'user')                  // Node 18+
    : copy.map(m => m.role).lastIndexOf('user');                  // fallback

  if (lastUserIdx === -1) {
    // Pas de message user trouvé → ajouter directement
    copy.push({ role: 'user', content: `${query}${contextBlock}` });
    return copy;
  }

  const lastUser = copy[lastUserIdx];

  if (typeof lastUser.content === 'string') {
    // Cas simple : content string
    copy[lastUserIdx] = {
      ...lastUser,
      content: `${lastUser.content}${contextBlock}`,
    };
  } else if (Array.isArray(lastUser.content)) {
    // Cas multipart : trouver le bloc texte et l'enrichir
    // sans détruire les autres blocs (images, documents, etc.)
    const newBlocks = lastUser.content.map(block => {
      if (block.type === 'text') {
        return { ...block, text: `${block.text}${contextBlock}` };
      }
      return block; // image, document, etc. → préservés tels quels
    });

    // Si aucun bloc texte n'existait, en ajouter un
    const hasTextBlock = lastUser.content.some(b => b.type === 'text');
    if (!hasTextBlock) {
      newBlocks.push({ type: 'text', text: contextBlock });
    }

    copy[lastUserIdx] = { ...lastUser, content: newBlocks };
  } else {
    // Fallback : format inconnu → forcer string
    console.warn('[SearchRouter] Format content inconnu, fallback string:', typeof lastUser.content);
    copy[lastUserIdx] = {
      ...lastUser,
      content: `${query}${contextBlock}`,
    };
  }

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
