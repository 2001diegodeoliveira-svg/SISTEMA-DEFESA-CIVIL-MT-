/* ============================================================
   Proxy CORS — resolve chamadas a APIs externas que não enviam
   cabeçalhos CORS para o navegador.
   GET /api/proxy?url=<encodada>&raw=1
   - Busca a URL no servidor (sem restrição de CORS) e devolve
     o conteúdo com cabeçalhos CORS permissivos.
   - raw=1 devolve o corpo como está (CSV/XML/imagem).
   - Cache CDN por fonte (ver api/_lib/origens.js): s-maxage +
     stale-while-revalidate; headers X-Fonte e X-Upstream-*.
   - Fallback para o último dado válido (X-Stale: 1) quando a
     origem cai; senão 502 como antes.
   Uso no frontend:  dcProxyFetch('https://api.externa.com/...')
   ============================================================ */
const { corsHeaders, cacheHeaders, reqUrl } = require('../_lib/http');
const { origemPara } = require('../_lib/origens');
const { readCollection, writeCollection } = require('../_lib/store');
const { serve } = require('../_lib/serverless');

const ALLOWED_HOSTS_ENV = 'PROXY_HOSTS';

function allowedHosts() {
  return (process.env[ALLOWED_HOSTS_ENV] || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(host) {
  const allowed = allowedHosts();
  if (!allowed.length) return true; // sem restrição (padrão dev)
  return allowed.some((h) => host === h || host.endsWith('.' + h));
}

function rewriteUrl(url) {
    // Habilita modo cors-friendly p/ alguns provedores que exigem Auth header
    return url;
}

const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;
/* Teto do fallback "último válido" (KV viaja na URL: corpos
   gigantes quebrariam o driver kv; acima disso, sem stale). */
const MAX_FALLBACK_BYTES = 256 * 1024;

// Tenta buscar a origem com timeout; refaz 1 tentativa em caso de falha de rede/timeout.
async function fetchUpstream(target, timeoutMs, attempts = 2) {
    const limite = Number(timeoutMs) > 0 ? Number(timeoutMs) : UPSTREAM_TIMEOUT_MS;
    for (let i = 0; i < attempts; i++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), limite);
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

async function readUpstreamBody(response, maxBytes) {
  const limite = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_UPSTREAM_BYTES;
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limite) {
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
    if (size > limite) {
      try { await reader.cancel(); } catch { /* resposta já encerrada */ }
      throw new Error('Resposta da origem excede o limite permitido.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

/* Saúde por fonte (lido por GET /api/fontes/saude).
   Escrita com throttle: no máximo 1 vez/min por fonte, exceto
   quando o estado ok<->falha vira (registra na hora). */
const SAUDE_THROTTLE_MS = 60000;
const saudeCache = {}; // { [origemId]: { ok, ts } }

async function registrarSaude(origemId, ok, latenciaMs) {
  const agora = Date.now();
  const anterior = saudeCache[origemId];
  if (anterior && anterior.ok === ok && agora - anterior.ts < SAUDE_THROTTLE_MS) return;
  saudeCache[origemId] = { ok, ts: agora };
  try {
    const col = await readCollection('system_config');
    const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'fonte-saude');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'fonte-saude');
    const fontes = (doc && doc.fontes && typeof doc.fontes === 'object') ? { ...doc.fontes } : {};
    const atual = fontes[origemId] || {};
    const iso = new Date(agora).toISOString();
    fontes[origemId] = ok
      ? { ...atual, ultimoSucesso: iso, latenciaMs: latenciaMs != null ? latenciaMs : (atual.latenciaMs ?? null) }
      : { ...atual, ultimaFalha: iso };
    resto.push({ id: 'fonte-saude', fontes, updatedAt: iso });
    await writeCollection('system_config', resto);
  } catch (e) {
    console.error('[proxy] falha ao registrar saúde:', e && e.message);
  }
}

/* Fallback "último válido": doc em system_config (mapeado no pg).
   Chave por host+path (query ignorada p/ não explodir o volume). */
function chaveFallback(parsed) {
  return 'proxy-fallback:' + parsed.hostname.toLowerCase() + parsed.pathname;
}

async function lerFallback(chave) {
  const col = await readCollection('system_config');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === chave);
  return doc && doc.corpo ? doc.corpo : null;
}

async function salvarFallback(chave, corpo) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== chave);
  resto.push({ id: chave, corpo, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
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

  // Config de cache/timeout por fonte (default seguro p/ hosts novos).
  const origem = origemPara(parsed.hostname);

  try {
    const inicio = Date.now();
    const upstream = await fetchUpstream(target, origem.timeoutMs);
    if (upstream.status >= 300 && upstream.status < 400) {
      throw new Error('Redirecionamentos da origem não são permitidos.');
    }
    const buf = await readUpstreamBody(upstream, origem.maxBytes);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const latenciaMs = Date.now() - inicio;
    await registrarSaude(origem.id, upstream.ok, latenciaMs);

    // Guarda o último válido para fallback (X-Stale) — corpos
    // grandes demais pulam o fallback, mas ainda são servidos.
    if (upstream.ok && buf.length <= MAX_FALLBACK_BYTES) {
      try {
        await salvarFallback(chaveFallback(parsed), {
          status: upstream.status,
          contentType,
          base64: buf.toString('base64'),
          salvoEm: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[proxy] falha ao guardar fallback:', e && e.message);
      }
    }

    return new Response(buf, {
      status: upstream.status,
      headers: Object.assign({}, headers, cacheHeaders(origem.ttlSeg, origem.staleSeg), {
        'Content-Type': contentType,
        'X-Fonte': origem.id,
        'X-Upstream-Status': String(upstream.status),
        'X-Upstream-Latency-Ms': String(latenciaMs),
      }),
    });
  } catch (e) {
    console.error('[proxy] falha ao buscar a origem:', e && e.message);
    await registrarSaude(origem.id, false);
    // Fallback: último dado válido, sinalizado como antigo.
    try {
      const velho = await lerFallback(chaveFallback(parsed));
      if (velho && velho.base64) {
        const buf = Buffer.from(velho.base64, 'base64');
        const idadeSeg = Math.max(0, Math.round((Date.now() - Date.parse(velho.salvoEm)) / 1000));
        return new Response(buf, {
          status: velho.status || 200,
          headers: Object.assign({}, headers, { 'Cache-Control': 'public, s-maxage=60' }, {
            'Content-Type': velho.contentType || 'application/octet-stream',
            'X-Fonte': origem.id,
            'X-Upstream-Status': String(velho.status || 200),
            'X-Stale': '1',
            'X-Stale-Age-Seg': String(idadeSeg),
          }),
        });
      }
    } catch (e2) {
      console.error('[proxy] falha ao ler fallback:', e2 && e2.message);
    }
    return new Response(JSON.stringify({ erro: 'Falha ao buscar a origem.' }), { status: 502, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
});
