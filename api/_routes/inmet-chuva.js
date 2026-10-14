/* ============================================================
   GET /api/inmet-chuva
   Lê o zip anual de dados históricos do INMET
   (https://portal.inmet.gov.br/uploads/dadoshistoricos/{ano}.zip),
   extrai os CSVs das estações automáticas da UF e calcula
   precipitação acumulada nas últimas 24h e 7 dias por estação.
   Retorna JSON compacto para o mapa.

   O zip tem ~90-140 MB: em vez de baixá-lo inteiro (estoura o
   limite serverless), usa HTTP Range para ler só o diretório
   central e os arquivos _UF_ (~2-5 MB no total).

   Query params:
     ?ano=YYYY     ano do zip (default: ano corrente UTC)
     ?uf=XX        sigla da UF ou BR (default: MT)
     ?refresh=1    ignora o cache em memória

   Saída: { ano, uf, atualizadoEm, cobertura, observacao,
            estacoes: [{ codigo, nome, lat, lon,
                         chuva24h, chuva7d, ultima, serie7d }] }
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const zlib = require('zlib');

const ZIP_BASE = 'https://portal.inmet.gov.br/uploads/dadoshistoricos/';
const CACHE_TTL_MS = 6 * 3600 * 1000; // 6h
const HORA_MS = 3600 * 1000;
const DIA_MS = 24 * HORA_MS;
const RANGE_TIMEOUT_MS = 20000;
const RANGE_PARALELO = 24;
/* Folga para o campo extra do cabeçalho local: na prática os zips do
   INMET trazem extra vazio, então 1 range por arquivo basta; se o
   cálculo estourar, cai para a leitura em 2 passos. */
const EXTRA_FOLGA = 1024;

/* Cache por chave ano:uf (Map com teto): alternar de UF não evicta
   as demais até o teto. TTL 6h por entrada. */
const CACHE_POR_CHAVE = new Map();
const CACHE_MAX_CHAVES = 8;

function lerCache(chave) {
  const item = CACHE_POR_CHAVE.get(chave);
  if (!item) return null;
  if (Date.now() - item.ts >= CACHE_TTL_MS) {
    CACHE_POR_CHAVE.delete(chave);
    return null;
  }
  // LRU: re-insere para marcar como usada recentemente.
  CACHE_POR_CHAVE.delete(chave);
  CACHE_POR_CHAVE.set(chave, item);
  return item.dados;
}

function gravarCache(chave, dados) {
  CACHE_POR_CHAVE.delete(chave);
  CACHE_POR_CHAVE.set(chave, { ts: Date.now(), dados });
  while (CACHE_POR_CHAVE.size > CACHE_MAX_CHAVES) {
    CACHE_POR_CHAVE.delete(CACHE_POR_CHAVE.keys().next().value);
  }
}

function limparCache() {
  CACHE_POR_CHAVE.clear();
}

