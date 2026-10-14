/* ============================================================
   Vigilância de DNS das fontes (mitigação do TOCTOU do anti-SSRF).
   GET|POST /api/fontes/vigilancia
   Re-resolve todos os hosts do registro + PROXY_HOSTS, compara com
   a linha de base (doc "fonte-vigilancia") e audita em audit_logs
   quem passar a resolver para faixa privada/reservada.
   Uso: cron externo periódico (ex.: a cada 5 min) ou Vercel Cron
   (ver vercel.json). Fail-seguro: só observa e alarma — nunca
   bloqueia request por aqui.
   Autenticação: se VIGILANCIA_SECRET estiver configurado, exige
   `Authorization: Bearer <secret>` (comparação em tempo constante)
   ou `?secret=`; sem secret, público como /api/fontes/saude (dev).
   NOTA: o Cron da Vercel faz GET sem header customizado — com secret
   configurado, use um agendador externo com Bearer; sem secret, o
   Cron da Vercel funciona direto. Ver docs/APIs.md.
   ============================================================ */
const crypto = require('node:crypto');
const { jsonResponse, bearerToken, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { FONTES } = require('../_lib/origens');
const { readCollection, writeCollection, push } = require('../_lib/store');
const proxyRoute = require('./proxy');

function hostsMonitorados() {
  const doRegistro = [];
  for (const f of FONTES) {
    for (const h of f.hosts || []) doRegistro.push(String(h).toLowerCase());
  }
  const doEnv = String(process.env.PROXY_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...doRegistro, ...doEnv])];
}

function segredoConfere(fornecido, env = process.env) {
  const esperado = String(env.VIGILANCIA_SECRET || '');
  if (!esperado) return true; // sem secret: público (dev / Cron sem header)
  const a = Buffer.from(String(fornecido || ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function autorizado(req, env = process.env) {
  if (!String(env.VIGILANCIA_SECRET || '')) return true;
  const token = bearerToken(req);
  const viaQuery = reqUrl(req)?.searchParams.get('secret');
  return segredoConfere(token, env) || segredoConfere(viaQuery, env);
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!autorizado(req)) {
    return jsonResponse(401, { erro: 'Não autorizado.' }, origin);
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
  }

  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'fonte-vigilancia');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'fonte-vigilancia');
  const linhaBase = (doc && doc.hosts && typeof doc.hosts === 'object') ? doc.hosts : {};

  const hosts = hostsMonitorados();
  const agora = new Date().toISOString();
  const atual = {};
  const achados = [];
  for (const host of hosts) {
    const veredito = await proxyRoute.verificarAlvo({ hostname: host });
    atual[host] = { ok: veredito.ok, motivo: veredito.ok ? null : veredito.motivo, em: agora };
    const antes = linhaBase[host];
    if (!veredito.ok) {
      achados.push({ host, motivo: veredito.motivo, antesOk: !!(antes && antes.ok) });
    } else if (antes && antes.ok === false) {
      achados.push({ host, motivo: 'voltou a resolver para faixa pública', recuperado: true });
    }
  }

  resto.push({ id: 'fonte-vigilancia', hosts: atual, updatedAt: agora });
  await writeCollection('system_config', resto);

  for (const a of achados.filter((x) => !x.recuperado)) {
    try {
      await push('audit_logs', {
        id: `vigilancia-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        action: 'fonte.vigilancia',
        metadata: { host: a.host, motivo: a.motivo, antesOk: a.antesOk, horario: agora },
        createdAt: agora,
      });
    } catch {
      /* auditoria best-effort */
    }
  }

  return jsonResponse(200, {
    verificados: hosts.length,
    achados,
    atualizadoEm: agora,
  }, origin);
});
