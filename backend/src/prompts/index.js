// ─────────────────────────────────────────────────────────────────────────────
// src/prompts/index.js — Routeur de prompts Nerosia
// PRINCIPE : un prompt spécialisé est TOUJOURS injecté dès qu'un mot-clé
// correspond au message. Le prompt de base seul est utilisé uniquement
// si aucun mot-clé ne correspond (question générale hors matière).
// ─────────────────────────────────────────────────────────────────────────────

const { NEROSIA_SYSTEM_PROMPT }        = require('./base');
const { HORNER_PROMPT }                = require('./horner');
const { POLYNOME_PROMPT }              = require('./polynome');
const { EQUATION_PROMPT }              = require('./equation');
const { COMPLEXES_PROMPT }             = require('./complexes');
const { MATH_IRAT_IN_PROMPT }          = require('./mathIratIn');
const { MATH_IRAT_EQ_PROMPT }          = require('./mathIratEq');
const { MATH_BINOME_PROMPT }           = require('./mathBinome');
const { MATH_TRINOME_PROMPT }          = require('./mathTrinome');
const { MATH_QUOTIENT_PROMPT }         = require('./mathQuotient');
const { MATH_TRIG_INEGALITES_PROMPT }  = require('./mathTrigInegalites');
const { PHYSIQUE_PROMPT }              = require('./physique');
const { GEOMETRIE_PROMPT }             = require('./geometrie');
const { DISSERTATION_PROMPT }          = require('./dissertation');
const { DESIGN_PROMPT }                = require('./design');
const { PROGRAMMATION_PROMPT }         = require('./programmation');

// ── Arithmétique — 6 modules spécialisés ─────────────────────────────────────
const { ARITH_DIVISION_NUMERATION_PROMPT }          = require('./arith_division_numerations');
const { ARITH_MULTIPLES_DIVISEURS_PREMIERS_PROMPT } = require('./arith_multiples_diviseurs_premiers');
const { ARITH_CONGRUENCE_PROMPT }                   = require('./arith_congruence');
const { ARITH_EQUATIONS_ZNZ_PROMPT }                = require('./arith_equations_znz');
const { ARITH_PGCD_PPCM_PROMPT }                    = require('./arith_pgcd_ppcm');
const { ARITH_DIOPHANTIENNE_PROMPT }                = require('./arith_diophantienne');

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, "'");
}

function hasRacine(msg) {
  return msg.includes('√') || msg.includes('\\sqrt') || /racine\s*(carree|carrée|de|du)/.test(msg) || /sqrt\s*\(/.test(msg);
}
function hasEquation(msg) {
  return ['equation', 'resoudre', 'resous', 'resolvez', 'egal', 'trouver x', 'valeur de x'].some(k => msg.includes(k));
}
function hasInequation(msg) {
  return ['inequation', 'inegalite', 'inegalites', 'inequations'].some(k => msg.includes(k));
}
function hasSigneIneg(msg) {
  return ['≤', '≥', '<', '>'].some(k => msg.includes(k));
}
function hasFractionExpr(msg) {
  return /\([^)]+\)\s*[\/÷]\s*\([^)]+\)/.test(msg) || /[a-z0-9]\s*[\/÷]\s*\([^)]+\)/.test(msg) || /\([^)]+\)\s*[\/÷]\s*[a-z0-9]/.test(msg);
}
function hasEtudierSigne(msg) {
  return ['etudier le signe', 'signe de', 'etude du signe', 'signe d'].some(k => msg.includes(k));
}
function hasTrinomeExpr(msg) {
  return /x\s*\^?\s*2\b/.test(msg) || msg.includes('x²') || msg.includes('x^2');
}
function hasTrigInequality(msg, msgN) {
  const hasTrigFunc = /\bcos\s*x\b/.test(msg) || /\bsin\s*x\b/.test(msg) || /\btan\s*x\b/.test(msg);
  const hasTrigTerm = ['arccos','arcsin','arctan','2kπ','2k\\pi'].some(k => msg.includes(k)) || msgN.includes('trig');
  const hasIneq = hasSigneIneg(msg) || hasInequation(msgN);
  return (hasTrigFunc && hasIneq) || (hasTrigTerm && hasIneq);
}

// ── Détecteurs arithmétique ───────────────────────────────────────────────────

function hasArithDivisionNumeration(msgN) {
  const keywords = [
    'division euclidienne dans n', 'division euclidienne dans z',
    'trouver q et r', 'a = bq + r', 'quotient et reste',
    'base 2', 'base 3', 'base 8', 'base 16', 'base deux', 'base seize', 'base treize', 'base huit',
    'systeme binaire', 'systeme hexadecimal', 'systeme de numeration',
    'ecrire en base', 'convertir en base', 'developpement en base',
    'addition en base', 'multiplication en base', 'operation en base',
    'raisonnement par recurrence', 'principe de recurrence',
    'demontrer par recurrence', 'montrer par recurrence',
  ];
  return keywords.some(kw => msgN.includes(normalize(kw)));
}

