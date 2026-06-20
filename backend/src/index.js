'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// src/index.js — Point d'entrée du backend Nerosia
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const chatRouter     = require('./routes/chat');
const { rateLimiter } = require('./middleware/rateLimiter');

const app     = express();
const PORT    = process.env.PORT || 3001;
const HOST    = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Vérification critique au démarrage ───────────────────────────────────────
if (!process.env.API_SECRET) {
  if (IS_PROD) {
    console.error('🚨 FATAL : API_SECRET non configuré en production — arrêt du serveur.');
    process.exit(1);
  } else {
    console.warn('⚠️  API_SECRET absent — mode dev non sécurisé, toutes les requêtes sont acceptées.');
    console.warn('⚠️  NODE_ENV =', process.env.NODE_ENV ?? 'non défini', '— si ce message apparaît en prod, définir NODE_ENV=production.');
  }
}

// ── Headers de sécurité HTTP ─────────────────────────────────────────────────
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // ⚠️ Risque accepté : les apps mobiles natives (Expo Go, APK) n'envoient
    // pas de header Origin. On les autorise ici. En contrepartie, toute
    // requête sans Origin (curl, scripts) passe aussi le CORS — l'auth par
    // x-api-secret est la vraie ligne de défense.
    if (!origin) return callback(null, true);

    // En dev sans whitelist → tout autorisé
    if (!IS_PROD && ALLOWED_ORIGINS.length === 0) return callback(null, true);

    // Whitelist explicite
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);

    callback(new Error(`CORS : origine non autorisée — ${origin}`));
  },
  methods:        ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
// ⚠️ FIX : PAS de express.json() global ici.
// Si on l'appliquait globalement (même à 1mb), il consommerait le stream
// du body avant que le middleware par-route (20mb sur /api/chat) puisse
// l'intercepter → les uploads d'images/PDFs échoueraient toujours avec 413.
// Chaque route applique sa propre limite ci-dessous.

// ── Authentification par clé secrète ─────────────────────────────────────────
app.use('/api', (req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // dev sans clé configurée

  const provided = req.headers['x-api-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

// /api/chat : rate-limiter d'abord (protège les clés OpenRouter avant tout
// parsing), puis express.json() avec limite 20mb pour les images/PDFs base64
app.use('/api/chat', rateLimiter, express.json({ limit: '20mb' }), chatRouter);

// Health check minimal — non protégé intentionnellement
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Handler 404 ───────────────────────────────────────────────────────────────
// Doit être AVANT le handler d'erreur global
// Évite qu'Express retourne son HTML par défaut (qui révèle la version)
app.use((_req, res) => {
  res.status(404).json({ error: 'Route introuvable.' });
});

// ── Handler d'erreur global ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Erreur CORS
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  // Payload trop grand
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload trop volumineux.' });
  }

  console.error('[global error]', err);

  res.status(err.status ?? 500).json({
    error: IS_PROD ? 'Erreur interne du serveur' : err.message,
  });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  const keyCount = [
    process.env.OPENROUTER_KEY_1,
    process.env.OPENROUTER_KEY_2,
  ].filter(Boolean).length;

  console.log(`✅ Nerosia Backend démarré sur ${HOST}:${PORT}`);
  console.log(`🔑 ${keyCount} clé(s) OpenRouter chargée(s)`);
  console.log(`🔐 API_SECRET : ${process.env.API_SECRET ? 'configuré' : 'absent (dev)'}`);
  console.log(`🌍 CORS : ${ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(', ') : IS_PROD ? '⚠️  aucune origine whitelistée' : 'dev (tout autorisé)'}`);
  console.log(`🌱 Environnement : ${process.env.NODE_ENV ?? 'non défini'}`);
});
