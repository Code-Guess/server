# Nerosia Backend

Backend sécurisé pour l'app Nerosia. Gère le proxy vers OpenRouter, les agents de recherche, et le pipeline multi-agents de génération de code.

## Déploiement sur Render

### 1. Crée un nouveau Web Service sur Render

- **Build Command** : `npm install`
- **Start Command** : `npm start`
- **Runtime** : Node 18+

### 2. Configure les variables d'environnement sur Render

Dans **Environment > Environment Variables** :

| Variable | Valeur |
|---|---|
| `OPENROUTER_KEY_1` | ta clé OpenRouter principale |
| `OPENROUTER_KEY_2` | ta clé OpenRouter de secours |
| `API_SECRET` | une chaîne aléatoire longue (ex: `openssl rand -hex 32`) |

### 3. Connecte l'app mobile au backend

Dans `constants/openrouter.ts` de ton app, change :

```ts
// Avant : appel direct OpenRouter
// Après : appel ton backend Render
export const BACKEND_URL = 'https://ton-backend.onrender.com';
export const API_SECRET = 'la_même_valeur_que_sur_render';
```

## Routes disponibles

### POST /api/chat

Corps de la requête :
```json
{
  "message": "Explique-moi les polynômes",
  "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "model": "opus",
  "deepResearch": false
}
```

Header requis (si API_SECRET configuré) :
```
x-api-secret: ta_valeur_secrete
```

Réponse en **Server-Sent Events (SSE)** :
```
data: {"type":"chunk","content":"..."}
data: {"type":"thinkingSteps","steps":[...]}
data: {"type":"sources","sources":[...]}
data: {"type":"done","modelUsed":"..."}
```

### GET /health

Vérifie que le serveur tourne.

## Modifier les prompts

Tous les prompts sont dans `src/prompts/index.js`. Modifie directement ce fichier sur Render (ou dans ton repo) et redémarre le service — l'app mobile reçoit automatiquement le nouveau comportement.

## Structure

```
backend/
├── src/
│   ├── index.js              ← serveur Express
│   ├── openrouter.js         ← proxy sécurisé (clés ici, jamais dans l'app)
│   ├── prompts/
│   │   └── index.js          ← TOUS les prompts Nerosia (modifiables ici)
│   ├── agents/
│   │   ├── searchAgents.js   ← Wikipedia, Reddit, Academic, DuckDuckGo
│   │   └── codeAgents.js     ← pipeline multi-agents génération de code
│   └── routes/
│       └── chat.js           ← route POST /api/chat
├── .env.example              ← copie en .env et remplis
├── .gitignore
├── package.json
└── README.md
```