function hasArithMultiplesDiviseursPremiers(msgN) {
  const keywords = [
    'multiple de', 'ensemble des multiples', 'az =', 'nz =',
    'diviseur de', 'ensemble des diviseurs', 'div(', 'd30', 'd12', 'd60',
    'nombre premier', 'nombres premiers', 'est-il premier', 'tester si premier',
    'crible d eratosthene', 'eratosthene',
  ];
  return keywords.some(kw => msgN.includes(normalize(kw)));
}

function hasArithCongruence(msgN, msg) {
  const keywords = [
    'congruence', 'congruent', 'congru',
    'z/nz', 'z/3z', 'z/4z', 'z/5z', 'z/6z', 'z/7z', 'z/9z', 'z/11z', 'z/12z', 'z/13z',
    'anneau integre', 'anneau commutatif', 'diviseur de zero',
    'classe modulo', 'classes d equivalence', 'ensemble quotient',
    'critere de divisibilite', 'divisible par 2', 'divisible par 3',
    'divisible par 4', 'divisible par 11',
    'periodicite des restes', 'restes successifs',
  ];
  const hasModulo = /\[\s*\d+\s*\]/.test(msg);   // ex: [7], [9], [11]
  return keywords.some(kw => msgN.includes(normalize(kw))) || hasModulo;
}

function hasArithEquationsZnZ(msgN) {
  const keywords = [
    'equation dans z/', 'resoudre dans z/', 'resoudre dans z/nz',
    'resoudre dans z/5z', 'resoudre dans z/6z', 'resoudre dans z/7z',
    'resoudre dans z/13z',
    'equation du second degre dans z/', 'systeme dans z/',
    'systeme d equations dans z/', 'inverse dans z/', 'element inversible',
  ];
  return keywords.some(kw => msgN.includes(normalize(kw)));
}

function hasArithPgcdPpcm(msgN) {
  const keywords = [
    'pgcd', 'ppcm', 'plus grand commun diviseur', 'plus petit commun multiple',
    'algorithme d euclide', 'algorithme de euclide',
    'nombres etrangers', 'premiers entre eux',
    'bezout', 'theoreme de bezout', 'identite de bezout',
    'theoreme de gauss', 'decomposition en facteurs premiers',
    'decomposer en produit de facteurs', 'formule du binome', 'binome de newton',
    'trouver les couples', 'tous les couples tels que pgcd',
    'relation pgcd ppcm',
  ];
  return keywords.some(kw => msgN.includes(normalize(kw)));
}

function hasArithDiophantienne(msgN) {
  const keywords = [
    'equation diophantienne', 'ax + by', 'ax + by =',
    'resoudre dans z x z', 'resoudre dans z²', 'solutions entieres',
    'solutions dans z', 'couple solution entier',
    'equation lineaire diophantienne', 'equation du 1er degre dans z',
  ];
  return keywords.some(kw => msgN.includes(normalize(kw)));
}

// ── Table des règles par mots-clés ───────────────────────────────────────────

const PROMPT_RULES = [
  {
    name: 'horner',
    keywords: ['hörner','horner','höner','division synthetique','tableau de horner','methode de horner'],
    prompt: HORNER_PROMPT
  },
  {
    name: 'polynomes',
    keywords: ['division euclidienne','diviser par','forme canonique','completer le carre','coefficients indetermines','zero du polynome','racine du polynome','polynome du second degre','fonction polynome'],
    prompt: POLYNOME_PROMPT
  },
  {
    name: 'complexes',
    keywords: ['nombre complexe','nombres complexes','ensemble c','z = a + ib','partie reelle','partie imaginaire','imaginaire pur','conjugue','module de z','|z|','argument','arg(z)','forme trigonometrique','forme exponentielle','formule de moivre','formule d euler'],
    prompt: COMPLEXES_PROMPT
  },
  {
    name: 'equations',
    keywords: ['equation du second degre','discriminant','recette r1','recette r2','racines de l equation','somme des racines','produit des racines','factoriser','forme factorisee','bicarree','resoudre dans r','resoudre dans ir'],
    prompt: EQUATION_PROMPT
  },
  {
    name: 'design',
    keywords: ['landing page','site vitrine','site web','design','interface','ui design','ux design','maquette','mockup','page de connexion','dashboard','tableau de bord','navbar','card','glassmorphism','dark mode','gradient','responsive','animation','composant','bouton','moderne','elegant','premium'],
    prompt: DESIGN_PROMPT
  },
  {
    name: 'programmation',
    keywords: ['code','programme','script','fonction','algorithme','bug','erreur','debug','api','backend','frontend','react','python','java','javascript','typescript','html','css','sql','nodejs','express'],
    prompt: PROGRAMMATION_PROMPT
  },
  {
    name: 'physique',
    keywords: ['physique','force','vecteur','acceleration','vitesse','energie','puissance','pression','circuit','tension','courant','resistance','mcu','mruv','mrua','champ'],
    prompt: PHYSIQUE_PROMPT
  },
  {
    name: 'geometrie',
    keywords: ['triangle','cercle','droite','angle','parallelogramme','vecteur','repere','coordonnees','distance','milieu','bissectrice','mediatrice','theoreme de tales','theoreme de pythagore'],
    prompt: GEOMETRIE_PROMPT
  },
  {
    name: 'dissertation',
    keywords: ['dissertation','redaction','plan','these','antithese','synthese','introduction','conclusion','developpement','argumentation','essai'],
    prompt: DISSERTATION_PROMPT
  },
];

