/* ============================================================
   Proxy CORS — resolve chamadas a APIs externas que não enviam
   cabeçalhos CORS para o navegador.
   GET /api/proxy?url=<encodada>&raw=1
   - Busca a URL no servidor (sem restrição de CORS) e devolve
     o conteúdo com cabeçalhos CORS permissivos.
   - raw=1 (ou omitido): devolve o corpo como está, binário
     (CSV/XML/imagem/JSON da origem). O parâmetro existe por
     compatibilidade com js/proxy.js (que sempre o envia) e é
     refletido em X-Proxy-Raw.
   - Cache CDN por fonte (ver api/_lib/origens.js): s-maxage +
     stale-while-revalidate; headers X-Fonte e X-Upstream-*.
   - Fallback para o último dado válido (X-Stale: 1) quando a
     origem cai; senão 502 como antes.
   - Anti-SSRF: nega IPs literais/internos, nomes locais e
     hostnames que resolvem para faixa privada (ver abaixo).
     Em produção sem PROXY_HOSTS, recusa tudo com 503.
   Uso no frontend:  dcProxyFetch('https://api.externa.com/...')
   ============================================================ */
const dns = require('dns');
const { corsHeaders, cacheHeaders, reqUrl } = require('../_lib/http');
const { origemPara } = require('../_lib/origens');
const { readCollection, writeCollection } = require('../_lib/store');
const { serve } = require('../_lib/serverless');

const ALLOWED_HOSTS_ENV = 'PROXY_HOSTS';

function emProducao() {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

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

/* ---------- anti-SSRF ----------
   NOTA TÉCNICA (TOCTOU): o `fetch` global (undici interno do Node)
   não aceita `lookup`/Agent customizado sem o pacote `undici`
   (dependência nova, vetada aqui), e reescrever o fetch sobre
   http.request seria um rewrite arriscado do streaming/timeout/
   redirect. Por isso o pin por conexão NÃO é feito: a checagem
   DNS prévia barra literais, nomes locais e resolved-para-privado,
   e redirects são negados — mas um DNS que mudar entre a checagem
   e o fetch (rebinding) não seria pego. Mitigação adotada:
   POST /api/fontes/vigilancia re-resolve periodicamente todos os
   hosts e audita quem passar a apontar para faixa privada. */
// Resolvedor injetável (testes substituem via definirResolvedor).
const resolvedorPadrao = (host) => dns.promises.lookup(host, { all: true }).then((r) => r.map((x) => x.address));
let resolvedor = resolvedorPadrao;
function definirResolvedor(fn) {
  resolvedor = typeof fn === 'function' ? fn : resolvedorPadrao;
}

function parteNumIPv4(p) {
  const t = String(p || '').trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  if (/^0[0-9]+$/.test(t)) {
    const n = parseInt(t, 8);
    return Number.isFinite(n) ? n : NaN;
  }
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return NaN;
}

/* Interpreta formas numéricas de IPv4 (regras inet_aton: decimal,
   octal, hexadecimal e inteiro de 32 bits), barrando bypass tipo
   http://2130706433/ (= 127.0.0.1). Devolve [b0,b1,b2,b3] ou null. */
function ipv4Flexivel(host) {
  const t = String(host || '').trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 4294967295) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (!t.includes('.')) return null;
  const partes = t.split('.');
  if (partes.length < 2 || partes.length > 4) return null;
  const nums = partes.map(parteNumIPv4);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    return nums;
  }
  // Formas curtas (regras inet_aton): a.b | a.b.c, última parte larga.
  const limites = { 2: 16777216, 3: 65536 };
  if (nums.slice(0, -1).some((n) => n > 255)) return null;
  const ultimo = nums[nums.length - 1];
  if (ultimo >= limites[nums.length]) return null;
  const bytes = [...nums.slice(0, -1)];
  let resto = ultimo;
  const casas = 4 - bytes.length;
  for (let i = casas - 1; i >= 0; i -= 1) {
    const div = 256 ** i;
    bytes.push(Math.floor(resto / div));
    resto %= div;
  }
  return bytes;
}

