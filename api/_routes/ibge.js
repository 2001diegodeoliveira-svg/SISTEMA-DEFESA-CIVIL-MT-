/* ============================================================
   IBGE / BrasilAPI proxy interno - teste mínimo.
   ============================================================ */
const { jsonResponse, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const headers = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const url = reqUrl(req);
  const path = url ? url.pathname.replace('/api/ibge', '') : '/estados';

  console.log('[ibge] path:', path);

  try {
    // Teste de fetch simples
    if (path === '/estados' || path === '/estados/') {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        console.log('[ibge] testing fetch to brasilapi...');
        const res = await fetch('https://brasilapi.com.br/api/ibge/uf/v1', {
          headers: { 'User-Agent': 'SGIProtege/1.0', Accept: 'application/json' },
          signal: ctrl.signal,
          redirect: 'follow',
        });
        console.log('[ibge] fetch status:', res.status);
        if (!res.ok) throw new Error(`BrasilAPI HTTP ${res.status}`);
        const data = await res.json();
        console.log('[ibge] data length:', data.length);
        return jsonResponse(200, { teste: 'ok', count: data.length }, origin);
      } catch (e) {
        console.error('[ibge] fetch failed:', e.message, e.stack);
        return jsonResponse(502, { erro: 'Fetch failed', detalhe: e.message }, origin);
      } finally {
        clearTimeout(timer);
      }
    }

    return jsonResponse(404, { erro: 'Endpoint não encontrado.' }, origin);
  } catch (e) {
    console.error('[ibge] error:', e.message, e.stack);
    return jsonResponse(502, { erro: 'Falha interna', detalhe: e.message }, origin);
  }
});