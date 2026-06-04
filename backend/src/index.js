// ─────────────────────────────────────────────────────────────────────────────
// src/index.js — Point d'entrée du backend Nerosia
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const chatRouter = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS : autorise l'app mobile Expo et n'importe quel client ────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
}));

app.use(express.json({ limit: '2mb' }));

// ── Vérification de la clé secrète partagée ──────────────────────────────────
// L'app mobile envoie le header x-api-secret à chaque requête.
// Si API_SECRET est défini dans les env vars, on vérifie.
// Si non défini (développement local), on laisse passer.

app.use('/api', (req, res, next) => {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // pas de secret configuré = développement local
  const provided = req.headers['x-api-secret'];
  if (provided !== secret) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/chat', chatRouter);

// Health check pour Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ name: 'Nerosia Backend', version: '1.0.0', status: 'running' });
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Nerosia Backend démarré sur le port ${PORT}`);
  const keyCount = [process.env.OPENROUTER_KEY_1, process.env.OPENROUTER_KEY_2].filter(Boolean).length;
  console.log(`🔑 ${keyCount} clé(s) OpenRouter chargée(s)`);
  console.log(`🔐 API_SECRET : ${process.env.API_SECRET ? 'configuré' : 'non configuré (dev mode)'}`);
});
