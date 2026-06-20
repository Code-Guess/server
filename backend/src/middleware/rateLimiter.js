'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/rateLimiter.js
//
// Protège les clés OpenRouter contre le rate-limit (429) en limitant :
//   1. Par utilisateur (IP)  → empêche un seul user de spammer
//   2. Globalement (serveur) → empêche que plusieurs users cumulés dépassent
//                                le quota OpenRouter (20 req/min sur :free)
//
// 100% en mémoire (objets JS), aucune dépendance externe (pas de Redis/DB).
// ⚠️ Limite connue : si Render redémarre le process, les compteurs repartent
//    à zéro. Acceptable pour un anti-spam, pas pour de la facturation précise.
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MS = 60 * 1000; // fenêtre glissante de 1 minute

const LIMITS = {
  PER_USER_PER_MINUTE:   3,   // ton choix : 3 req/min par utilisateur
  GLOBAL_PER_MINUTE:     18,  // marge de sécurité sous les 20 req/min OpenRouter (:free)
};

// ── État en mémoire ───────────────────────────────────────────────────────────
// Map<ip, number[]>  → timestamps des requêtes récentes de cet utilisateur
const userHits = new Map();

// number[] → timestamps des requêtes récentes, tous utilisateurs confondus
let globalHits = [];

// ── Nettoyage périodique pour éviter une fuite mémoire ───────────────────────
// (sans ça, userHits grossirait indéfiniment avec chaque nouvelle IP)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of userHits.entries()) {
    const fresh = timestamps.filter(t => now - t < WINDOW_MS);
    if (fresh.length === 0) userHits.delete(ip);
    else userHits.set(ip, fresh);
  }
  globalHits = globalHits.filter(t => now - t < WINDOW_MS);
}, 30 * 1000).unref(); // .unref() : ne bloque pas l'arrêt propre du process

// ── Extraction de l'IP réelle (Render est derrière un proxy) ─────────────────
function getClientIp(req) {
  // Render transmet x-forwarded-for : "client_ip, proxy1_ip, proxy2_ip"
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ── Middleware Express ────────────────────────────────────────────────────────
function rateLimiter(req, res, next) {
  const now = Date.now();
  const ip  = getClientIp(req);

  // 1) Purge des entrées expirées (fenêtre glissante)
  globalHits = globalHits.filter(t => now - t < WINDOW_MS);
  const userTimestamps = (userHits.get(ip) || []).filter(t => now - t < WINDOW_MS);

  // 2) Vérification limite globale (protège la clé OpenRouter en priorité)
  if (globalHits.length >= LIMITS.GLOBAL_PER_MINUTE) {
    const oldestHit = globalHits[0];
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - oldestHit)) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: 'Le serveur est très sollicité actuellement. Réessaie dans quelques secondes.',
      retryAfter: retryAfterSec,
    });
  }

  // 3) Vérification limite par utilisateur (anti-spam individuel)
  if (userTimestamps.length >= LIMITS.PER_USER_PER_MINUTE) {
    const oldestHit = userTimestamps[0];
    const retryAfterSec = Math.ceil((WINDOW_MS - (now - oldestHit)) / 1000);
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({
      error: `Trop de messages envoyés. Attends ${retryAfterSec}s avant de réessayer.`,
      retryAfter: retryAfterSec,
    });
  }

  // 4) Requête acceptée → on l'enregistre dans les deux compteurs
  globalHits.push(now);
  userTimestamps.push(now);
  userHits.set(ip, userTimestamps);

  next();
}

module.exports = { rateLimiter };
