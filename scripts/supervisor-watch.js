#!/usr/bin/env node
'use strict';

/*
 * SUPERVISOR WATCH - observacao continua do working tree.
 *
 * A cada N segundos compara o estado do repositorio (git status).
 * Quando algo muda, roda o supervisor-guard e grava o resultado em:
 *   %TEMP%\opencode\supervisor\alerts.log
 *
 * Uso: node scripts/supervisor-watch.js [intervaloSegundos]
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INTERVAL = Math.max(5, Number(process.argv[2]) || 15) * 1000;
const LOG_DIR = path.join(process.env.TEMP || process.env.TMP || ROOT, 'opencode', 'supervisor');
const LOG_FILE = path.join(LOG_DIR, 'alerts.log');
const PID_FILE = path.join(LOG_DIR, 'watch.pid');

function log(message) {
  const line = '[' + new Date().toISOString() + '] ' + message;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* ignore */ }
}

function snapshot() {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    return 'ERRO: ' + error.message;
  }
}

log('watcher iniciado (pid=' + process.pid + ', intervalo=' + (INTERVAL / 1000) + 's) em ' + ROOT);
log('log: ' + LOG_FILE);
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
} catch { /* ignore */ }

let last = snapshot();

setInterval(() => {
  const now = snapshot();
  if (now === last) return;
  last = now;
  log('mudanca detectada no working tree; executando guard...');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'supervisor-guard.js')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = String(result.stdout || '').trim();
  try {
    fs.appendFileSync(LOG_FILE, output + '\n\n', 'utf8');
  } catch { /* ignore */ }
  if (result.status !== 0) {
    log('ALERTA: guard bloqueou o estado atual. Veja detalhes acima.');
  } else {
    log('guard liberou o estado atual.');
  }
}, INTERVAL);

process.on('SIGINT', () => {
  log('watcher encerrado (SIGINT)');
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('watcher encerrado (SIGTERM)');
  process.exit(0);
});
