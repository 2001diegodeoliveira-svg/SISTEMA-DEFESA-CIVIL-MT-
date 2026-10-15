/* ============================================================
   IBGE / BrasilAPI proxy interno (server-side, sem redirect loop).
   GET /api/ibge/estados
   GET /api/ibge/municipios?uf=51
   GET /api/ibge/municipios/todos
   GET /api/ibge/malha/estados
   GET /api/ibge/malha/municipios?uf=51
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const BRASILAPI_BASE = 'https://brasilapi.com.br/api/ibge';
const TIMEOUT_MS = 10000;

async function fetchBrasilApi(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BRASILAPI_BASE + path, {
      headers: { 'User-Agent': 'SGIProtege/1.0', Accept: 'application/json' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`BrasilAPI HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function validarLista(valor, desc) {
  if (!Array.isArray(valor)) throw new Error('Resposta inválida: ' + desc);
  return valor;
}

function validarMalha(valor, desc) {
  if (!valor || valor.type !== 'FeatureCollection' || !Array.isArray(valor.features)) {
    throw new Error('Malha inválida: ' + desc);
  }
  return valor;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const headers = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const url = reqUrl(req);
  const path = url ? url.pathname.replace('/api/ibge', '') : '/estados';
  const params = url ? url.searchParams : new URLSearchParams();

  console.log('[ibge] path:', path, 'params:', Object.fromEntries(params));

  try {
    let data, ttl = 86400, stale = 86400;

    if (path === '/estados' || path === '/estados/') {
      data = await fetchBrasilApi('/uf/v1');
      validarLista(data, 'estados');
    } else if (path === '/municipios' || path === '/municipios/') {
      const uf = params.get('uf');
      if (uf === 'todos' || !uf) {
        data = await fetchBrasilApi('/municipios/v1');
      } else {
        data = await fetchBrasilApi('/municipios/v1/' + encodeURIComponent(uf));
      }
      validarLista(data, 'municípios');
    } else if (path === '/malha/estados' || path === '/malha/estados/') {
      data = await fetchBrasilApi('/malhas/estados?formato=application/vnd.geo+json');
      validarMalha(data, 'estados');
    } else if (path === '/malha/municipios' || path === '/malha/municipios/') {
      const uf = params.get('uf');
      if (!uf) return jsonResponse(400, { erro: 'Informe uf' }, origin);
      data = await fetchBrasilApi('/malhas/estados/' + encodeURIComponent(uf) + '?formato=application/vnd.geo+json');
      validarMalha(data, 'municípios da UF');
    } else {
      return jsonResponse(404, { erro: 'Endpoint não encontrado.' }, origin);
    }

    return jsonResponse(200, data, origin, { 'Cache-Control': cacheHeaders(ttl, stale)['Cache-Control'] });
  } catch (e) {
    console.error('[ibge] error:', e.message, e.stack);
    return jsonResponse(502, { erro: 'Falha ao consultar BrasilAPI/IBGE.', detalhe: e.message }, origin);
  }
});