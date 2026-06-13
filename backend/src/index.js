'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// src/index.js — Point d'entrée du backend Nerosia
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const timeout    = require('connect-timeout');
const chatRouter = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Vérification critique au démarrage ───────────────────────────────────────
if (IS_PROD && !process.env.API_SECRET) {
  console.error('🚨 FATAL : API_SECRET non configuré en production — arrêt du serveur.');
  process.exit(1);
}
if (!process.env.API_SECRET) {
  console.warn('⚠️  API_SECRET absent — mode dev non sécurisé, toutes les requêtes sont acceptées.');
}

// ── Headers de sécurité HTTP ─────────────────────────────────────────────────
// X-Content-Type-Options, X-Frame-Options, HSTS, X-XSS-Protection, etc.
app.use(helmet());

// ── CORS ──────────────────────────────────────────────────────────────────────
// En prod : whitelist explicite. En dev : tout autorisé pour Expo Go.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Apps mobiles natives (Expo Go, APK) n'envoient pas d'Origin → autorisées
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
// Limite globale petite — la limite 20mb n'est appliquée QUE sur /api/chat
app.use(express.json({ limit: '1mb' }));

// ── Timeout global sur /api ───────────────────────────────────────────────────
// Évite les connexions SSE zombies si un agent se bloque
app.use('/api', timeout('120s'));

// ── Authentification par clé secrète ─────────────────────────────────────────
app.use('/api', (req, res, next) => {
  if (req.timedout) return; // laisser le handler timeout gérer

  const secret = process.env.API_SECRET;
  if (!secret) return next(); // dev sans clé configurée

  const provided = req.headers['x-api-secret'];
  if (!provided || provided !== secret) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

// /api/chat : limite 20mb pour les images/PDFs base64
app.use('/api/chat', express.json({ limit: '20mb' }), chatRouter);

// Health check minimal — pas d'infos sensibles, non protégé intentionnellement
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── Handler d'erreur global ───────────────────────────────────────────────────
// Doit être déclaré EN DERNIER, après toutes les routes
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Erreur CORS
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  // Timeout
  if (req.timedout) {
    return res.status(503).json({ error: 'Délai dépassé — réessaie.' });
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
