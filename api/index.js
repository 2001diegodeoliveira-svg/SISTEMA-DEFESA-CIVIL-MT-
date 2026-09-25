/* ============================================================
   Roteador central (single serverless function — Hobby max 12).
   Todas as rotas /api/* são atendidas por ESTA função, que
   despacha para os handlers em ./_routes conforme o caminho.
   ============================================================ */
const { serve } = require('./_lib/serverless');
const { corsHeaders } = require('./_lib/http');

const handlers = {
  'auth/login': require('./_routes/auth/login'),
  'auth/logout': require('./_routes/auth/logout'),
  'auth/me': require('./_routes/auth/me'),
  'alertas': require('./_routes/alertas'),
  'areas': require('./_routes/areas'),
  'occurrences': require('./_routes/occurrences'),
  'reports': require('./_routes/reports'),
  'proxy': require('./_routes/proxy'),
  'waze': require('./_routes/waze'),
  'tomtom': require('./_routes/tomtom'),
  'gestao': require('./_routes/gestao'),
  'inmet-chuva': require('./_routes/inmet-chuva'),
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
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const { route, query } = parseRoute(req);
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

  let target = null;
  if (handlers[route]) target = handlers[route];
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