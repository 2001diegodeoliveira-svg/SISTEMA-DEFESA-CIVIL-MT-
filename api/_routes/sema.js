/* ============================================================
   GET /api/sema?bbox=&camadas=&max=
   Fiscalização ambiental estadual da SEMA-MT via WFS do GeoServer
   oficial (verificado ao vivo em 2026-11-08):
     https://geo.sema.mt.gov.br/geoserver/ows (WFS 2.0 + GeoJSON)
     - Geoportal:AUTOS_DE_INFRACAO_SIGA_PONTO (10.069 autos no MT)
     - Geoportal:TDAD_FISCALIZACAO_TERMO_DE_EMBARGO
   A authkey é a chave pública de conexão publicada pela própria
   SEMA no Portal da Transparência (SIMGEO); pode ser substituída
   por SEMA_GEO_AUTHKEY no ambiente do servidor.

   Privacidade (LGPD): razão social, CPF/CNPJ, nome fantasia,
   servidor e matrícula do técnico são retirados no servidor.

   Query:
     ?bbox=minLon,minLat,maxLon,maxLat (padrão: MT)
     ?camadas=autos,embargos            (padrão: ambas)
     ?max=                              teto por camada (1..2000, 500)
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const SEMA_WFS = 'https://geo.sema.mt.gov.br/geoserver/ows';
const CHAVE_PUBLICADA = '541085de-9a2e-454e-bdba-eb3d57a2f492'; // publicada na página SIMGEO da SEMA
const CAMADAS = {
  autos: 'Geoportal:AUTOS_DE_INFRACAO_SIGA_PONTO',
  embargos: 'Geoportal:TDAD_FISCALIZACAO_TERMO_DE_EMBARGO',
};
const MT_BBOX = { minLon: -62.0, minLat: -18.4, maxLon: -50.2, maxLat: -7.3 };
const TIMEOUT_MS = 30000;
const MAX_PADRAO = 500;
const MAX_TETO = 2000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 6;

const cache = new Map();
const REFRESH_COOLDOWN_MS = 60 * 1000;
let ultimoRefreshForcado = 0;

function limparCache() {
  cache.clear();
  ultimoRefreshForcado = 0;
}

function chaveSema() {
  return (process.env.SEMA_GEO_AUTHKEY || CHAVE_PUBLICADA).trim();
}

function parseBbox(raw) {
  if (raw == null || raw === '') return { ...MT_BBOX };
  const p = String(raw).split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error('bbox inválida: use minLon,minLat,maxLon,maxLat.');
  }
  const [minLon, minLat, maxLon, maxLat] = p;
  if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
    throw new Error('bbox fora dos intervalos válidos.');
  }
  if (minLon >= maxLon || minLat >= maxLat) {
    throw new Error('bbox inválida: mínimo deve ser menor que o máximo.');
  }
  if ((maxLon - minLon) > 30 || (maxLat - minLat) > 30) {
    throw new Error('bbox grande demais: limite de 30° por eixo.');
  }
  return { minLon, minLat, maxLon, maxLat };
}

function parseCamadas(raw) {
  if (raw == null || raw === '') return ['autos', 'embargos'];
  const pedidas = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const validas = pedidas.filter((c) => Object.prototype.hasOwnProperty.call(CAMADAS, c));
  if (!validas.length) throw new Error('camadas inválidas: use autos e/ou embargos.');
  return [...new Set(validas)];
}

function parseMax(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MAX_PADRAO;
  return Math.min(MAX_TETO, Math.max(1, Math.floor(n)));
}

function txt(v) {
  const s = String(v == null ? '' : v).trim();
  return s && s.toLowerCase() !== 'nan' && s !== 'null' ? s : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dataCurta(v) {
  const s = txt(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
}

function normalizarAutos(f, camada) {
  const a = (f && f.properties) || {};
  return {
    type: 'Feature',
    geometry: (f && f.geometry) || null,
    properties: {
      camada,
      numero: txt(a.NUMERO_AUTO_INFRACAO),
      tipo: txt(a.TIPO_DO_AUTO) || txt(a.TIPO),
      numeroEmbargo: txt(a.NUMERO_TERMO_EMBARGO),
      numeroDocumento: txt(a.NUMERO_DOCUMENTO),
      processo: txt(a.NUMERO_PROCESSO),
      data: dataCurta(a.DATA_DO_AUTO) || dataCurta(a.DATA_DOCUMENTO),
      municipio: txt(a.MUNICIPIO_DO_DANO),
      frente: txt(a.FRENTE),
      descricao: txt(a.DESCRICAO_DA_OCORRENCIA) || txt(a.DESCRICAO_AGRAVANTE),
      atividade: txt(a.ATIVIDADE) || txt(a.ATIVIDADE_EMBARGADA),
      quantidade: num(a.QUANTIDADE),
      unidadeMedida: txt(a.UNIDADE_MEDIDA),
      valorMulta: num(a.VALOR_TOTAL_DA_MULTA) ?? num(a.VALOR_DA_UNIDADE_MULTA),
      situacao: txt(a.SITUACAO) || txt(a.STATUS),
      status: txt(a.STATUS),
      embargo: txt(a.EMBARGADO),
    },
  };
}

async function buscarCamada(tipo, bbox, max) {
  const qs = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: tipo,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat},EPSG:4326`,
    count: String(max),
    authkey: chaveSema(),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SEMA_WFS}?${qs}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'SGIProtege/1.0 (+defesa civil)' },
    });
    if (!res.ok) throw new Error(`SEMA respondeu HTTP ${res.status}.`);
    const j = await res.json();
    if (j && j.exceptions) throw new Error('SEMA: exceção do WFS.');
    const features = Array.isArray(j.features) ? j.features : [];
    const casado = Number.isFinite(Number(j.numberMatched))
      ? Number(j.numberMatched)
      : (Number.isFinite(Number(j.totalFeatures)) ? Number(j.totalFeatures) : features.length);
    return { features, casado };
  } finally {
    clearTimeout(timer);
  }
}

async function buscarSema(bbox, camadas, max, force) {
  const chave = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}|${camadas.join(',')}|${max}`;
  if (!force) {
    const emCache = cache.get(chave);
    if (emCache && Date.now() - emCache.ts < CACHE_TTL_MS) return emCache.dados;
  }
  const avisos = [];
  const parciais = { autos: false, embargos: false };
  const saida = {
    fonte: 'SEMA-MT — GeoServer (WFS)',
    atualizadoEm: new Date().toISOString(),
    bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
    camadas,
    totais: { autos: 0, embargos: 0 },
    casados: { autos: 0, embargos: 0 },
    parciais,
    avisos,
    autos: { type: 'FeatureCollection', features: [] },
    embargos: { type: 'FeatureCollection', features: [] },
  };
  await Promise.all(camadas.map(async (c) => {
    try {
      const r = await buscarCamada(CAMADAS[c], bbox, max);
      const features = r.features.map((f) => normalizarAutos(f, c)).filter((f) => f.geometry);
      saida[c] = { type: 'FeatureCollection', features };
      saida.totais[c] = features.length;
      saida.casados[c] = r.casado;
      parciais[c] = r.casado > features.length;
    } catch (e) {
      parciais[c] = true;
      avisos.push((c === 'autos' ? 'Autos SEMA: ' : 'Embargos SEMA: ') + e.message);
    }
  }));
  const todasFalharam = camadas.every((c) => parciais[c] && saida.totais[c] === 0);
  if (todasFalharam) throw new Error(avisos.join(' · ') || 'SEMA indisponível.');
  cache.delete(chave);
  cache.set(chave, { ts: Date.now(), dados: saida });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return saida;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin, { Allow: 'GET' });

  const ru = reqUrl(req);
  const q = ru ? ru.searchParams : new URLSearchParams();
  let bbox;
  let camadas;
  let max;
  try {
    bbox = parseBbox(q.get('bbox'));
    camadas = parseCamadas(q.get('camadas'));
    max = parseMax(q.get('max'));
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }

  try {
    const pediuRefresh = q.get('refresh') === '1';
    const force = pediuRefresh && (Date.now() - ultimoRefreshForcado >= REFRESH_COOLDOWN_MS);
    if (force) ultimoRefreshForcado = Date.now();
    const dados = await buscarSema(bbox, camadas, max, force);
    const res = jsonResponse(200, dados, origin);
    Object.entries(cacheHeaders(1800, 3600)).forEach(([k, v]) => res.headers.set(k, v));
    res.headers.set('X-Fonte', 'sema-mt');
    return res;
  } catch (e) {
    return jsonResponse(502, { erro: 'Falha ao consultar a SEMA-MT.', detalhes: e.message }, origin);
  }
});

module.exports.parseBbox = parseBbox;
module.exports.parseCamadas = parseCamadas;
module.exports.parseMax = parseMax;
module.exports.normalizarAutos = normalizarAutos;
module.exports.buscarSema = buscarSema;
module.exports.limparCache = limparCache;
module.exports.CAMADAS = CAMADAS;
