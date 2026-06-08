// src/tools/definitions.js
// ─────────────────────────────────────────────────────────────────────────────
// Déclaration des tools exposés au modèle (format OpenAI function calling)
// Compatible OpenRouter avec tous les modèles qui supportent tool_calls
// ─────────────────────────────────────────────────────────────────────────────

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
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            enum: ['python', 'javascript'],
            description: 'Langage à utiliser.',
          },
          code: {
            type: 'string',
            description: 'Code source complet à exécuter. Doit être autonome (pas d\'import externe hors stdlib).',
          },
          description: {
            type: 'string',
            description: 'Une phrase décrivant ce que ce code fait (affiché à l\'utilisateur).',
          },
        },
        required: ['language', 'code'],
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
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Nom du fichier à modifier (ex: App.tsx, main.py).',
          },
          old_str: {
            type: 'string',
            description: 'Texte exact à remplacer. Doit correspondre mot pour mot au contenu actuel.',
          },
          new_str: {
            type: 'string',
            description: 'Nouveau texte qui remplacera old_str.',
          },
          description: {
            type: 'string',
            description: 'Description courte du changement effectué.',
          },
        },
        required: ['filename', 'old_str', 'new_str', 'description'],
      },
    },
  },
];

module.exports = { TOOLS };
