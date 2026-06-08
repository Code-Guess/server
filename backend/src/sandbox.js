// src/sandbox.js
// ─────────────────────────────────────────────────────────────────────────────
// Sandbox d'exécution sécurisée Python / JavaScript
// + Installation de packages (pip / npm)
// ─────────────────────────────────────────────────────────────────────────────

const { exec }                       = require('child_process');
const { writeFileSync, unlinkSync }  = require('fs');
const { randomUUID }                 = require('crypto');
const path                           = require('path');

const EXEC_TIMEOUT_MS    = 10_000;  // 10s par exécution
const INSTALL_TIMEOUT_MS = 60_000;  // 60s pour les installs
const TMP                = '/tmp';

/**
 * Exécute du code Python ou JavaScript dans un sous-process.
 * @returns {{ stdout, stderr, exit_code }}
 */
async function executeCode(language, code) {
  const id   = randomUUID();
  const ext  = language === 'python' ? 'py' : 'js';
  const file = path.join(TMP, `nerosia_${id}.${ext}`);

  writeFileSync(file, code, 'utf8');

  const cmd = language === 'python'
    ? `python3 "${file}"`
    : `node "${file}"`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
      try { unlinkSync(file); } catch {}
      const exitCode = err
        ? (err.killed ? 124 : (err.code ?? 1))
        : 0;
      resolve({
        stdout:    (stdout ?? '').trim(),
        stderr:    (err?.message?.includes('TIMEOUT') || err?.killed)
          ? `Timeout : exécution interrompue après ${EXEC_TIMEOUT_MS / 1000}s`
          : (stderr ?? '').trim(),
        exit_code: exitCode,
      });
    });
  });
}

/**
 * Installe un package via pip ou npm.
 * @param {string} packageName  — nom du package
 * @param {'pip'|'npm'} manager — gestionnaire de paquets
 * @returns {{ stdout, stderr, exit_code }}
 */
async function installPackage(packageName, manager = 'pip') {
  // Sanitize : seulement lettres, chiffres, tirets, underscores, @, /
  const safe = packageName.replace(/[^a-zA-Z0-9\-_.@/]/g, '');
  if (!safe || safe.length === 0) {
    return { stdout: '', stderr: 'Nom de package invalide.', exit_code: 1 };
  }

  const cmd = manager === 'npm'
    ? `npm install ${safe} --no-save 2>&1`
    : `pip install ${safe} --quiet 2>&1`;

  return new Promise((resolve) => {
    exec(cmd, { timeout: INSTALL_TIMEOUT_MS }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code ?? 1) : 0;
      resolve({
        stdout:    (stdout ?? '').trim(),
        stderr:    (stderr ?? '').trim(),
        exit_code: exitCode,
      });
    });
  });
}

module.exports = { executeCode, installPackage };
