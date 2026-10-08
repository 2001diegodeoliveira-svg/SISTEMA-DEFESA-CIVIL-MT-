/* ============================================================
   Proxy CORS ” resolve chamadas a APIs externas que não enviam
   cabeçalhos CORS para o navegador.
   GET /api/proxy?url=<encodada>&raw=1
   - Busca a URL no servidor (sem restrição de CORS) e devolve
     o conteúdo com cabeçalhos CORS permissivos.
   - raw=1 devolve o corpo como está (CSV/XML/imagem).
   Uso no frontend:  dcProxyFetch('https://api.externa.com/...')
   ============================================================ */
const { corsHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

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

const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;

// Tenta buscar a origem com timeout; refaz 1 tentativa em caso de falha de rede/timeout.
async function fetchUpstream(target, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            return await fetch(rewriteUrl(target), {
                headers: {
                    'User-Agent': 'SGIProtege/1.0 (+painel-operacional)',
                    'Accept': '*/*',
                },
                redirect: 'manual',
                signal: ctrl.signal,
            });
        } catch (e) {
            if (i === attempts - 1) throw e;
        } finally {
            clearTimeout(timer);
        }
    }
}

async function readUpstreamBody(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BYTES) {
    throw new Error('Resposta da origem excede o limite permitido.');
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPSTREAM_BYTES) {
      try { await reader.cancel(); } catch { /* resposta já encerrada */ }
      throw new Error('Resposta da origem excede o limite permitido.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
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
    const upstream = await fetchUpstream(target);
    if (upstream.status >= 300 && upstream.status < 400) {
      throw new Error('Redirecionamentos da origem não são permitidos.');
    }
    const buf = await readUpstreamBody(upstream);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    return new Response(buf, {
      status: upstream.status,
      headers: Object.assign({}, headers, {
        'Content-Type': raw ? contentType : contentType,
        'X-Upstream-Status': String(upstream.status),
      }),
    });
  } catch (e) {
    console.error('[proxy] falha ao buscar a origem:', e && e.message);
    return new Response(JSON.stringify({ erro: 'Falha ao buscar a origem.' }), { status: 502, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
});
