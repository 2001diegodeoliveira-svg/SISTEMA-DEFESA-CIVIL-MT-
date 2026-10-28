const { jsonResponse, reqUrl, cacheHeaders } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { registrar } = require('../_lib/saude-fontes');

const INPE_CSV_BASE = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil';
const CACHE_TTL_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 25000;

const cache = new Map(); // key -> { updatedAt, data }

const ESTADOS_AMAZONIA_LEGAL = new Set(['AC','AM','AP','MA','MT','PA','RO','RR','TO']);

function parseNum(v) {
  const n = Number(String(v || '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    // CSV simples sem aspas aninhadas complexas; valores podem ter espacos
    const cols = lines[i].split(',');
    if (cols.length < header.length - 2) continue;
    const lat = parseNum(cols[idx.lat]);
    const lon = parseNum(cols[idx.lon]);
    if (lat === null || lon === null) continue;
    out.push({
      id: (cols[idx.id] || '').trim() || `${lat},${lon},${i}`,
      lat, lon,
      data: (cols[idx.data_hora_gmt] || '').trim(),
      satelite: (cols[idx.satelite] || '').trim(),
      municipio: (cols[idx.municipio] || '').trim(),
      estado: (cols[idx.estado] || '').trim().toUpperCase(),
      pais: (cols[idx.pais] || '').trim(),
      bioma: (cols[idx.bioma] || '').trim(),
      diasSemChuva: parseNum(cols[idx.numero_dias_sem_chuva]),
      precipitacao: parseNum(cols[idx.precipitacao]),
      riscoFogo: parseNum(cols[idx.risco_fogo]),
      frp: parseNum(cols[idx.frp]),
    });
  }
  return out;
}

function filtrarRecorte(focos, recorte) {
  if (recorte === 'amazonia_legal') {
    return focos.filter((f) => ESTADOS_AMAZONIA_LEGAL.has(f.estado));
  }
  // mt
  return focos.filter((f) => f.estado === 'MATO GROSSO');
}

async function fetchDia(iso, timeout) {
  const url = `${INPE_CSV_BASE}/focos_diario_br_${iso}.csv`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const txt = await res.text();
    if (txt.charCodeAt(0) === 0xFEFF) return parseCSV(txt.slice(1));
    return parseCSV(txt);
  } finally {
    clearTimeout(t);
  }
}

function diasArray(n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.now() - i * 86400000);
    arr.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return arr;
}

async function buscar({ recorte, dias }) {
  const key = `${recorte}:${dias}`;
  const c = cache.get(key);
  if (c && Date.now() - c.updatedAt < CACHE_TTL_MS) {
    return { ...c.data, _cached: true };
  }
  const start = Date.now();
  const isos = diasArray(dias);
  const coletado = [];
  const LOTE = 4;
  let erro = null;
  try {
    for (let i = 0; i < isos.length; i += LOTE) {
      const lote = isos.slice(i, i + LOTE);
      const resps = await Promise.all(lote.map((iso) => fetchDia(iso, TIMEOUT_MS).catch((e) => { erro = e; return []; })));
      resps.forEach((r) => { if (Array.isArray(r)) coletado.push(...r); });
    }
    const filtrados = filtrarRecorte(coletado, recorte);
    // dedup
    const seen = new Set();
    const unicos = [];
    for (const f of filtrados) {
      const k = `${f.lat.toFixed(4)},${f.lon.toFixed(4)},${f.data}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unicos.push(f);
    }
    // resumo por municipio
    const porMunicipio = {};
    for (const f of unicos) {
      const m = f.municipio || 'Desconhecido';
      porMunicipio[m] = (porMunicipio[m] || 0) + 1;
    }
    const data = {
      fonte: 'INPE BDQueimadas',
      atualizadoEm: new Date().toISOString(),
      status: unicos.length ? 'ok' : 'atrasado',
      dados: {
        recorte,
        dias,
        total: unicos.length,
        focos: unicos,
        porMunicipio,
        periodo: { inicio: isos[isos.length - 1], fim: isos[0] },
      },
    };
    cache.set(key, { updatedAt: Date.now(), data });
    registrar('focos', { ok: true, latenciaMs: Date.now() - start });
    return data;
  } catch (e) {
    registrar('focos', { ok: false, erro: e.message });
    const c2 = cache.get(key);
    if (c2) {
      return { ...c2.data, status: 'atrasado', _cached: true, _erro: e.message };
    }
    return {
      fonte: 'INPE BDQueimadas',
      atualizadoEm: new Date().toISOString(),
      status: 'erro',
      dados: { recorte, dias, total: 0, focos: [], porMunicipio: {}, periodo: null, erro: e.message },
    };
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Metodo nao permitido.' }, origin);
  const url = reqUrl(req);
  const params = url ? url.searchParams : new URLSearchParams();
  const recorte = (params.get('recorte') || 'mt').toLowerCase();
  const dias = Math.max(1, Math.min(parseInt(params.get('dias') || '1', 10) || 1, 30));
  const data = await buscar({ recorte, dias });
  const cache = cacheHeaders(900, 1800);
  return new Response(JSON.stringify(data), {
    status: data.status === 'erro' ? 502 : 200,
    headers: { 'Content-Type': 'application/json', ...require('../_lib/http').corsHeaders(origin), ...cache },
  });
});