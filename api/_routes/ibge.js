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

const BRASILAPI_BASE = 'https://brasilapi.com.br/api/ibge';
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

  try {
    const url = reqUrl(req);
    const path = url ? url.pathname.replace('/api/ibge', '') : '/estados';
    const params = url ? url.searchParams : new URLSearchParams();

    // Health check endpoint
    if (path === '/health') {
      return jsonResponse(200, { status: 'ok', timestamp: new Date().toISOString() }, origin);
    }

    let data, ttlSeg, staleSeg, origemId, upstreamUrl;

    if (path === '/estados' || path === '/estados/') {
      origemId = 'brasilapi';
      upstreamUrl = `${BRASILAPI_BASE}/uf/v1`;
      let result;
      try {
        result = await buscarOrigemComFallback({
          parsed: new URL(upstreamUrl),
          origemId,
          timeoutMs: 10000,
          maxBytes: 10 * 1024 * 1024,
        });
      } catch (e) {
        // Fallback estático com todos os 27 estados
        data = [
          { id: 11, sigla: 'RO', nome: 'Rondônia' }, { id: 12, sigla: 'AC', nome: 'Acre' },
          { id: 13, sigla: 'AM', nome: 'Amazonas' }, { id: 14, sigla: 'RR', nome: 'Roraima' },
          { id: 15, sigla: 'PA', nome: 'Pará' }, { id: 16, sigla: 'AP', nome: 'Amapá' },
          { id: 17, sigla: 'TO', nome: 'Tocantins' }, { id: 21, sigla: 'MA', nome: 'Maranhão' },
          { id: 22, sigla: 'PI', nome: 'Piauí' }, { id: 23, sigla: 'CE', nome: 'Ceará' },
          { id: 24, sigla: 'RN', nome: 'Rio Grande do Norte' }, { id: 25, sigla: 'PB', nome: 'Paraíba' },
          { id: 26, sigla: 'PE', nome: 'Pernambuco' }, { id: 27, sigla: 'AL', nome: 'Alagoas' },
          { id: 28, sigla: 'SE', nome: 'Sergipe' }, { id: 29, sigla: 'BA', nome: 'Bahia' },
          { id: 31, sigla: 'MG', nome: 'Minas Gerais' }, { id: 32, sigla: 'ES', nome: 'Espírito Santo' },
          { id: 33, sigla: 'RJ', nome: 'Rio de Janeiro' }, { id: 35, sigla: 'SP', nome: 'São Paulo' },
          { id: 41, sigla: 'PR', nome: 'Paraná' }, { id: 42, sigla: 'SC', nome: 'Santa Catarina' },
          { id: 43, sigla: 'RS', nome: 'Rio Grande do Sul' }, { id: 50, sigla: 'MS', nome: 'Mato Grosso do Sul' },
          { id: 51, sigla: 'MT', nome: 'Mato Grosso' }, { id: 52, sigla: 'GO', nome: 'Goiás' },
          { id: 53, sigla: 'DF', nome: 'Distrito Federal' }
        ];
        return jsonResponse(200, data, origin, { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400', 'X-Stale': '1', 'X-Stale-Source': 'static-fallback' });
      }
      data = JSON.parse(result.buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (result.stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(result.idadeSeg);
      return new Response(JSON.stringify(data), { status: result.upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': result.contentType }) });

    } else if (path === '/municipios' || path === '/municipios/') {
      const uf = validarUF(params.get('uf'));
      if (!uf) return jsonResponse(400, { erro: 'Parâmetro uf obrigatório (ex.: 51).' }, origin);
      origemId = 'brasilapi';
      upstreamUrl = `${BRASILAPI_BASE}/municipios/v1/${uf}`;
      let result;
      try {
        result = await buscarOrigemComFallback({
          parsed: new URL(upstreamUrl),
          origemId,
          timeoutMs: 10000,
          maxBytes: 10 * 1024 * 1024,
        });
      } catch (e) {
        // Fallback estático para MT se tudo falhar
        if (uf === '51') {
          data = [{ id: 5103402, nome: 'Cuiabá' }, { id: 5106207, nome: 'Várzea Grande' }, { id: 5107007, nome: 'Rondonópolis' }];
          return jsonResponse(200, data, origin, { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400', 'X-Stale': '1', 'X-Stale-Source': 'static-fallback' });
        }
        throw e;
      }
      data = JSON.parse(result.buf.toString('utf8'));
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (result.stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(result.idadeSeg);
      return new Response(JSON.stringify(data), { status: result.upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': result.contentType }) });

    } else if (path === '/malhas/estados' || path === '/malhas/estados/') {
      origemId = 'brasilapi';
      upstreamUrl = `${BRASILAPI_BASE}/malhas/estados?formato=application/vnd.geo+json`;
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
      upstreamUrl = `${BRASILAPI_BASE}/malhas/estados/${uf}?formato=application/vnd.geo+json`;
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
    console.error('[ibge] handler error:', e.message, e.stack);
    return jsonResponse(500, { erro: 'Erro interno no proxy IBGE.', detalhe: e.message }, origin);
  }
});