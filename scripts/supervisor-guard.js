#!/usr/bin/env node
'use strict';

/*
 * SUPERVISOR GUARD - porteiro automatico de mudancas.
 *
 * Roda em duas formas:
 *   node scripts/supervisor-guard.js           -> audita o working tree
 *   node scripts/supervisor-guard.js --staged  -> audita apenas o que esta em stage
 *
 * Exit code 0 = liberado; 1 = bloqueado (CRITICAL/HIGH encontrados).
 *
 * Bypass consciente: SUPERVISOR_BYPASS="motivo" (fica registrado no log).
 * O bypass nunca e silencioso.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAGED = process.argv.includes('--staged');
const REASON = String(process.env.SUPERVISOR_BYPASS || '').trim();
const LOG_DIR = path.join(process.env.TEMP || process.env.TMP || ROOT, 'opencode', 'supervisor');
const LOG_FILE = path.join(LOG_DIR, 'alerts.log');

const findings = [];

function add(severity, rule, file, message) {
  findings.push({ severity, rule, file, message });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function readIf(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
  } catch {
    return null;
  }
}

function exists(relative) {
  try {
    fs.statSync(path.join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

function changedFiles() {
  const items = [];
  if (STAGED) {
    const out = git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-status', '-M']);
    out.split('\n').filter(Boolean).forEach((line) => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) {
        items.push({ status: status[0], oldPath: parts[1], path: parts[2] });
      } else {
        items.push({ status: status[0], path: parts[1] });
      }
    });
    return items;
  }
  const out = git(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-uall']);
  out.split('\n').filter(Boolean).forEach((line) => {
    const status = line.slice(0, 2).trim();
    let rest = line.slice(3);
    if (status === 'R' || status === 'C') {
      const arrow = rest.indexOf(' -> ');
      items.push({ status: status[0], oldPath: rest.slice(0, arrow), path: rest.slice(arrow + 4) });
    } else if (status === '??') {
      items.push({ status: '?', path: rest });
    } else {
      items.push({ status: status.replace(/[?!]/g, '')[0] || status[0], path: rest });
    }
  });
  return items;
}

function diffFor(relative) {
  if (STAGED) return git(['-c', 'core.quotepath=false', 'diff', '--cached', '-U0', '--', relative]);
  return git(['-c', 'core.quotepath=false', 'diff', '-U0', '--', relative]);
}

function walkHtml(dir, acc) {
  const skip = new Set(['node_modules', '.git', '.vercel', 'backend sist', '.agents', '.claude']);
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const rel = dir ? path.join(dir, entry.name) : entry.name;
    if (entry.isDirectory()) walkHtml(rel, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) acc.push(rel);
  }
  return acc;
}

/* ------------------------------------------------------------------ */
/* Regras                                                             */
/* ------------------------------------------------------------------ */

const files = changedFiles();
const byPath = new Map(files.map((f) => [f.path, f]));
const touched = (p) => byPath.has(p);

