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
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
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
   Duas camadas:
   1. `verificarAlvo` (pré-checagem): nega literais/internos, nomes locais
      e hostnames que resolvem para faixa privada. Dá o 403 explicativo.
   2. `lookupSeguro` (pin na conexão): o transporte nativo (node:http/https)
      resolve o DNS através deste `lookup`, que valida o endereço ANTES de
      devolver para o `connect`. A mesma resolução que valida é a que
      conecta — não existe janela entre checar e conectar, então DNS
      rebinding (TOCTOU) é bloqueado mesmo se o DNS mudar depois da
      pré-checagem. Redirects são seguidos manualmente (limite de saltos)
      com revalidação de allowlist + IP a cada salto.
   Mitigação complementar (detecção tardia): POST|GET /api/fontes/vigilancia
   re-resolve periodicamente os hosts e audita quem apontar p/ faixa privada
   (ver api/_routes/fontes-vigilancia.js). Só observa e alarma. */
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
  const m = t.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const b = ipv4Flexivel(m[1]);
    if (!b) return 'IPv4 mapeado inválido (' + t + ')';
    return ipv4Privado(b);
  }
  return null;
}

/* Validador estrito de IPv6 textual (com ou sem ::, com zona % e com
   dotted-quad embutido). Evita que lixo com ':' passe como "público". */
function ipv6Valido(s) {
  const t = String(s || '').toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (!t.includes(':') || /[^0-9a-f:.]/i.test(t)) return false;
  const partes = t.split('::');
  if (partes.length > 2) return false;
  const temPontos = t.includes('.');
  const checar = (lado) => {
    if (lado === '') return [];
    return lado.split(':');
  };
  const grupos = [...checar(partes[0]), ...checar(partes[1] || '')];
  let pontos = 0;
  for (const g of grupos) {
    if (g.includes('.')) {
      pontos += 1;
      if (!ipv4Flexivel(g)) return false;
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return false;
  }
  if (pontos > 1) return false;
  const total = grupos.length + (pontos ? 1 : 0); // dotted-quad vale por 2 grupos
  if (partes.length === 2) return total < 8;
  return total === 8;
}

/* Veredito unificado para QUALQUER endereço resolvido/conectado.
   Devolve null (liberado) ou o motivo do bloqueio. Cobre: 0/8, 10/8,
   127/8, 169.254/16 (metadata de cloud), 172.16/12, 192.168/16,
   ::1, ::, fe80::/10, fc00::/7 e IPv4 mapeado em IPv6
   (::ffff:10.0.0.1 e forma longa 0:0:0:0:0:ffff:10.0.0.1). */
function motivoEnderecoBloqueado(endereco) {
  const s = String(endereco || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return 'endereço vazio';
  const mapeado = s.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapeado) {
    const b = ipv4Flexivel(mapeado[1]);
    if (!b) return 'IPv4 mapeado inválido (' + s + ')';
    return ipv4Privado(b);
  }
  if (s.includes(':')) {
    if (!ipv6Valido(s)) return 'IPv6 inválido (' + s + ')';
    return ipv6Bloqueado(s);
  }
  const b = ipv4Flexivel(s);
  if (!b) return 'endereço inválido (' + s + ')';
  return ipv4Privado(b);
}

/* Predicado simples (quando só interessa bloquear/liberar). */
function ehIpPrivado(endereco) {
  return motivoEnderecoBloqueado(endereco) !== null;
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
    const motivo = motivoEnderecoBloqueado(ip);
    if (motivo) {
      const s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
      return { ok: false, motivo: `resolveu para ${s} (${motivo})` };
    }
  }
  return { ok: true };
}

const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_BYTES = 10 * 1024 * 1024;
/* Teto do fallback "último válido" (KV viaja na URL: corpos
   gigantes quebrariam o driver kv; acima disso, sem stale). */
const MAX_FALLBACK_BYTES = 256 * 1024;
/* Saltos máximos de redirect seguidos manualmente (cada salto é
   revalidado: allowlist + pré-checagem DNS + pin na conexão). */
const MAX_SALTOS_REDIRECT = 3;

/* ---------- pin de DNS na conexão (fecha o TOCTOU) ----------
   Resolução de baixo nível injetável (uma chamada = um endereço).
   O transporte passa `lookupSeguro` para http/https.request: o endereço
   validado aqui é exatamente o usado pelo `connect`. */