// ── Routeur principal ─────────────────────────────────────────────────────────

function getSystemPrompt(userMessage, webContext) {
  const msg  = userMessage.toLowerCase();
  const msgN = normalize(userMessage);

  // Base toujours présente
  let systemPrompt = NEROSIA_SYSTEM_PROMPT;
  let matched = false;

  // ── Signaux combinés prioritaires (avant les mots-clés simples) ───────────
  const hasRac = hasRacine(msg);

  if (hasRac && (hasInequation(msgN) || hasSigneIneg(msg))) {
    systemPrompt += `\n\n---\n\n${MATH_IRAT_IN_PROMPT}`;
    matched = true;
  } else if (hasRac && hasEquation(msgN)) {
    systemPrompt += `\n\n---\n\n${MATH_IRAT_EQ_PROMPT}`;
    matched = true;
  } else if (hasFractionExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_QUOTIENT_PROMPT}`;
    matched = true;
  } else if (hasTrigInequality(msg, msgN)) {
    systemPrompt += `\n\n---\n\n${MATH_TRIG_INEGALITES_PROMPT}`;
    matched = true;
  } else if (hasEtudierSigne(msgN) && hasTrinomeExpr(msg) && !hasFractionExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_TRINOME_PROMPT}`;
    matched = true;
  } else if (hasEtudierSigne(msgN) && !hasFractionExpr(msg) && !hasTrinomeExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_BINOME_PROMPT}`;
    matched = true;
  }

  // ── Routage arithmétique — 6 modules (ordre du plus spécifique au plus général) ──
  if (!matched) {
    if (hasArithDiophantienne(msgN)) {
      systemPrompt += `\n\n---\n\n${ARITH_DIOPHANTIENNE_PROMPT}`;
      matched = true;
    } else if (hasArithEquationsZnZ(msgN)) {
      systemPrompt += `\n\n---\n\n${ARITH_EQUATIONS_ZNZ_PROMPT}`;
      matched = true;
    } else if (hasArithCongruence(msgN, msg)) {
      systemPrompt += `\n\n---\n\n${ARITH_CONGRUENCE_PROMPT}`;
      matched = true;
    } else if (hasArithPgcdPpcm(msgN)) {
      systemPrompt += `\n\n---\n\n${ARITH_PGCD_PPCM_PROMPT}`;
      matched = true;
    } else if (hasArithMultiplesDiviseursPremiers(msgN)) {
      systemPrompt += `\n\n---\n\n${ARITH_MULTIPLES_DIVISEURS_PREMIERS_PROMPT}`;
      matched = true;
    } else if (hasArithDivisionNumeration(msgN)) {
      systemPrompt += `\n\n---\n\n${ARITH_DIVISION_NUMERATION_PROMPT}`;
      matched = true;
    }
  }

  // ── Routage par mots-clés (si aucun signal prioritaire n'a matché) ────────
  if (!matched) {
    for (const rule of PROMPT_RULES) {
      if (rule.keywords.some(kw => msgN.includes(normalize(kw)))) {
        systemPrompt += `\n\n---\n\n${rule.prompt}`;
        matched = true;
        break;
      }
    }
  }

  // ── Si aucun mot-clé ne correspond → prompt de base seul (question générale)
  // Aucune injection supplémentaire : NEROSIA_SYSTEM_PROMPT suffit.

  return finalize(systemPrompt, webContext);
}

function finalize(systemPrompt, webContext) {
  if (webContext) {
    systemPrompt += `\n\n${webContext}`;
    systemPrompt += `\n\nRÈGLES ABSOLUES POUR CETTE RÉPONSE :\n- NE PAS lister de sources, URLs ou liens en fin de réponse.\n- NE PAS créer de tableau récapitulatif de sources.\n- Si les sources ne permettent pas de répondre, dis-le honnêtement.`;
  }
  return systemPrompt;
}

module.exports = { getSystemPrompt, NEROSIA_SYSTEM_PROMPT };
