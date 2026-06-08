// src/sandbox.js
// ─────────────────────────────────────────────────────────────────────────────
// Sandbox d'exécution sécurisée Python / JavaScript
// Utilisé par l'agent loop quand le modèle appelle execute_code
// ─────────────────────────────────────────────────────────────────────────────

const { exec }        = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { randomUUID }  = require('crypto');
const path            = require('path');

const TIMEOUT_MS = 10_000; // 10s max par exécution
const TMP        = '/tmp';

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
    exec(cmd, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      try { unlinkSync(file); } catch {}

      const exitCode = err
        ? (err.killed ? 124 : (err.code ?? 1)) // 124 = timeout SIGKILL
        : 0;

      resolve({
        stdout:    (stdout ?? '').trim(),
        stderr:    (err?.message?.includes('TIMEOUT')
          ? `Timeout : exécution interrompue après ${TIMEOUT_MS / 1000}s`
          : (stderr ?? '').trim()),
        exit_code: exitCode,
      });
    });
  });
}

module.exports = { executeCode };