const procurarDnsPadrao = (host) => new Promise((resolve, reject) => {
  dns.lookup(String(host), (err, address, family) => {
    if (err) reject(err);
    else resolve({ address, family });
  });
});
let procurarDns = procurarDnsPadrao;
function definirProcurarDns(fn) {
  procurarDns = typeof fn === 'function' ? fn : procurarDnsPadrao;
}

/* Assinatura de `lookup` do node (hostname, options, callback).
   Falha fechado: IP privado/reservado ou DNS indisponível abortam
   a conexão antes de qualquer byte trafegar.
   Compatível com Happy Eyeballs (Node ≥20 chama com `all: true`
   esperando um array de { address, family }). */
function lookupSeguro(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const emLote = options && typeof options === 'object' && options.all === true;
  procurarDns(String(hostname)).then(
    ({ address }) => {
      const motivo = motivoEnderecoBloqueado(address);
      if (motivo) {
        const erro = new Error('SSRF: conexão bloqueada (' + motivo + ').');
        erro.final = true;
        cb(erro);
        return;
      }
      const limpo = String(address);
      const familia = limpo.includes(':') ? 6 : 4;
      if (emLote) cb(null, [{ address: limpo, family: familia }]);
      else cb(null, limpo, familia);
    },
    (err) => cb(err instanceof Error ? err : new Error('DNS indisponível.'))
  );
}

/* Lê um stream com teto rígido de bytes: estoura → destroy + erro.
   Não confia só em Content-Length (pode mentir ou faltar). */
function coletarCorpoLimitado(stream, limite, aoDestruir) {
  return new Promise((resolve, reject) => {
    const teto = Number(limite) > 0 ? Number(limite) : MAX_UPSTREAM_BYTES;
    const chunks = [];
    let size = 0;
    let encerrado = false;
    const falhar = (erro) => {
      if (encerrado) return;
      encerrado = true;
      try { stream.destroy(); } catch { /* já encerrado */ }
      if (typeof aoDestruir === 'function') {
        try { aoDestruir(); } catch { /* best-effort */ }
      }
      reject(erro);
    };
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > teto) {
        const erro = new Error('Resposta da origem excede o limite permitido.');
        erro.final = true;
        falhar(erro);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (!encerrado) {
        encerrado = true;
        resolve(Buffer.concat(chunks, size));
      }
    });
    stream.on('error', (erro) => falhar(erro));
  });
}

/* Transporte padrão: http/https nativo com o lookup pinado.
   Devolve { status, ok, headers: { get }, body: Buffer }.
   Redirects NÃO são seguidos aqui (o handler segue manualmente). */
function transporteNativo({ parsed, timeoutMs, maxBytes, lookup }) {
  return new Promise((resolve, reject) => {
    let encerrado = false;
    const ok = (valor) => { if (!encerrado) { encerrado = true; resolve(valor); } };
    const falhar = (erro) => { if (!encerrado) { encerrado = true; reject(erro); } };
    const limite = Number(timeoutMs) > 0 ? Number(timeoutMs) : UPSTREAM_TIMEOUT_MS;
    const teto = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_UPSTREAM_BYTES;
    const mod = parsed.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'SGIProtege/1.0 (+painel-operacional)',
          'Accept': '*/*',
        },
        lookup: lookup || lookupSeguro,
      }, (res) => {
        const total = Number(res.headers['content-length']);
        if (Number.isFinite(total) && total > teto) {
          const erro = new Error('Resposta da origem excede o limite permitido.');
          erro.final = true;
          try { req.destroy(); } catch { /* já encerrado */ }
          falhar(erro);
          return;
        }
        coletarCorpoLimitado(res, teto, () => { try { req.destroy(); } catch {} }).then(
          (body) => ok({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            headers: {
              get: (nome) => {
                const valor = res.headers[String(nome || '').toLowerCase()];
                if (Array.isArray(valor)) return valor.join(', ');
                return valor == null ? null : String(valor);
              },
            },
            body,
          }),
          (erro) => falhar(erro)
        );
      });
    } catch (erro) {
      falhar(erro);
      return;
    }
    req.on('error', (erro) => falhar(erro));
    req.setTimeout(limite, () => {
      const erro = new Error('Timeout ao buscar a origem (' + limite + 'ms).');
      try { req.destroy(erro); } catch { /* já encerrado */ }
      falhar(erro);
    });
    req.end();
  });
}

/* Transporte injetável (testes substituem via definirTransporte).
   O mock DEVE chamar `lookup(hostname, {}, cb)` para simular a
   resolução do momento da conexão — é assim que o teste de
   rebinding prova o abort. */