function parseNum(v) {
  const t = String(v).trim();
  if (t === '' || t === '-9999') return null;
  const n = parseFloat(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/* Lê linha de metadados (chave:valor ou chave:;valor) e captura o valor. */
function metaValor(linha) {
  const i = linha.indexOf(':');
  if (i < 0) return null;
  let v = linha.slice(i + 1).replace(/^;/, '').trim();
  return v || null;
}

/* Lê o diretório central via Range e devolve as entradas
   [{nome, comp, compSize, localOff}]. Não baixa o zip inteiro. */
async function listarEntradas(url) {
  const tamanho = await tamanhoArquivo(url);
  let cauda = Math.min(1048576, tamanho); // 1 MB ou o arquivo todo
  for (;;) {
    const buf = await fetchRange(url, Math.max(0, tamanho - cauda), tamanho - 1);
    const dir = procurarDiretorio(buf, tamanho - buf.length);
    if (dir) return dir;
    if (cauda >= 8388608 || cauda >= tamanho) break;
    cauda = Math.min(cauda * 2, 8388608);
  }
  throw new Error('Diretório central do zip não localizado.');
}

async function tamanhoArquivo(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RANGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
    const n = Number(r.headers.get('content-length'));
    if (Number.isFinite(n) && n > 0) return n;
  } catch (e) {
    /* tenta via range 0-0 abaixo */
  } finally {
    clearTimeout(timer);
  }
  const um = await fetchRange(url, 0, 0);
  void um;
  throw new Error('Não foi possível obter o tamanho do zip.');
}

async function fetchRange(url, inicio, fim) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RANGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${inicio}-${fim}`, 'User-Agent': 'SGIProtege/1.0 (+painel-operacional)' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (res.status !== 206) throw new Error(`Origem sem suporte a Range (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function procurarDiretorio(cauda, baseOff) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = cauda.lastIndexOf(sig);
  if (eocd < 0) return null;
  const qtd = cauda.readUInt16LE(eocd + 10);
  const cdOff = cauda.readUInt32LE(eocd + 16);
  if (cdOff < baseOff) return null; // diretório fora da fatia lida
  const entradas = [];
  let p = cdOff - baseOff;
  for (let n = 0; n < qtd; n++) {
    if (cauda.readUInt32LE(p) !== 0x02014b50) break;
    const comp = cauda.readUInt16LE(p + 10);
    const compSize = cauda.readUInt32LE(p + 20);
    const nameLen = cauda.readUInt16LE(p + 28);
    const extraLen = cauda.readUInt16LE(p + 30);
    const commentLen = cauda.readUInt16LE(p + 32);
    const localOff = cauda.readUInt32LE(p + 42);
    const nomeArq = cauda.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    entradas.push({ nome: nomeArq, comp, compSize, localOff, nameLen });
  }
  return entradas;
}

/* Extrai os arquivos _UF_ do zip e devolve estações parseadas. */
async function extrairUF(url, entradas, uf) {
  const alvo = `_${String(uf || 'MT').trim().toUpperCase()}_`;
  const alvos = entradas.filter((e) => e.nome.includes(alvo) && e.comp === 8);
  const estacoes = [];
  for (let i = 0; i < alvos.length; i += RANGE_PARALELO) {
    const lote = alvos.slice(i, i + RANGE_PARALELO);
    const resultados = await Promise.all(lote.map(async (e) => {
      try {
        // Tenta 1 range só (cabeçalho + dados + folga p/ campo extra).
        let buf = await fetchRange(url, e.localOff, e.localOff + 30 + e.nameLen + e.compSize + EXTRA_FOLGA - 1);
        let dataOff = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
        if (dataOff + e.compSize > buf.length) {
          // Campo extra maior que a folga: lê cabeçalho e dados separados.
          const cab = await fetchRange(url, e.localOff, e.localOff + 30 + e.nameLen + 64);
          dataOff = 30 + cab.readUInt16LE(26) + cab.readUInt16LE(28);
          const ini = e.localOff + dataOff;
          buf = await fetchRange(url, ini, ini + e.compSize - 1);
          const texto = zlib.inflateRawSync(buf.slice(0, e.compSize)).toString('latin1');
          return processarTexto(texto);
        }
        const texto = zlib.inflateRawSync(buf.slice(dataOff, dataOff + e.compSize)).toString('latin1');
        return processarTexto(texto);
      } catch (err) {
        console.error('[inmet-chuva] entrada ignorada:', e.nome, err && err.message);
        return null;
      }
    }));
    for (const r of resultados) if (r) estacoes.push(r);
  }
  return estacoes;
}

/* Compat: extração legada de um buffer completo (usada em testes). */
function extrairUFLegado(buf, uf) {
  const alvo = `_${String(uf || 'MT').trim().toUpperCase()}_`;
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocd = buf.lastIndexOf(sig);
  if (eocd < 0) throw new Error('EOCD não encontrado no zip.');
  const qtd = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);

  const estacoes = [];
  let p = cdOff;
  for (let n = 0; n < qtd; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const comp = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const nomeArq = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!nomeArq.includes(alvo) || comp !== 8) continue;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const texto = zlib.inflateRawSync(buf.slice(dataOff, dataOff + compSize)).toString('latin1');
    const r = processarTexto(texto);
    if (r) estacoes.push(r);
  }
  return estacoes;
}

function processarTexto(texto) {
    const meta = { codigo: null, nome: null, lat: null, lon: null };
    const rows = [];
    let header = false;
    for (const raw of texto.split(/\r?\n/)) {
      if (!header) {
        const key = raw.split(':')[0] || '';
        const chaveLimp = key.toUpperCase().trim();
        if (/Hora\s*UTC/.test(raw) || chaveLimp === 'DATA') { header = true; continue; }
        const valor = metaValor(raw);
        if (/^CODIGO/.test(chaveLimp) || /^CODIGO/.test(key)) meta.codigo = valor || meta.codigo;
        else if (/^LATITUDE/.test(chaveLimp)) meta.lat = parseNum(valor);
        else if (/^LONGITUDE/.test(chaveLimp)) meta.lon = parseNum(valor);
        else if (/^ESTA/.test(key) && /^Data;/.test(raw) === false) meta.nome = valor || meta.nome;
        continue;
      }
      if (/^\d{4}\/\d{2}\/\d{2};/.test(raw)) {
        const c = raw.split(';');
        const dm = c[0].split('/');
        if (dm.length !== 3) continue;
        const hora = (c[1] || '').split(' ')[0];
        const hh = parseInt(hora.slice(0, 2), 10) || 0;
        const mi = parseInt(hora.slice(2, 4), 10) || 0;
        const ts = Date.UTC(+dm[0], +dm[1] - 1, +dm[2], hh, mi);
        const pr = parseNum(c[2]);
        rows.push({ ts, pr: pr === null ? null : Math.max(0, pr) });
      }
    }
    if (!meta.codigo) return null;
    return { ...meta, rows };
}