function ipv4Privado(b) {
  const [a, c, d] = [b[0], b[1], b[2]];
  void d;
  if (a === 0) return 'não-roteável (0.0.0.0/8)';
  if (a === 10) return 'privada (10/8)';
  if (a === 127) return 'loopback (127/8)';
  if (a === 169 && c === 254) return 'link-local/metadata (169.254/16)';
  if (a === 172 && c >= 16 && c <= 31) return 'privada (172.16/12)';
  if (a === 192 && c === 168) return 'privada (192.168/16)';
  if (a === 100 && c >= 64 && c <= 127) return 'compartilhada CGNAT (100.64/10)';
  return null;
}

function ipv6Bloqueado(host) {
  const t = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!t.includes(':')) return null;
  if (t === '::1') return 'loopback (::1)';
  if (t === '::' || t === '::ffff:0.0.0.0') return 'não-roteável (::)';
  if (/^(fe[89ab][0-9a-f]?):/i.test(t)) return 'link-local (fe80::/10)';
  if (/^(fc|fd)[0-9a-f]{0,2}:/i.test(t)) return 'privada (fc00::/7)';
  const m = t.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) {
    const b = ipv4Flexivel(m[1]);
    if (b) return ipv6Bloqueado('x') || ipv4Privado(b);
  }
  return null;
}

const NOMES_BLOQUEADOS = ['localhost'];
// .test/.example (RFC reservados, sem resolução pública) caem no
// fail closed do resolvedor; não bloquear por nome para não quebrar testes.
const SUFIXOS_BLOQUEADOS = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.invalid'];

function nomeBloqueado(host) {
  const t = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (NOMES_BLOQUEADOS.includes(t)) return 'nome local (' + t + ')';
  if (SUFIXOS_BLOQUEADOS.some((s) => t.endsWith(s))) return 'sufixo interno (' + t + ')';
  return null;
}

/** Verifica o alvo contra SSRF. Devolve {ok} ou {ok:false, motivo}. */
async function verificarAlvo(parsed) {
  const host = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return { ok: false, motivo: 'hostname vazio' };
  const nb = nomeBloqueado(host);
  if (nb) return { ok: false, motivo: nb };
  const v6 = ipv6Bloqueado(host);
  if (v6) return { ok: false, motivo: v6 };
  const v4 = ipv4Flexivel(host);
  if (v4) {
    const priv = ipv4Privado(v4);
    if (priv) return { ok: false, motivo: 'IP ' + priv };
    return { ok: true };
  }
  let enderecos;
  try {
    enderecos = await resolvedor(host);
  } catch (e) {
    return { ok: false, motivo: 'destino não resolvido (fail closed)' };
  }
  if (!Array.isArray(enderecos) || !enderecos.length) {
    return { ok: false, motivo: 'destino sem endereço (fail closed)' };
  }
  for (const ip of enderecos) {
    const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
    const b6 = ipv6Bloqueado(s);
    if (b6) return { ok: false, motivo: `resolveu para ${s} (${b6})` };
    const b4 = ipv4Flexivel(s);
    if (b4) {
      const priv = ipv4Privado(b4);
      if (priv) return { ok: false, motivo: `resolveu para ${s} (${priv})` };
    }
  }
  return { ok: true };
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

/* Zera o throttle em memória (testes: elimina estado entre casos). */
function limparSaudeCache() {
  for (const k of Object.keys(saudeCache)) delete saudeCache[k];
}

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
  const rawParam = url ? url.searchParams.get('raw') : null;
  // raw=1 (ou omitido): passthrough binário exato da origem.
  // O parâmetro existe por compatibilidade com js/proxy.js.
  const modoRaw = rawParam === null || rawParam === '1';

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
  if (emProducao() && !allowedHosts().length) {
    return new Response(JSON.stringify({ erro: 'Proxy desativado: configure PROXY_HOSTS em produção.' }), { status: 503, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
  const checagem = await verificarAlvo(parsed);
  if (!checagem.ok) {
    return new Response(JSON.stringify({ erro: 'Destino não permitido no proxy.', motivo: checagem.motivo }), { status: 403, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
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
        'X-Proxy-Raw': modoRaw ? '1' : '0',
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

// Ganchos de teste (SSRF): substituem o resolvedor DNS.
module.exports.verificarAlvo = verificarAlvo;
module.exports.definirResolvedor = definirResolvedor;
module.exports.limparSaudeCache = limparSaudeCache;
module.exports.ipv4Flexivel = ipv4Flexivel;
module.exports.ipv4Privado = ipv4Privado;