let transporte = transporteNativo;
function definirTransporte(fn) {
  transporte = typeof fn === 'function' ? fn : transporteNativo;
}

/* Busca com 1 retry em falha de rede/timeout. Erros `final`
   (SSRF, limite de corpo, redirect esgotado) nunca repetem. */
async function buscarOrigem({ parsed, timeoutMs, maxBytes, attempts = 2 }) {
  let ultimo = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await transporte({ parsed, timeoutMs, maxBytes, lookup: lookupSeguro });
    } catch (erro) {
      ultimo = erro;
      if ((erro && erro.final) || i === attempts - 1) throw erro;
    }
  }
  throw ultimo;
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

  let atual;
  try { atual = new URL(target); } catch (e) {
    return new Response(JSON.stringify({ erro: 'URL inválida.' }), { status: 400, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }
  if (emProducao() && !allowedHosts().length) {
    return new Response(JSON.stringify({ erro: 'Proxy desativado: configure PROXY_HOSTS em produção.' }), { status: 503, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
  }

  // Config de cache/timeout por fonte (default seguro p/ hosts novos).
  const origem = origemPara(atual.hostname);

  function destinoProibido(parsed, checagem) {
    if (!checagem.ok) {
      return new Response(JSON.stringify({ erro: 'Destino não permitido no proxy.', motivo: checagem.motivo }), { status: 403, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
    }
    if (!hostAllowed(parsed.hostname)) {
      return new Response(JSON.stringify({ erro: 'Domínio não permitido no proxy.' }), { status: 403, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
    }
    return null;
  }

  try {
    const inicio = Date.now();
    let upstream = null;
    /* Redirects seguidos manualmente: cada salto volta para a
       revalidação (protocolo + pré-checagem DNS + allowlist) e a
       conexão de cada salto passa pelo lookup pinado. */
    for (let salto = 0; ; salto++) {
      if (atual.protocol !== 'http:' && atual.protocol !== 'https:') {
        return new Response(JSON.stringify({ erro: 'Protocolo não suportado.' }), { status: 400, headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }) });
      }
      const bloqueado = destinoProibido(atual, await verificarAlvo(atual));
      if (bloqueado) return bloqueado;
      upstream = await buscarOrigem({ parsed: atual, timeoutMs: origem.timeoutMs, maxBytes: origem.maxBytes });
      const redireciona = upstream.status >= 300 && upstream.status < 400
        ? upstream.headers.get('location') : null;
      if (!redireciona) break;
      if (salto >= MAX_SALTOS_REDIRECT) {
        const erro = new Error('Redirecionamentos da origem excedem o limite permitido.');
        erro.final = true;
        throw erro;
      }
      try {
        atual = new URL(redireciona, atual.href);
      } catch (e) {
        const erro = new Error('Destino de redirecionamento inválido.');
        erro.final = true;
        throw erro;
      }
    }
    const buf = upstream.body;
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const latenciaMs = Date.now() - inicio;
    await registrarSaude(origem.id, upstream.ok, latenciaMs);

    // Guarda o último válido para fallback (X-Stale) — corpos
    // grandes demais pulam o fallback, mas ainda são servidos.
    if (upstream.ok && buf.length <= MAX_FALLBACK_BYTES) {
      try {
        await salvarFallback(chaveFallback(atual), {
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
      const velho = await lerFallback(chaveFallback(atual));
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

// Ganchos de teste (SSRF): substituem resolvedor, lookup e transporte.
module.exports.verificarAlvo = verificarAlvo;
module.exports.definirResolvedor = definirResolvedor;
module.exports.definirProcurarDns = definirProcurarDns;
module.exports.definirTransporte = definirTransporte;
module.exports.transporteNativo = transporteNativo;
module.exports.lookupSeguro = lookupSeguro;
module.exports.motivoEnderecoBloqueado = motivoEnderecoBloqueado;
module.exports.ehIpPrivado = ehIpPrivado;
module.exports.coletarCorpoLimitado = coletarCorpoLimitado;
module.exports.limparSaudeCache = limparSaudeCache;
module.exports.ipv4Flexivel = ipv4Flexivel;
module.exports.ipv4Privado = ipv4Privado;
module.exports.buscarOrigem = buscarOrigem;
module.exports.lerFallback = lerFallback;
module.exports.salvarFallback = salvarFallback;
module.exports.registrarSaude = registrarSaude;
module.exports.chaveFallback = chaveFallback;
