'use strict';

// src/sandbox.js
// ─────────────────────────────────────────────────────────────────────────────
// Sandbox d'exécution sécurisée Python / JavaScript
// + Installation de packages (pip / npm)
// ─────────────────────────────────────────────────────────────────────────────

const { exec }                      = require('child_process');
const { writeFileSync, unlinkSync, mkdirSync } = require('fs');
const { randomUUID }                = require('crypto');
const path                          = require('path');

const EXEC_TIMEOUT_MS    = 10_000;  // 10s par exécution
const INSTALL_TIMEOUT_MS = 60_000;  // 60s pour les installs
const TMP                = '/tmp/nerosia_sandbox';
const NPM_PREFIX         = '/tmp/nerosia_npm';
const MAX_BUFFER         = 5 * 1024 * 1024; // 5 Mo max de stdout/stderr

// ── Créer les dossiers sandbox au démarrage ───────────────────────────────────
try { mkdirSync(TMP,        { recursive: true }); } catch {}
try { mkdirSync(NPM_PREFIX, { recursive: true }); } catch {}

// ── Langages supportés ────────────────────────────────────────────────────────
// FIX : whitelist stricte — tout langage non listé est refusé.
// Empêche d'exécuter du bash/ruby/go via le runner Node par défaut.

const SUPPORTED_LANGUAGES = {
  python:     { ext: 'py',  runner: 'python3' },
  py:         { ext: 'py',  runner: 'python3' },
  javascript: { ext: 'js',  runner: 'node'    },
  js:         { ext: 'js',  runner: 'node'    },
};

// ── Environnement minimal passé aux subprocesses ──────────────────────────────
// FIX : on ne transmet AUCUNE variable d'environnement du process parent.
// Sans ça, process.env (Node) et os.environ (Python) exposent toutes les
// clés API (OPENROUTER_KEY_1/2, API_SECRET, SERPER_KEY...).

const SAFE_ENV = {
  PATH:   '/usr/local/bin:/usr/bin:/bin',
  HOME:   TMP,
  TMPDIR: TMP,
  // Pas de NODE_ENV, pas de clés API, pas de secrets
};

// ── Options communes exec ─────────────────────────────────────────────────────

function baseExecOptions(timeoutMs) {
  return {
    timeout:   timeoutMs,
    maxBuffer: MAX_BUFFER,   // FIX : 5Mo au lieu du défaut 1Mo
    cwd:       TMP,          // FIX : répertoire de travail isolé
    env:       SAFE_ENV,     // FIX : pas d'héritage de process.env
  };
}

// ── Détection timeout fiable ──────────────────────────────────────────────────
// FIX : err.message.includes('TIMEOUT') n'est pas garanti selon la version Node.
// err.killed ou err.signal sont les sources fiables.

function isTimeout(err) {
  return err?.killed === true || err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL';
}

// ─────────────────────────────────────────────────────────────────────────────
// executeCode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exécute du code Python ou JavaScript dans un sous-process isolé.
 *
 * Sécurité :
 *  - Aucune variable d'env transmise (pas de fuite de clés API)
 *  - cwd limité à /tmp/nerosia_sandbox
 *  - Limite mémoire virtuelle 128 Mo + CPU 5s via ulimit
 *  - Timeout process 10s via exec()
 *  - maxBuffer 5 Mo pour éviter les crashs sur output volumineux
 *
 * @param {string} language — 'python' | 'javascript'
 * @param {string} code     — code source à exécuter
 * @returns {{ stdout, stderr, exit_code }}
 */
async function executeCode(language, code) {
  // FIX : valider le langage avant tout
  const langConfig = SUPPORTED_LANGUAGES[language?.toLowerCase()];
  if (!langConfig) {
    return {
      stdout:    '',
      stderr:    `Langage non supporté : "${language}". Langages acceptés : python, javascript.`,
      exit_code: 1,
    };
  }

  const id   = randomUUID();
  const file = path.join(TMP, `exec_${id}.${langConfig.ext}`);

  // FIX : writeFileSync peut throw si /tmp est plein ou sans permissions
  try {
    writeFileSync(file, code, 'utf8');
  } catch (writeErr) {
    return {
      stdout:    '',
      stderr:    `Impossible d'écrire le fichier temporaire : ${writeErr.message}`,
      exit_code: 1,
    };
  }

  // FIX : ulimit -v 131072 → limite RAM virtuelle à 128 Mo
  //        ulimit -t 5      → limite CPU à 5s
  // Ces limites s'appliquent au subprocess uniquement, pas au serveur.
  const cmd = `ulimit -v 131072 -t 5 && ${langConfig.runner} "${file}"`;

  return new Promise((resolve) => {
    exec(cmd, baseExecOptions(EXEC_TIMEOUT_MS), (err, stdout, stderr) => {
      // Nettoyage garanti du fichier temporaire
      try { unlinkSync(file); } catch {}

      const timedOut = isTimeout(err); // FIX : détection fiable

      const exitCode = err
        ? (timedOut ? 124 : (err.code ?? 1))
        : 0;

      resolve({
        stdout:    (stdout ?? '').trim(),
        stderr:    timedOut
          ? `Timeout : exécution interrompue après ${EXEC_TIMEOUT_MS / 1000}s`
          : (stderr ?? '').trim(),
        exit_code: exitCode,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// installPackage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Installe un package via pip ou npm.
 *
 * Note : la whitelist des packages autorisés est gérée dans agentLoop.js
 * avant d'appeler cette fonction. Ce fichier applique en plus un sanitize
 * sur le nom pour éviter toute injection de commande shell.
 *
 * @param {string} packageName  — nom du package (déjà whitelisté par agentLoop)
 * @param {'pip'|'npm'} manager — gestionnaire de paquets
 * @returns {{ stdout, stderr, exit_code }}
 */
async function installPackage(packageName, manager = 'pip') {
  // Sanitize défensif : seulement les caractères valides pour un nom de package
  const safe = (packageName ?? '').replace(/[^a-zA-Z0-9\-_.@/]/g, '').trim();

  if (!safe || safe.length === 0) {
    return { stdout: '', stderr: 'Nom de package invalide.', exit_code: 1 };
  }

  // FIX : npm install avec --prefix isolé pour ne pas polluer node_modules du backend
  const cmd = manager === 'npm'
    ? `npm install ${safe} --no-save --prefix "${NPM_PREFIX}" 2>&1`
    : `pip install ${safe} --quiet 2>&1`;

  return new Promise((resolve) => {
    exec(cmd, baseExecOptions(INSTALL_TIMEOUT_MS), (err, stdout, stderr) => {
      const exitCode = err ? (err.code ?? 1) : 0;
      resolve({
        stdout:    (stdout ?? '').trim(),
        stderr:    (stderr ?? '').trim(),
        exit_code: exitCode,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { executeCode, installPackage };
