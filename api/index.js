/* ============================================================
   Roteador central (single serverless function — Hobby max 12).
   Todas as rotas /api/* são atendidas por ESTA função, que
   despacha para os handlers em ./_routes conforme o caminho.
   ============================================================ */
const { serve } = require('./_lib/serverless');
const { corsHeaders, bearerToken } = require('./_lib/http');
const { isLoginEnabled, validateProductionConfig } = require('./_lib/runtime-config');
const { verifyToken, isLoginEligible } = require('./_lib/auth');
const { readCollection } = require('./_lib/store');

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value != null) return value;
  }
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value.join(', ') : (value == null ? undefined : String(value));
}

const handlers = {
  'auth/login': require('./_routes/auth/login'),
  'auth/logout': require('./_routes/auth/logout'),
  'auth/me': require('./_routes/auth/me'),
  'user-registrations': require('./_routes/user-registrations'),
  'alertas': require('./_routes/alertas'),
  'areas': require('./_routes/areas'),
  'occurrences': require('./_routes/occurrences'),
  'reports': require('./_routes/reports'),
  'proxy': require('./_routes/proxy'),
  'waze': require('./_routes/waze'),
  'tomtom': require('./_routes/tomtom'),
  'gestao': require('./_routes/gestao'),
  'noticias': require('./_routes/noticias'),
  'inmet-chuva': require('./_routes/inmet-chuva'),
  'pluv-alerta': require('./_routes/pluv-alerta'),
  'pluv-alerta/avaliar': require('./_routes/pluv-alerta-avaliar'),
};

const areasIdHandler = require('./_routes/areas/[id]');

/* Extrai { route, query } a partir do req.url.
   A Vercel preserva o URL original E adiciona "?path=" com a rota;
   o Express (server.js) passa URLs absolutas; o runtime clássico
   usa "/api/<rota>?queries". Devolve a rota normalizada e a query
   string original limpa (sem o param "path" injetado pela Vercel). */
function parseRoute(req) {
  let raw = String(req && req.url ? req.url : '');
  const abs = raw.match(/^https?:\/\//i);
  let pathQuery = '';
  if (abs) {
    try {
      const u = new URL(raw);
      raw = u.pathname;
      pathQuery = u.searchParams.get('path') || '';
    } catch { /* mantém raw */ }
  } else {
    const qi = raw.indexOf('?');
    if (qi >= 0) {
      const pm = raw.slice(qi + 1).match(/path=([^&]*)/);
      if (pm) pathQuery = decodeURIComponent(pm[1]);
      raw = raw.slice(0, qi);
    }
  }

  let route;
  if (pathQuery) route = pathQuery.split('/').filter(Boolean).join('/');
  else {
    const clean = raw.split('#')[0].replace(/^\/+/, '').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts[0] === 'api') parts.shift();
    if (parts[0] === 'index') parts.shift();
    route = parts.join('/');
  }

  /* Query original (ex: visao=geral, ano=2026, municipio=, action=).
     Na Vercel está anexada ao mesmo req.url original; no Express vem
     de req.url absoluto. Remove o param "path" antes de repassar. */
  let query = '';
  try {
    const u = new URL(req.url, 'http://localhost');
    u.searchParams.delete('path');
    query = u.searchParams.toString();
  } catch { /* sem query */ }

  return { route, query };
}

module.exports = serve(async function handler(req) {
  const origin = readHeader(req.headers, 'origin');

  const configProblems = validateProductionConfig();
  if (configProblems.length) {
    return new Response(JSON.stringify({ erro: 'Backend não configurado para produção.', detalhes: configProblems }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const { route, query } = parseRoute(req);
  const production = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  const loginEnabled = isLoginEnabled();
  let configuredAdmin = false;
  try {
    const seeds = JSON.parse(process.env.SEED_USERS || '[]');
    configuredAdmin = Array.isArray(seeds) && seeds.some((user) => user && user.perfil === 'admin');
  } catch {}
  if (production && loginEnabled && !configuredAdmin) {
    try {
      const users = await readCollection('users');
      if (!users.some((user) => user.perfil === 'admin' && isLoginEligible(user))) {
        return new Response(JSON.stringify({
          erro: 'Backend não configurado para produção.',
          detalhes: ['Configure um administrador ativo via SEED_USERS ou promova um bootstrap admin persistido.'],
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    } catch (error) {
      // Registra o motivo real (sem credenciais) para diagnóstico nos logs.
      console.error('[bootstrap-admin] falha ao consultar o banco:', error && error.message);
      return new Response(JSON.stringify({
        erro: 'Backend não configurado para produção.',
        detalhes: ['Banco persistente indisponível para validar o administrador bootstrap.'],
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (payload && loginEnabled) {
    const users = await readCollection('users');
    const user = users.find((item) => String(item.id) === String(payload.sub));
    if (!isLoginEligible(user)) {
      return new Response(JSON.stringify({ erro: 'Conta suspensa ou sem cadastro aprovado.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  if (route === '') {
    return new Response(JSON.stringify({ erro: 'API Defesa Civil MT.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  /* Request clonado com URL canônica "/api/<rota>?<query original>".
     Garante que os sub-handlers leiam id do pathname e queries corretos
     tanto no Express quanto na Vercel. */
  const clone = Object.create(req);
  clone.url = '/api/' + route + (query ? '?' + query : '');
  const authorization = readHeader(req.headers, 'authorization') ||
    (loginEnabled ? undefined : 'Bearer access-without-login');
  clone.headers = {
    get: (name) => name.toLowerCase() === 'authorization'
      ? authorization || null
      : readHeader(req.headers, name) || null,
  };

  let target = null;
  if (handlers[route]) target = handlers[route];
  else if (route.startsWith('user-registrations/')) target = handlers['user-registrations'];
  else {
    const m = route.match(/^areas\/([^/]+)$/);
    if (m) target = areasIdHandler;
  }

  if (target) return target(clone);

  return new Response(JSON.stringify({ erro: 'Rota não encontrada: /api/' + route }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
});