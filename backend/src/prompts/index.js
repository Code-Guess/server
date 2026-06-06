// ─────────────────────────────────────────────────────────────────────────────
// src/prompts/index.js — Routeur de prompts Nerosia
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

// ── Routeur principal ─────────────────────────────────────────────────────────

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

const PROMPT_RULES = [
  { name: 'horner',       keywords: ['hörner','horner','höner','division synthetique','tableau de horner','methode de horner'],                                                                                                                                                                                                          prompt: HORNER_PROMPT },
  { name: 'polynomes',    keywords: ['division euclidienne','diviser par','forme canonique','completer le carre','coefficients indetermines','zero du polynome','racine du polynome','polynome du second degre','fonction polynome'],                                                                                                      prompt: POLYNOME_PROMPT },
  { name: 'complexes',    keywords: ['nombre complexe','nombres complexes','ensemble c','z = a + ib','partie reelle','partie imaginaire','imaginaire pur','conjugue','module de z','|z|','argument','arg(z)','forme trigonometrique','forme exponentielle','formule de moivre','formule d euler'],                                        prompt: COMPLEXES_PROMPT },
  { name: 'equations',    keywords: ['equation du second degre','discriminant','recette r1','recette r2','racines de l equation','somme des racines','produit des racines','factoriser','forme factorisee','bicarree','resoudre dans r','resoudre dans ir'],                                                                              prompt: EQUATION_PROMPT },
  { name: 'design',       keywords: ['landing page','site vitrine','site web','design','interface','ui design','ux design','maquette','mockup','page de connexion','dashboard','tableau de bord','navbar','card','glassmorphism','dark mode','gradient','responsive','animation','composant','bouton','moderne','elegant','premium'],      prompt: DESIGN_PROMPT },
  { name: 'programmation',keywords: ['code','programme','script','fonction','algorithme','bug','erreur','debug','api','backend','frontend','react','python','java','javascript','typescript','html','css','sql','nodejs','express'],                                                                                                        prompt: PROGRAMMATION_PROMPT },
  { name: 'physique',     keywords: ['physique','force','vecteur','acceleration','vitesse','energie','puissance','pression','circuit','tension','courant','resistance','mcu','mruv','mrua','champ'],                                                                                                                                       prompt: PHYSIQUE_PROMPT },
  { name: 'geometrie',    keywords: ['triangle','cercle','droite','angle','parallelogramme','vecteur','repere','coordonnees','distance','milieu','bissectrice','mediatrice','theoreme de tales','theoreme de pythagore'],                                                                                                                  prompt: GEOMETRIE_PROMPT },
  { name: 'dissertation', keywords: ['dissertation','redaction','plan','these','antithese','synthese','introduction','conclusion','developpement','argumentation','essai'],                                                                                                                                                                prompt: DISSERTATION_PROMPT },
];

function getSystemPrompt(userMessage, webContext) {
  const msg  = userMessage.toLowerCase();
  const msgN = normalize(userMessage);

  let systemPrompt = NEROSIA_SYSTEM_PROMPT;

  // ── Signaux combinés prioritaires ─────────────────────────────────────────
  const hasRac = hasRacine(msg);
  if (hasRac && (hasInequation(msgN) || hasSigneIneg(msg))) {
    systemPrompt += `\n\n---\n\n${MATH_IRAT_IN_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }
  if (hasRac && hasEquation(msgN)) {
    systemPrompt += `\n\n---\n\n${MATH_IRAT_EQ_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }
  if (hasFractionExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_QUOTIENT_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }
  if (hasTrigInequality(msg, msgN)) {
    systemPrompt += `\n\n---\n\n${MATH_TRIG_INEGALITES_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }
  if (hasEtudierSigne(msgN) && hasTrinomeExpr(msg) && !hasFractionExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_TRINOME_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }
  if (hasEtudierSigne(msgN) && !hasFractionExpr(msg) && !hasTrinomeExpr(msg)) {
    systemPrompt += `\n\n---\n\n${MATH_BINOME_PROMPT}`;
    return finalize(systemPrompt, webContext);
  }

  // ── Routage par keywords ──────────────────────────────────────────────────
  for (const rule of PROMPT_RULES) {
    if (rule.keywords.some(kw => msgN.includes(normalize(kw)))) {
      systemPrompt += `\n\n---\n\n${rule.prompt}`;
      break;
    }
  }

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
