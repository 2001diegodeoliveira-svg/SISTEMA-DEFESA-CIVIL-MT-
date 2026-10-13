/* ============================================================
   GET /api/barragens — barragens do SNISB/ANA (nacional).
   Fonte oficial (verificada ao vivo em 2026-10-13):
     https://portal1.snirh.gov.br/server/rest/services/
       SNISB/Barragens_SNISB/MapServer/0/query
   (ArcGIS REST; MaxRecordCount 2000; suporta where, geometria,
   resultOffset/resultRecordCount, returnCountOnly.)

   Query:
     ?uf=MT            sigla da UF (2 letras) ou BR (nacional)
     ?bbox=minLon,minLat,maxLon,maxLat   recorte espacial
     ?limit=           teto por resposta (1..2000, padrão 1000)
     ?offset=          paginação (resultOffset)
   Saída compacta e estável para o mapa (nunca o payload cru).
   Quandos os registros excedem o teto: {parcial:true}.
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const SNISB_QUERY = 'https://portal1.snirh.gov.br/server/rest/services/SNISB/Barragens_SNISB/MapServer/0/query';
const TIMEOUT_MS = 20000;
const PAGE = 1000;
const MAX_PAGINAS = 4;

const CAMPOS = [
  'BAR_CD_SNISB', 'BAR_NM_NOME', 'ING_NM_MUNICIPIO', 'ING_SG_UFMUNICIPIO',
  'BAR_NU_ALT_MAX_BASE_FUNDACAO', 'ALTURAESTIMADA',
  'BAR_NU_CAP_TOTAL_RESERV', 'CAPACIDADETOTALESTIMADA',
  'CATEGORIA_RISCO', 'NIVEL_PERIGO', 'BAR_DS_CLASSE', 'DANO_POTENCIAL',
  'FASE_DE_VIDA', 'USO_PRINCIPAL',
  'BAR_NU_LATITUDE', 'BAR_NU_LONGITUDE',
].join(',');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function txt(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function normalizar(attrs) {
  const lat = num(attrs.BAR_NU_LATITUDE);
  const lon = num(attrs.BAR_NU_LONGITUDE);
  if (lat == null || lon == null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    id: attrs.BAR_CD_SNISB != null ? String(attrs.BAR_CD_SNISB) : null,
    nome: txt(attrs.BAR_NM_NOME),
    municipio: txt(attrs.ING_NM_MUNICIPIO),
    uf: txt(attrs.ING_SG_UFMUNICIPIO),
    ht: num(attrs.BAR_NU_ALT_MAX_BASE_FUNDACAO) ?? num(attrs.ALTURAESTIMADA),
    cap: num(attrs.BAR_NU_CAP_TOTAL_RESERV) ?? num(attrs.CAPACIDADETOTALESTIMADA),
    risco: txt(attrs.CATEGORIA_RISCO) || txt(attrs.NIVEL_PERIGO) || txt(attrs.BAR_DS_CLASSE),
    danoPotencial: txt(attrs.DANO_POTENCIAL),
    faseVida: txt(attrs.FASE_DE_VIDA),
    uso: txt(attrs.USO_PRINCIPAL),
    lat,
    lon,
  };
}

function montarWhere(uf) {
  const u = String(uf || 'MT').trim().toUpperCase();
  if (u === 'BR') return '1=1';
  if (!/^[A-Z]{2}$/.test(u)) throw new Error('UF inválida: use a sigla com 2 letras ou BR.');
  return `ING_SG_UFMUNICIPIO='${u}'`;
}

function parseBbox(raw) {
  if (!raw) return null;
  const p = String(raw).split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    throw new Error('bbox inválida: use minLon,minLat,maxLon,maxLat.');
  }
  const [a, b, c, d] = p;
  if (a < -180 || c > 180 || b < -90 || d > 90 || a >= c || b >= d) {
    throw new Error('bbox fora dos intervalos válidos.');
  }
  return { xmin: a, ymin: b, xmax: c, ymax: d, spatialRel: 'esriSpatialRelIntersects' };
}

async function buscarPagina(params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const qs = new URLSearchParams({
      where: params.where,
      outFields: CAMPOS,
      returnGeometry: 'false',
      orderByFields: 'BAR_CD_SNISB',
      resultOffset: String(params.offset),
      resultRecordCount: String(params.limit),
      f: 'pjson',
    });
    if (params.bbox) {
      qs.set('geometry', `${params.bbox.xmin},${params.bbox.ymin},${params.bbox.xmax},${params.bbox.ymax}`);
      qs.set('geometryType', 'esriGeometryEnvelope');
      qs.set('inSR', '4326');
      qs.set('spatialRel', params.bbox.spatialRel);
    }
    const res = await fetch(`${SNISB_QUERY}?${qs}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`SNISB respondeu HTTP ${res.status}.`);
    const j = await res.json();
    if (j.error) throw new Error(`SNISB: ${(j.error && j.error.message) || 'erro desconhecido'}.`);
    const lista = Array.isArray(j.features) ? j.features : [];
    return {
      itens: lista.map((f) => normalizar(f.attributes || {})).filter(Boolean),
      excedeu: j.exceededTransferLimit === true,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const ru = reqUrl(req);
  const q = ru ? ru.searchParams : new URLSearchParams();
  let where;
  try {
    where = montarWhere(q.get('uf') || 'MT');
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }
  let bbox = null;
  try {
    bbox = parseBbox(q.get('bbox'));
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }
  const limit = Math.min(2000, Math.max(1, Number(q.get('limit')) || PAGE));
  const offset = Math.max(0, Number(q.get('offset')) || 0);

  // Pagina no servidor quando o pedido excede uma página ArcGIS.
  const itens = [];
  let parcial = false;
  try {
    let off = offset;
    let restante = limit;
    for (let pag = 0; pag < MAX_PAGINAS && restante > 0; pag += 1) {
      const n = Math.min(restante, PAGE);
      const r = await buscarPagina({ where, bbox, offset: off, limit: n });
      itens.push(...r.itens);
      restante -= r.itens.length;
      off += r.itens.length;
      if (!r.excedeu || r.itens.length < n) break;
      if (pag === MAX_PAGINAS - 1) parcial = true;
    }
  } catch (e) {
    return jsonResponse(502, { erro: 'Falha ao consultar o SNISB.', detalhes: e.message }, origin);
  }
  const corpo = {
    fonte: 'ANA — SNISB (Cadastro Nacional de Barragens)',
    atualizadoEm: new Date().toISOString(),
    uf: (q.get('uf') || 'MT').toUpperCase(),
    total: itens.length,
    parcial,
    observacao: parcial
      ? 'Resultado parcial: refine por UF ou bbox (teto de paginação da Fase 3).'
      : 'Cadastro oficial; níveis/risco em tempo real não incluídos.',
    barragens: itens,
  };
  const res = jsonResponse(200, corpo, origin);
  const cache = cacheHeaders(86400, 86400);
  Object.entries(cache).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set('X-Fonte', 'snisb');
  return res;
});

module.exports.normalizar = normalizar;
module.exports.montarWhere = montarWhere;
module.exports.parseBbox = parseBbox;