/* Calcula acumulados 24h/7d e série diária dos últimos 7 dias.
   O zip traz arquivos com períodos sobrepostos da mesma estação:
   mescla por código (união das linhas, sem duplicar). */
function consolidar(estacoes) {
  const porCodigo = new Map();
  for (const e of estacoes) {
    const chave = String(e.codigo || '').replace(/;$/, '');
    const atual = porCodigo.get(chave);
    if (!atual || (e.rows && e.rows.length > atual.rows.length)) {
      porCodigo.set(chave, e);
    } else if (atual) {
      const vistos = new Set(atual.rows.map((r) => r.ts));
      for (const r of e.rows) {
        if (!vistos.has(r.ts)) { atual.rows.push(r); vistos.add(r.ts); }
      }
    }
  }
  const unicas = [...porCodigo.values()];
  let refTs = 0;
  for (const e of unicas) {
    for (const r of e.rows) if (r.pr !== null && r.ts > refTs) refTs = r.ts;
  }
  if (!refTs) refTs = Date.now();

  const out = unicas
    .filter((e) => e.lat !== null && e.lon !== null)
    .map((e) => {
      let c24 = 0, c7 = 0, ultima = null;
      const diario = new Map();
      for (const r of e.rows) {
        if (r.pr === null) continue;
        if (r.ts >= refTs - 24 * HORA_MS) c24 += r.pr;
        if (r.ts >= refTs - 7 * DIA_MS) {
          c7 += r.pr;
          const d = new Date(r.ts).toISOString().slice(0, 10);
          diario.set(d, (diario.get(d) || 0) + r.pr);
        }
        if (ultima === null || r.ts > ultima) ultima = r.ts;
      }
      const serie7d = [...diario.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
        .map(([dia, mm]) => ({ dia, mm: +mm.toFixed(1) }));
      return {
        codigo: e.codigo,
        nome: e.nome,
        lat: e.lat,
        lon: e.lon,
        chuva24h: +c24.toFixed(1),
        chuva7d: +c7.toFixed(1),
        ultima: ultima ? new Date(ultima).toISOString() : null,
        serie7d,
      };
    });

  out.sort((a, b) => b.chuva24h - a.chuva24h || b.chuva7d - a.chuva7d);
  return { cobertura: new Date(refTs).toISOString(), estacoes: out };
}

async function obterDados(ano, uf, force) {
  const chave = `${ano}:${uf}`;
  if (!force) {
    const emCache = lerCache(chave);
    if (emCache) return emCache;
  }

  const url = ZIP_BASE + ano + '.zip';
  const entradas = await listarEntradas(url);
  const estacoes = await extrairUF(url, entradas, uf);
  const dados = consolidar(estacoes);

  gravarCache(chave, dados);
  return dados;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const ru = reqUrl(req);
  let ano = ru ? ru.searchParams.get('ano') : null;
  if (!ano || !/^\d{4}$/.test(ano)) ano = String(new Date().getUTCFullYear());
  const force = ru ? ru.searchParams.get('refresh') === '1' : false;
  let uf = (ru && ru.searchParams.get('uf')) || 'MT';
  uf = String(uf).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) {
    return jsonResponse(400, { erro: 'UF inválida: use a sigla com 2 letras.' }, origin);
  }

  try {
    const dados = await obterDados(ano, uf, force);
    const res = jsonResponse(200, {
      ano,
      uf,
      atualizadoEm: new Date().toISOString(),
      cobertura: dados.cobertura,
      observacao: 'Dados históricos oficiais do INMET (zip anual, leitura parcial por UF). A cobertura depende da última publicação do portal.',
      totalEstacoes: dados.estacoes.length,
      estacoes: dados.estacoes,
    }, origin);
    Object.entries(cacheHeaders(21600, 21600)).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  } catch (e) {
    return jsonResponse(502, { erro: 'Falha ao processar dados INMET: ' + e.message }, origin);
  }
});

module.exports.limparCache = limparCache;