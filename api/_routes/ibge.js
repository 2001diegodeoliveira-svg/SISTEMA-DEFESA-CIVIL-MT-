/* ============================================================
   IBGE / BrasilAPI proxy dedicado (backend).
   GET /api/ibge/estados
   GET /api/ibge/municipios?uf=XX
   GET /api/ibge/malhas/estados
   GET /api/ibge/malhas/estados/XX
   Cache CDN via s-maxage/stale-while-revalidate (origemPara).
   Fallback automático para último JSON válido (X-Stale).
   Observabilidade: saúde registrada em system_config (fonte-saude).
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl, bearerToken } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { origemPara, FONTES } = require('../_lib/origens');
const { readCollection, writeCollection } = require('../_lib/store');

const IBGE_API_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades';
const BRASILAPI_BASE = 'https://brasilapi.com.br/api/ibge/malhas';
const TIMEOUT_MS = 10000;

function validarUF(uf) {
  const v = String(uf || '').trim().toUpperCase();
  if (!/^\d{2}$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 11 && n <= 53 ? v : null;
}

async function buscarOrigemComFallback({ parsed, origemId, timeoutMs, maxBytes }) {
  const origem = FONTES.find(f => f.id === origemId) || { ...FONTES[0] };
  const { buscarOrigem, lerFallback, salvarFallback, registrarSaude, chaveFallback } = require('./proxy');

  try {
    const upstream = await buscarOrigem({ parsed, timeoutMs, maxBytes });
    const buf = upstream.body;
    const contentType = upstream.headers.get('content-type') || 'application/json';

    await registrarSaude(origemId, upstream.ok);

    if (upstream.ok && buf.length <= 5 * 1024 * 1024) {
      try {
        await salvarFallback(chaveFallback(parsed), {
          status: upstream.status,
          contentType,
          base64: buf.toString('base64'),
          salvoEm: new Date().toISOString(),
        });
      } catch {}
    }

    return { upstream, buf, contentType };
  } catch (e) {
    await registrarSaude(origemId, false);
    const velho = await lerFallback(chaveFallback(parsed));
    if (velho && velho.base64) {
      const buf = Buffer.from(velho.base64, 'base64');
      const idadeSeg = Math.max(0, Math.round((Date.now() - Date.parse(velho.salvoEm)) / 1000));
      return {
        upstream: {
          status: velho.status || 200,
          ok: true,
          headers: { get: () => velho.contentType || 'application/json' },
        },
        buf,
        contentType: velho.contentType || 'application/json',
        stale: true,
        idadeSeg,
      };
    }
    throw e;
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const headers = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const url = reqUrl(req);
  console.log('[ibge] raw url:', req.url);
  console.log('[ibge] parsed pathname:', url ? url.pathname : 'none');
  console.log('[ibge] parsed search:', url ? url.search : 'none');
  const path = url ? url.pathname.replace('/api/ibge', '') : '/estados';
  console.log('[ibge] path after replace:', path);
  const params = url ? url.searchParams : new URLSearchParams();

  try {
    let data, ttlSeg, staleSeg, origemId, upstreamUrl;

    if (path === '/estados' || path === '/estados/') {
      origemId = 'ibge';
      upstreamUrl = `${IBGE_API_BASE}/estados?orderBy=nome`;
      const { upstream, buf, contentType, stale, idadeSeg } = await buscarOrigemComFallback({
        parsed: new URL(upstreamUrl),
        origemId,
        timeoutMs: 10000,
        maxBytes: 10 * 1024 * 1024,
      });
      data = JSON.parse(buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(idadeSeg);
      return new Response(JSON.stringify(data), { status: upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': contentType }) });

    } else if (path === '/municipios' || path === '/municipios/') {
      const uf = validarUF(params.get('uf'));
      if (!uf) return jsonResponse(400, { erro: 'Parâmetro uf obrigatório (ex.: 51).' }, origin);
      origemId = 'ibge';
      upstreamUrl = `${IBGE_API_BASE}/estados/${uf}/municipios?orderBy=nome`;
      const { upstream, buf, contentType, stale, idadeSeg } = await buscarOrigemComFallback({
        parsed: new URL(upstreamUrl),
        origemId,
        timeoutMs: 10000,
        maxBytes: 10 * 1024 * 1024,
      });
      data = JSON.parse(buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(idadeSeg);
      return new Response(JSON.stringify(data), { status: upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': contentType }) });

    } else if (path === '/malhas/estados' || path === '/malhas/estados/') {
      origemId = 'brasilapi';
      upstreamUrl = `${BRASILAPI_BASE}/estados?formato=application/vnd.geo+json`;
      const { upstream, buf, contentType, stale, idadeSeg } = await buscarOrigemComFallback({
        parsed: new URL(upstreamUrl),
        origemId,
        timeoutMs: 15000,
        maxBytes: 10 * 1024 * 1024,
      });
      data = JSON.parse(buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(idadeSeg);
      return new Response(JSON.stringify(data), { status: upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': contentType }) });

    } else if (path.startsWith('/malhas/estados/') && path.length > 16) {
      const uf = validarUF(path.slice(16));
      if (!uf) return jsonResponse(400, { erro: 'UF inválida na malha.' }, origin);
      origemId = 'brasilapi';
      upstreamUrl = `${BRASILAPI_BASE}/estados/${uf}?formato=application/vnd.geo+json`;
      const { upstream, buf, contentType, stale, idadeSeg } = await buscarOrigemComFallback({
        parsed: new URL(upstreamUrl),
        origemId,
        timeoutMs: 15000,
        maxBytes: 10 * 1024 * 1024,
      });
      data = JSON.parse(buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(idadeSeg);
      return new Response(JSON.stringify(data), { status: upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': contentType }) });

    } else {
      return jsonResponse(404, { erro: 'Endpoint não encontrado.' }, origin);
    }
  } catch (e) {
    console.error('[ibge]', e.message);
    return jsonResponse(502, { erro: 'Falha ao consultar IBGE/BrasilAPI.', detalhe: e.message }, origin);
  }
});