'use strict';

// src/tools/definitions.js
// ─────────────────────────────────────────────────────────────────────────────
// Déclaration des tools exposés au modèle (format OpenAI function calling)
// ─────────────────────────────────────────────────────────────────────────────

// FIX : liste synchronisée avec ALLOWED_PACKAGES dans agentLoop.js
// Le LLM doit connaître la whitelist pour ne pas boucler sur des packages refusés.
const ALLOWED_PACKAGES_LIST =
  'numpy, pandas, matplotlib, scipy, scikit-learn, requests, pillow, ' +
  'flask, fastapi, uvicorn, sqlalchemy, pydantic, httpx, beautifulsoup4, lxml, ' +
  'lodash, axios, express, dotenv, dayjs, uuid, zod, chalk, commander, fs-extra, csv-parser';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'execute_code',
      description: [
        'Exécute du code Python ou JavaScript dans un environnement sécurisé.',
        'Utilise cet outil pour : tester une logique, vérifier un calcul, déboguer un bug,',
        'ou valider qu\'un algorithme produit le bon résultat avant de l\'expliquer.',
        'Si le code produit une erreur, corrige-le et réessaie automatiquement.',
        'Limite : 10 secondes d\'exécution max, 128 Mo de RAM max.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript'],
            description: 'Langage à utiliser. Uniquement python ou javascript.',
          },
          code: {
            type:        'string',
            maxLength:   10_000,
            description: 'Code source complet à exécuter. Doit être autonome et ne pas dépasser 10 000 caractères.',
          },
          description: {
            type:        'string',
            maxLength:   200,
            description: 'Une phrase décrivant ce que ce code fait (affiché à l\'utilisateur).',
          },
        },
        required: ['language', 'code', 'description'], // FIX : uniformisé — description requis partout
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'install_package',
      description: [
        'Installe un package Python (pip) ou Node.js (npm) dans l\'environnement.',
        'Appelle cet outil AVANT d\'utiliser une bibliothèque externe.',
        `IMPORTANT : seuls ces packages sont autorisés : ${ALLOWED_PACKAGES_LIST}.`,
        'Tout autre package sera refusé automatiquement — n\'essaie pas de packages hors liste.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          package: {
            type:        'string',
            maxLength:   100,
            description: `Nom exact du package à installer. Doit faire partie de la liste autorisée : ${ALLOWED_PACKAGES_LIST}.`,
          },
          manager: {
            type: 'string',
            enum: ['pip', 'npm'],
            description: 'Gestionnaire de paquets : pip pour Python, npm pour Node.js.',
          },
        },
        required: ['package', 'manager'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: [
        'Applique un patch ciblé sur un fichier de code existant dans la conversation.',
        'Utilise str_replace pour remplacer une portion exacte sans réécrire tout le fichier.',
        'Plus efficace et précis que régénérer entièrement le fichier.',
        'IMPORTANT : filename doit être un nom simple sans chemin (ex: App.tsx, main.py) — pas de / ni de ..',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type:        'string',
            // FIX : pattern qui interdit les path traversal (../, /etc/passwd, etc.)
            pattern:     '^[a-zA-Z0-9][a-zA-Z0-9._-]*$',
            maxLength:   100,
            description: 'Nom du fichier uniquement, sans chemin (ex: App.tsx, main.py). Pas de / ni de points doubles.',
          },
          old_str: {
            type:        'string',
            maxLength:   5_000,
            description: 'Texte exact à remplacer. Doit correspondre exactement au contenu actuel du fichier.',
          },
          new_str: {
            type:        'string',
            maxLength:   5_000,
            description: 'Nouveau texte qui remplacera old_str.',
          },
          description: {
            type:        'string',
            maxLength:   200,
            description: 'Description courte du changement effectué.',
          },
        },
        required: ['filename', 'old_str', 'new_str', 'description'],
      },
    },
  },
];

module.exports = { TOOLS };
