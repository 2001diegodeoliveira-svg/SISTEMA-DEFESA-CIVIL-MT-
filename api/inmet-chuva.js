/* ============================================================
   GET /api/inmet-chuva
   Baixa o zip anual de dados históricos do INMET
   (https://portal.inmet.gov.br/uploads/dadoshistoricos/{ano}.zip),
   extrai os CSVs das estações automáticas de Mato Grosso e
   calcula precipitação acumulada nas últimas 24h e 7 dias por
   estação. Retorna JSON compacto para o mapa.

   Query params:
     ?ano=YYYY     ano do zip (default: ano corrente UTC)
     ?refresh=1    ignora o cache em memória

   Saída: { ano, atualizadoEm, cobertura, observacao,
            estacoes: [{ codigo, nome, lat, lon,
                         chuva24h, chuva7d, ultima, serie7d }] }
   ============================================================ */
const { jsonResponse, reqUrl } = require('./_lib/http');
const { serve } = require('./_lib/serverless');
const zlib = require('zlib');

const ZIP_BASE = 'https://portal.inmet.gov.br/uploads/dadoshistoricos/';
const CACHE_TTL_MS = 6 * 3600 * 1000; // 6h
const HORA_MS = 3600 * 1000;
const DIA_MS = 24 * HORA_MS;

let cache = { ano: null, ts: 0, dados: null };

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

/* Extrai os arquivos _MT_ do zip e devolve estações parseadas. */
function extrairMT(buf) {
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

    if (!nomeArq.includes('_MT_') || comp !== 8) continue;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const texto = zlib.inflateRawSync(buf.slice(dataOff, dataOff + compSize)).toString('latin1');

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
    if (meta.codigo) estacoes.push({ ...meta, rows });
  }
  return estacoes;
}

/* Calcula acumulados 24h/7d e série diária dos últimos 7 dias. */
function consolidar(estacoes) {
  let refTs = 0;
  for (const e of estacoes) {
    for (const r of e.rows) if (r.pr !== null && r.ts > refTs) refTs = r.ts;
  }
  if (!refTs) refTs = Date.now();

  const out = estacoes
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

async function obterDados(ano, force) {
  if (
    !force &&
    cache.ano === ano &&
    cache.dados &&
    Date.now() - cache.ts < CACHE_TTL_MS
  ) {
    return cache.dados;
  }

  const url = ZIP_BASE + ano + '.zip';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  let buf;
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ao baixar ' + url);
    buf = Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const estacoes = extrairMT(buf);
  const dados = consolidar(estacoes);

  cache = { ano, ts: Date.now(), dados };
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

  try {
    const dados = await obterDados(ano, force);
    return jsonResponse(200, {
      ano,
      atualizadoEm: new Date().toISOString(),
      cobertura: dados.cobertura,
      observacao: 'Dados históricos oficiais do INMET (zip anual). A cobertura depende da última publicação do portal.',
      totalEstacoes: dados.estacoes.length,
      estacoes: dados.estacoes,
    }, origin);
  } catch (e) {
    return jsonResponse(502, { erro: 'Falha ao processar dados INMET: ' + e.message }, origin);
  }
});