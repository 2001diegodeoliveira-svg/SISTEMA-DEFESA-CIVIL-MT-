/* ============================================================
   NASA FIRMS (Fire Information for Resource Management System).
   Consumo server-side da Area API (documentação oficial):
     /api/area/csv/[MAP_KEY]/[SOURCE]/[west,south,east,north]/[DAY_RANGE]
   Regras da API: DAY_RANGE 1..5; fontes NRT abaixo; limite de
   5.000 transações / 10 min (pedidos de vários dias contam como vários).

   A MAP_KEY vem de FIRMS_MAP_KEY (ambiente do servidor). Nunca é
   enviada ao navegador, nem devolvida em respostas, nem logada.

   GET /api/firms?dias=1..5&fonte=VIIRS_SNPP_NRT&bbox=minLon,minLat,maxLon,maxLat
     - 503 {erro} se FIRMS_MAP_KEY não estiver configurada
     - 502 {erro} se a NASA recusar ou não responder
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const FIRMS_AREA = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/';
const FONTES = {
  VIIRS_SNPP_NRT: 'VIIRS Suomi-NPP',
  VIIRS_NOAA20_NRT: 'VIIRS NOAA-20',
  VIIRS_NOAA21_NRT: 'VIIRS NOAA-21',
  MODIS_NRT: 'MODIS',
};
const FONTE_PADRAO = 'VIIRS_SNPP_NRT';
const DIAS_MIN = 1;
const DIAS_MAX = 5;
const BBOX_PADRAO = { minLon: -58.9, minLat: -22.2, maxLon: -54.9, maxLat: -15.5 };
const TIMEOUT_MS = 25000;
const MAX_LINHAS = 20000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 12;
const CAMPOS_OBRIGATORIOS = ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence', 'frp', 'daynight'];

const cache = new Map();

function limparCache() {
  cache.clear();
}

class ErroFirms extends Error {
  constructor(mensagem, status) {
    super(mensagem);
    this.status = status;
  }
}

function chaveConfigurada() {
  return (process.env.FIRMS_MAP_KEY || '').trim();
}

/* ---------- validação ---------- */

function parseDias(raw) {
  if (raw == null || raw === '') return DIAS_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < DIAS_MIN || n > DIAS_MAX) {
    throw new Error(`dias inválido: use um inteiro de ${DIAS_MIN} a ${DIAS_MAX} (limite da NASA FIRMS).`);
  }
  return n;
}

function parseFonte(raw) {
  if (raw == null || raw === '') return FONTE_PADRAO;
  const f = String(raw).trim().toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(FONTES, f)) {
    throw new Error('fonte inválida: use ' + Object.keys(FONTES).join(', ') + '.');
  }
  return f;
}

function parseBbox(raw) {
  if (raw == null || raw === '') return { ...BBOX_PADRAO };
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
  return { minLon, minLat, maxLon, maxLat };
}

/* ---------- CSV ---------- */

function parseCsv(texto) {
  const linhas = texto.trim().split(/\r?\n/);
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(',').map((h) => h.trim().toLowerCase());
  const faltando = CAMPOS_OBRIGATORIOS.filter((c) => !cab.includes(c));
  if (faltando.length) throw new ErroFirms('FIRMS devolveu CSV sem as colunas: ' + faltando.join(', ') + '.', 502);
  const i = Object.fromEntries(CAMPOS_OBRIGATORIOS.map((c) => [c, cab.indexOf(c)]));
  const focos = [];
  for (let n = 1; n < linhas.length && focos.length < MAX_LINHAS; n++) {
    const c = linhas[n].split(',');
    if (c.length < cab.length) continue;
    const lat = Number(c[i.latitude]);
    const lon = Number(c[i.longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const hora = String(c[i.acq_time] || '').trim().padStart(4, '0');
    const frp = Number(c[i.frp]);
    focos.push({
      lat,
      lon,
      data: String(c[i.acq_date] || '').trim() || null,
      hora: hora.slice(0, 2) + ':' + hora.slice(2, 4),
      satelite: String(c[i.satellite] || '').trim() || null,
      confianca: String(c[i.confidence] || '').trim() || null,
      frp: Number.isFinite(frp) ? frp : null,
      diaNoite: String(c[i.daynight] || '').trim() || null,
    });
  }
  return focos;
}

/* ---------- consulta ---------- */

async function buscarFocos({ bbox, dias, fonte }) {
  const chave = chaveConfigurada();
  if (!chave) {
    const e = new ErroFirms('FIRMS_MAP_KEY não configurada no servidor.', 503);
    e.semChave = true;
    throw e;
  }
  const chaveCache = [fonte, dias, bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].join('|');
  const emCache = cache.get(chaveCache);
  if (emCache && Date.now() - emCache.ts < CACHE_TTL_MS) return emCache.dados;

  const area = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
  const url = `${FIRMS_AREA}${chave}/${fonte}/${area}/${dias}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let texto;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'SGIProtege/1.0 (+monitoramento)' } });
    texto = await res.text();
    if (!res.ok) {
      // Mensagem curta: nunca ecoar a URL (contém a chave).
      throw new ErroFirms(`NASA FIRMS respondeu HTTP ${res.status}.`, 502);
    }
  } catch (e) {
    if (e instanceof ErroFirms) throw e;
    const motivo = e.name === 'AbortError' ? 'tempo esgotado' : 'conexão recusada';
    throw new ErroFirms(`NASA FIRMS indisponível (${motivo}).`, 502);
  } finally {
    clearTimeout(timer);
  }
  /* Cabeçalho CSV sempre tem vírgulas; texto puro é mensagem de erro (ex.: "Invalid MAP_KEY."). */
  if (!texto.trim().split(/\r?\n/)[0].includes(',')) {
    throw new ErroFirms('NASA FIRMS recusou a MAP_KEY ou o limite de transações foi excedido.', 502);
  }

  const focos = parseCsv(texto);
  const dados = {
    fonte: 'NASA FIRMS — ' + FONTES[fonte],
    produto: fonte,
    diasConsultados: dias,
    bbox: area,
    atualizadoEm: new Date().toISOString(),
    total: focos.length,
    focos,
  };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(chaveCache, { ts: Date.now(), dados });
  return dados;
}

/* ---------- rota ---------- */

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin, { Allow: 'GET' });

  const ru = reqUrl(req);
  const q = ru ? ru.searchParams : new URLSearchParams();
  let dias;
  let fonte;
  let bbox;
  try {
    dias = parseDias(q.get('dias'));
    fonte = parseFonte(q.get('fonte'));
    bbox = parseBbox(q.get('bbox'));
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }

  try {
    const dados = await buscarFocos({ bbox, dias, fonte });
    const res = jsonResponse(200, dados, origin);
    Object.entries(cacheHeaders(1800, 3600)).forEach(([k, v]) => res.headers.set(k, v));
    res.headers.set('X-Fonte', 'nasa-firms');
    return res;
  } catch (e) {
    if (e instanceof ErroFirms) {
      return jsonResponse(e.status, { erro: e.message }, origin);
    }
    return jsonResponse(502, { erro: 'Falha ao consultar a NASA FIRMS.' }, origin);
  }
});

module.exports.buscarFocos = buscarFocos;
module.exports.parseCsv = parseCsv;
module.exports.parseDias = parseDias;
module.exports.parseFonte = parseFonte;
module.exports.parseBbox = parseBbox;
module.exports.limparCache = limparCache;
module.exports.FONTES = FONTES;
module.exports.DIAS_MAX = DIAS_MAX;
