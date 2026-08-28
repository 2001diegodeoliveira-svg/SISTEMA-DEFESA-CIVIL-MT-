/* ============================================================
   Proxy CORS — resolve chamadas a APIs externas que não enviam
   cabeçalhos CORS para o navegador.
   GET /api/proxy?url=<encodada>&raw=1
   - Busca a URL no servidor (sem restrição de CORS) e devolve
     o conteúdo com cabeçalhos CORS permissivos.
   - raw=1 devolve o corpo como está (CSV/XML/imagem).
   Uso no frontend:  dcProxyFetch('https://api.externa.com/...')
   ============================================================ */
const { corsHeaders, reqUrl } = require('./_lib/http');
const { serve } = require('./_lib/serverless');

const ALLOWED_HOSTS = (process.env.PROXY_HOSTS || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);

function hostAllowed(host) {
    if (!ALLOWED_HOSTS.length) return true; // sem restrição (padrão dev)
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function rewriteUrl(url) {
    // Habilita modo cors-friendly p/ alguns provedores que exigem Auth header
    return url;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const headers = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ erro: 'Método não permitido.' }), { status: 405, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }

  const url = reqUrl(req);
  const target = url && url.searchParams.get('url');
  const raw = url && url.searchParams.get('raw') === '1';

  if (!target) {
    return new Response(JSON.stringify({ erro: 'Informe o parâmetro ?url=' }), { status: 400, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }

  let parsed;
  try { parsed = new URL(target); } catch (e) {
    return new Response(JSON.stringify({ erro: 'URL inválida.' }), { status: 400, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response(JSON.stringify({ erro: 'Protocolo não suportado.' }), { status: 400, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
  if (!hostAllowed(parsed.hostname)) {
    return new Response(JSON.stringify({ erro: 'Domínio não permitido no proxy.' }), { status: 403, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }

  try {
    const upstream = await fetch(rewriteUrl(target), {
      headers: {
        'User-Agent': 'DefesaCivilMT/1.0 (+painel-operacional)',
        'Accept': '*/*',
      },
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    return new Response(buf, {
      status: 200,
      headers: Object.assign({}, headers, {
        'Content-Type': raw ? contentType : contentType,
        'X-Upstream-Status': String(upstream.status),
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: 'Falha ao buscar a origem: ' + e.message }), { status: 502, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
});