/* 1. Escrita publica incondicional em rotas de API. */
const apiTouched = files.filter((f) => f.path.startsWith('api/') && f.status !== 'D');
for (const f of apiTouched) {
  const src = readIf(f.path);
  if (!src) continue;
  if (/(?:podeEscrever|podeEditar|podeAlterar|authorizeWrite)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\(\{\s*ok:\s*true/.test(src) ||
      /(?:podeEscrever|podeEditar|podeAlterar|authorizeWrite)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*return\s*\{\s*ok:\s*true/.test(src)) {
    add('CRITICAL', 'AUTH-01', f.path,
      'funcao de autorizacao de escrita retorna ok:true incondicionalmente (escrita publica).');
  }
}

/* 2. Contrato de /api/gestao: GET publico, escrita autenticada. */
if (touched('api/_routes/gestao.js') || touched('api/_lib/access-control.js')) {
  const ac = readIf('api/_lib/access-control.js') || '';
  const block = ac.match(/PRIVATE_API_ROUTES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const listed = block ? /['"]gestao['"]/.test(block[1]) : false;
  const explicit = /route\s*===\s*['"]gestao['"]/.test(ac);
  if (!listed && !explicit) {
    add('HIGH', 'AUTH-02', 'api/_lib/access-control.js',
      "rota 'gestao' saiu de PRIVATE_API_ROUTES e nao tem politica explicita: POST/PUT/DELETE ficam publicos via apiPolicy().");
  }
}

/* 3. Pagina HTML removida mas ainda referenciada. */
const deletedHtml = files.filter((f) => f.status === 'D' && f.path.toLowerCase().endsWith('.html'));
if (deletedHtml.length) {
  const allHtml = walkHtml('', []);
  for (const gone of deletedHtml) {
    const base = path.basename(gone.path);
    const refs = allHtml.filter((html) => {
      if (path.normalize(html) === path.normalize(gone.path)) return false;
      const body = readIf(html) || '';
      return body.includes(base);
    });
    if (refs.length) {
      add('HIGH', 'NAV-01', gone.path,
        'pagina removida, mas ainda referenciada em: ' + refs.slice(0, 5).join(', ') +
        (refs.length > 5 ? ' (+' + (refs.length - 5) + ')' : '') + '. Links vao responder 404.');
    }
  }
}

/* 4. Configuracao de acesso apontando para pagina inexistente. */
if (touched('api/_lib/access-control.js')) {
  const ac = readIf('api/_lib/access-control.js') || '';
  const pages = [...ac.matchAll(/\[['"]([^'"]+\.html)['"]/g)].map((m) => m[1]);
  for (const page of pages) {
    if (!exists(page)) {
      add('MEDIUM', 'NAV-02', 'api/_lib/access-control.js',
        "INTERNAL_PAGES lista '" + page + "', que nao existe no repositorio.");
    }
  }
}

/* 5. Arquivos proibidos no stage / artefatos de depuracao. */
const forbidden = [
  { re: /(^|\/)\.env(\.|$)/i, allow: /\.env\.example$/i, sev: 'CRITICAL', rule: 'SEC-02', msg: 'arquivo de ambiente com segredos.' },
  { re: /(^|\/)(__test|__tmp|tmp_)/i, sev: 'HIGH', rule: 'HYG-01', msg: 'artefato temporario de depuracao.' },
  { re: /\.html\.html$/i, sev: 'HIGH', rule: 'HYG-02', msg: 'arquivo duplicado/artefato.' },
  { re: /\.(bak|orig|rej)$/i, sev: 'MEDIUM', rule: 'HYG-03', msg: 'backup/artefato de merge.' },
];
for (const f of files) {
  if (f.status === 'D') continue;
  for (const rule of forbidden) {
    if (rule.re.test(f.path) && !(rule.allow && rule.allow.test(f.path))) {
      add(rule.sev, rule.rule, f.path, rule.msg);
    }
  }
}

/* 6. Segredos em linhas adicionadas. */
const secretPatterns = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk_live_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bpostgres(?:ql)?:\/\/[^:\s/]+:[^@\s/]+@/i,
];
for (const f of files) {
  if (f.status === 'D' || /\.env\.example$/i.test(f.path) || f.path.startsWith('docs/')) continue;
  const diff = diffFor(f.path);
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of added) {
    for (const re of secretPatterns) {
      if (re.test(line)) {
        add('CRITICAL', 'SEC-03', f.path, 'possivel segredo/credencial adicionado: ' + line.slice(0, 120));
        break;
      }
    }
  }
}

/* 7. Afrouxamento de asserts de seguranca em testes. */
const touchedTests = files.filter((f) => /(^|\/)(test|tests|__tests__|e2e)\//.test(f.path) || /\.(test|spec)\./.test(f.path));
for (const f of touchedTests) {
  const diff = diffFor(f.path);
  if (!diff) continue;
  const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
  const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  const hardened = removed.filter((l) => /assert\.\w+\([^,]+,\s*(401|403|503)\)/.test(l));
  const relaxed = added.filter((l) => /assert\.\w+\([^,]+,\s*(200|204)\)/.test(l));
  if (hardened.length && relaxed.length) {
    add('HIGH', 'TEST-01', f.path,
      'assert de seguranca (401/403/503) trocado por sucesso (200/204). Justifique ou reverta; teste nao pode mascarar regressao.');
  }
  const removedAsserts = removed.filter((l) => /assert\./.test(l)).length;
  const addedAsserts = added.filter((l) => /assert\./.test(l)).length;
  if (removedAsserts > addedAsserts) {
    add('MEDIUM', 'TEST-02', f.path,
      'diff remove mais asserts do que adiciona (' + removedAsserts + ' removidos, ' + addedAsserts + ' adicionados). Revise.');
  }
}

/* 8. Sintaxe de todo JS alterado. */
for (const f of files) {
  if (f.status === 'D') continue;
  if (!f.path.toLowerCase().endsWith('.js')) continue;
  if (!exists(f.path)) continue;
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, f.path)], { encoding: 'utf8' });
  if (result.status !== 0) {
    add('CRITICAL', 'SYN-01', f.path, 'falha de sintaxe: ' + String(result.stderr || '').split('\n')[0]);
  }
}

/* ================================================================== */
/* 9. INVARIANTES DE ESTADO                                          */
/*    Rodam sempre, mesmo sem diff: commit ruim nao passa despercebido.*/
/* ================================================================== */

/* 9.1 Escrita de /api/gestao precisa ser autenticada. */
const gestaoSrc = readIf('api/_routes/gestao.js');
if (gestaoSrc) {
  const publicWrite =
    /podeEscrever\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\(\{\s*ok:\s*true/.test(gestaoSrc) ||
    /podeEscrever\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*return\s*\{\s*ok:\s*true/.test(gestaoSrc);
  if (publicWrite) {
    add('CRITICAL', 'STATE-01', 'api/_routes/gestao.js',
      'estado do repositorio permite POST/PUT/DELETE publicos em /api/gestao (podeEscrever -> ok:true).');
  }
}

/* 9.2 Politica global da rota gestao. */
const acSrc = readIf('api/_lib/access-control.js');
if (acSrc) {
  const block = acSrc.match(/PRIVATE_API_ROUTES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  const listed = block ? /['"]gestao['"]/.test(block[1]) : false;
  const explicit = /route\s*===\s*['"]gestao['"]/.test(acSrc);
  if (!listed && !explicit) {
    add('CRITICAL', 'STATE-02', 'api/_lib/access-control.js',
      "apiPolicy() trata 'gestao' como rota publica para qualquer metodo, inclusive escrita.");
  }

  /* 9.3 INTERNAL_PAGES nao pode apontar para pagina inexistente. */
  const pages = [...acSrc.matchAll(/\[['"]([^'"]+\.html)['"]/g)].map((m) => m[1]);
  for (const page of [...new Set(pages)]) {
    if (!exists(page)) {
      add('HIGH', 'STATE-03', 'api/_lib/access-control.js',
        "INTERNAL_PAGES lista '" + page + "', que nao existe. Configuracao de acesso ficou orfa.");
    }
  }
}

/* 9.4 Links internos quebrados em qualquer HTML. */
{
  const htmlFiles = walkHtml('', []);
  const broken = new Map();
  for (const html of htmlFiles) {
    const body = readIf(html);
    if (!body) continue;
    const matches = [...body.matchAll(/href\s*=\s*["']([^"'#?]+\.html)["']/gi)];
    for (const m of matches) {
      const target = m[1].trim();
      if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
      if (!exists(target) && !exists(path.join(path.dirname(html), target))) {
        if (!broken.has(target)) broken.set(target, []);
        broken.get(target).push(html);
      }
    }
  }
  for (const [target, sources] of broken) {
    add('HIGH', 'STATE-04', target,
      'link interno aponta para pagina inexistente. Referenciado em: ' + sources.slice(0, 5).join(', ') +
      (sources.length > 5 ? ' (+' + (sources.length - 5) + ')' : ''));
  }
}

/* 9.5 Artefatos proibidos que ja estao versionados (git ls-files). */
{
  let tracked = '';
  try {
    tracked = git(['-c', 'core.quotepath=false', 'ls-files']);
  } catch { /* ignore */ }
  tracked.split('\n').filter(Boolean).forEach((file) => {
    if (/(^|\/)(__test|__tmp|tmp_)/i.test(file) ||
        /\.html\.html$/i.test(file) ||
        /\.(bak|orig|rej)$/i.test(file) ||
        (/(^|\/)\.env(\.|$)/i.test(file) && !/\.env\.example$/i.test(file))) {
      add('HIGH', 'STATE-05', file, 'artefato/segredo versionado no repositorio.');
    }
  });
}

/* 9.6 Aviso de mudanca ampla sem commit (risco de conflito entre agentes). */
const modified = files.filter((f) => f.status === 'M' || f.status === 'A' || f.status === '?').length;
if (modified > 40) {
  add('MEDIUM', 'COORD-01', '(working tree)',
    modified + ' arquivos alterados sem commit. Alto risco de conflito entre agentes; combine/commit antes de prosseguir.');
}

/* ------------------------------------------------------------------ */
/* Relatorio                                                          */
/* ------------------------------------------------------------------ */

const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

const blocking = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH');
const lines = [];
lines.push('SUPERVISOR GUARD - ' + new Date().toISOString() + ' - modo=' + (STAGED ? 'staged' : 'worktree'));
if (!findings.length) {
  lines.push('OK: nenhuma violacao encontrada.');
} else {
  for (const f of findings) {
    lines.push('[' + f.severity + '] ' + f.rule + ' ' + f.file + ' :: ' + f.message);
  }
}
const report = lines.join('\n');

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, report + '\n\n', 'utf8');
} catch { /* log e best-effort */ }

console.log(report);

if (blocking.length && REASON) {
  console.log('\nBYPASS registrado. Motivo: ' + REASON);
  try {
    fs.appendFileSync(LOG_FILE, 'BYPASS motivo=' + REASON + '\n\n', 'utf8');
  } catch { /* ignore */ }
  process.exit(0);
}

if (blocking.length) {
  console.log('\nBLOQUEADO: ' + blocking.length + ' violacao(oes) CRITICAL/HIGH. Corrija ou use SUPERVISOR_BYPASS="motivo".');
  process.exit(1);
}
