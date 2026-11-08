/* ============================================================
   GET /api/ambiental-pantanal
   Mapeamento ambiental oficial da região do Pantanal a partir de
   duas fontes públicas, sem chave e verificadas ao vivo:

   1) ICMBio — WFS do INDE (GeoServer, HTTP 200):
        https://geoservicos.inde.gov.br/geoserver/ICMBio/ows
        - ICMBio:limiteucsfederais_a   (limites das UCs federais)
        - ICMBio:autos_infracao_icmbio (autos de infração lavrados)
      Filtro espacial por bbox no próprio servidor (GeoJSON).

   2) IBAMA — Dados Abertos (CKAN, HTTP 200):
        .../TERMOS_DE_EMBARGO/TERMO_EMBARGO_COORDENADAS/
          termo_de_embargo_coordenadas.csv   (~20 MB, latin1, ';')
      O CSV não tem filtro por servidor: é baixado, recortado pelo
      bbox e agrupado em polígonos por (SEQ_TAD, SEQ_POLIGONO).
      Cache em memória de 24 h evita repetir os ~5 s de download.

   Por que não usar outros caminhos do IBAMA (verificado em 2026-11-06):
     - sisfogo-roi (ROI de incêndio): 605 MB e SEM coluna de
       coordenada — lat/lon só em texto livre dentro de OBSERVACAO.
     - siscom.ibama.gov.br/geoserver: HTTP 404.
     - SHP do PAMGIA (adm_embargo_ibama_a.shp.zip): HTTP 404.

   Privacidade: o dataset do ICMBio traz nome do autuado e CPF/CNPJ.
   Esses campos NÃO são repassados — a rota devolve apenas o que o
   mapa precisa (número, tipo, valor, UC, município, data).

   Query:
     ?bbox=minLon,minLat,maxLon,maxLat  (padrão: Pantanal)
     ?camadas=ucs,autos,embargos        (padrão: todas)
     ?max=                              teto por camada (1..2000, 500)
     ?refresh=1                         ignora o cache em memória
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const ICMBIO_WFS = 'https://geoservicos.inde.gov.br/geoserver/ICMBio/ows';
const IBAMA_EMBARGOS_CSV = 'https://stibamadadosabertosprd.blob.core.windows.net'
  + '/dados-abertos/dados/TERMOS_DE_EMBARGO/TERMO_EMBARGO_COORDENADAS/termo_de_embargo_coordenadas.csv';

const CAMADAS = {
  ucs: 'ICMBio:limiteucsfederais_a',
  autos: 'ICMBio:autos_infracao_icmbio',
};

const PANTANAL_BBOX = {
  minLon: -58.9, minLat: -22.2, maxLon: -54.9, maxLat: -15.5,
};

const TIMEOUT_ICMBIO_MS = 25000;
const TIMEOUT_IBAMA_MS = 45000;
const MAX_PADRAO = 500;
const MAX_TETO = 2000;

const CACHE_TTL_ICMBIO_MS = 30 * 60 * 1000;      // 30 min
const CACHE_TTL_EMBARGOS_MS = 24 * 60 * 60 * 1000; // 24 h
const CACHE_MAX_ENTRADAS = 6;

const cacheIcmbio = new Map();
const cacheEmbargos = new Map();

function lerCache(mapa, chave, ttl) {
  const item = mapa.get(chave);
  if (!item) return null;
  if (Date.now() - item.ts >= ttl) {
    mapa.delete(chave);
    return null;
  }
  mapa.delete(chave);
  mapa.set(chave, item);
  return item.dados;
}

function gravarCache(mapa, chave, dados) {
  mapa.delete(chave);
  mapa.set(chave, { ts: Date.now(), dados });
  while (mapa.size > CACHE_MAX_ENTRADAS) {
    mapa.delete(mapa.keys().next().value);
  }
}

function limparCache() {
  cacheIcmbio.clear();
  cacheEmbargos.clear();
}

/* ---------- validação ---------- */

function parseBbox(raw) {
  if (raw == null || raw === '') return { ...PANTANAL_BBOX };
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
  if (raw == null || raw === '') return ['ucs', 'autos', 'embargos'];
  const pedidas = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const validas = pedidas.filter((c) => Object.prototype.hasOwnProperty.call(CAMADAS, c) || c === 'embargos');
  if (!validas.length) {
    throw new Error('camadas inválidas: use ucs, autos e/ou embargos.');
  }
  return [...new Set(validas)];
}

function parseMax(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MAX_PADRAO;
  return Math.min(MAX_TETO, Math.max(1, Math.floor(n)));
}

function dentroBbox(lat, lon, bbox) {
  return lat >= bbox.minLat && lat <= bbox.maxLat
    && lon >= bbox.minLon && lon <= bbox.maxLon;
}

/* ---------- ICMBio (WFS) ---------- */

async function buscarIcmbio(tipo, bbox, max) {
  const qs = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: tipo,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat},EPSG:4326`,
    count: String(max),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_ICMBIO_MS);
  try {
    const res = await fetch(`${ICMBIO_WFS}?${qs}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'SGIProtege/1.0 (+defesa civil)' },
    });
    if (!res.ok) throw new Error(`ICMBio respondeu HTTP ${res.status}.`);
    const j = await res.json();
    if (j && j.exceptions) throw new Error('ICMBio: resposta de exceção do WFS.');
    const features = Array.isArray(j.features) ? j.features : [];
    const casado = Number.isFinite(Number(j.numberMatched))
      ? Number(j.numberMatched)
      : (Number.isFinite(Number(j.totalFeatures)) ? Number(j.totalFeatures) : features.length);
    return { features, casado };
  } finally {
    clearTimeout(timer);
  }
}

function normalizarUC(f) {
  const a = (f && f.properties) || {};
  const area = Number(a.areahaalb);
  return {
    type: 'Feature',
    geometry: f.geometry || null,
    properties: {
      id: a.ogc_fid != null ? Number(a.ogc_fid) : null,
      nome: txt(a.nomeuc),
      cnuc: txt(a.cnuc),
      categoria: txt(a.categoria_),
      sigla: txt(a.sigla_cate),
      grupo: txt(a.grupouc),
      bioma: txt(a.bioma_pred) || txt(a.biomas),
      uf: txt(a.uf),
      esfera: txt(a.esferaadm),
      criacao: a.criacaoano != null ? Number(a.criacaoano) : null,
      areaHa: Number.isFinite(area) ? Math.round(area * 100) / 100 : null,
    },
  };
}

function normalizarAuto(f) {
  const a = (f && f.properties) || {};
  const valor = Number(a.valor_mult);
  const ano = Number(a.ano);
  /* autuado e cpf_cnpj são omitidos de propósito (privacidade). */
  return {
    type: 'Feature',
    geometry: f.geometry || null,
    properties: {
      id: a.ogc_fid != null ? Number(a.ogc_fid) : null,
      numero: txt(a.numero_ai),
      tipo: txt(a.tipo),
      valor: Number.isFinite(valor) ? valor : null,
      embargo: String(a.embargo || '').trim().toLowerCase() === 'sim',
      apreensao: String(a.apreensao || '').trim().toLowerCase() === 'sim',
      data: txt(a.data) ? String(a.data).slice(0, 10) : null,
      ano: Number.isFinite(ano) ? ano : null,
      tipoInfracao: txt(a.tipo_infra),
      uc: txt(a.nome_uc),
      cnuc: txt(a.cnuc),
      municipio: txt(a.municipio),
      uf: txt(a.uf),
      processo: txt(a.processo),
      descricao: txt(a.desc_ai_1),
    },
  };
}

/* ---------- IBAMA (CSV de coordenadas de embargo) ---------- */

function splitCsv(linha) {
  const out = [];
  let atual = '';
  let dentro = false;
  for (let i = 0; i < linha.length; i += 1) {
    const ch = linha[i];
    if (ch === '"') {
      if (dentro && linha[i + 1] === '"') { atual += '"'; i += 1; } else { dentro = !dentro; }
    } else if (ch === ';' && !dentro) {
      out.push(atual); atual = '';
    } else {
      atual += ch;
    }
  }
  out.push(atual);
  return out;
}

function numBR(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return NaN;
  return Number(t.replace(',', '.'));
}

/* Converte o CSV em polígonos já recortados pelo bbox.
   O recorte é feito por POLÍGONO, não por vértice: um polígono que
   apenas cruza a borda do Pantanal entra inteiro (senão o desenho
   sairia deformado, com só os vértices internos).
   Retorna { features, vertices, poligonosCasados }. */
function processarEmbargos(texto, bbox, max) {
  const linhas = texto.split(/\r?\n/);
  const grupos = new Map();

  for (let i = 1; i < linhas.length; i += 1) {
    const linha = linhas[i];
    if (!linha) continue;
    const c = splitCsv(linha);
    if (c.length < 11) continue;
    const lon = numBR(c[9]);
    const lat = numBR(c[10]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const chave = `${c[0]}|${c[2]}`;
    let g = grupos.get(chave);
    if (!g) {
      g = { seqTad: txt(c[0]), numTad: txt(c[1]), seqPoligono: txt(c[2]), area: txt(c[4]), pontos: [], dentro: false };
      grupos.set(chave, g);
    }
    const ordem = Number(c[6]);
    g.pontos.push([lon, lat, Number.isFinite(ordem) ? ordem : g.pontos.length]);
    if (!g.dentro && dentroBbox(lat, lon, bbox)) g.dentro = true;
  }

  const intersectam = [...grupos.values()].filter((g) => g.dentro);
  const usados = intersectam.slice(0, max);
  let vertices = 0;

  const features = usados.map((g) => {
    vertices += g.pontos.length;
    const pares = g.pontos.slice()
      .sort((a, b) => a[2] - b[2])
      .map((p) => [p[0], p[1]]);
    const props = {
      id: `${g.seqTad || ''}-${g.seqPoligono || ''}`,
      numTad: g.numTad,
      seqTad: g.seqTad,
      poligono: g.seqPoligono,
      areaNome: g.area || null,
      vertices: pares.length,
    };
    if (pares.length >= 3) {
      const anel = pares.slice();
      const [x0, y0] = anel[0];
      const [xn, yn] = anel[anel.length - 1];
      if (x0 !== xn || y0 !== yn) anel.push([x0, y0]);
      return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [anel] }, properties: props };
    }
    return { type: 'Feature', geometry: { type: 'Point', coordinates: pares[0] }, properties: props };
  });

  return { features, vertices, poligonosCasados: intersectam.length };
}

async function buscarEmbargos(bbox, max, force) {
  const chave = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}|${max}`;
  if (!force) {
    const emCache = lerCache(cacheEmbargos, chave, CACHE_TTL_EMBARGOS_MS);
    if (emCache) return emCache;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_IBAMA_MS);
  let texto;
  try {
    const res = await fetch(IBAMA_EMBARGOS_CSV, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'SGIProtege/1.0 (+defesa civil)' },
    });
    if (!res.ok) throw new Error(`IBAMA respondeu HTTP ${res.status}.`);
    // CSV publicado em latin1/Windows-1252: decodifica sem corromper acentos.
    texto = Buffer.from(await res.arrayBuffer()).toString('latin1');
  } finally {
    clearTimeout(timer);
  }
  const dados = processarEmbargos(texto, bbox, max);
  gravarCache(cacheEmbargos, chave, dados);
  return dados;
}

/* ---------- utilidades ---------- */

function txt(v) {
  const s = String(v == null ? '' : v).trim();
  return s || null;
}

function vazio() {
  return { type: 'FeatureCollection', features: [] };
}

function cabecalhoCache(res) {
  Object.entries(cacheHeaders(3600, 86400)).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set('X-Fonte', 'icmbio+ibama');
  return res;
}

/* ---------- handler ---------- */

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não suportado.' }, origin, { Allow: 'GET' });
  }

  const ru = reqUrl(req);
  const q = ru ? ru.searchParams : new URLSearchParams();
  const force = q.get('refresh') === '1';

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

  const avisos = [];
  const parciais = { ucs: false, autos: false, embargos: false };
  const corpo = {
    fonte: 'ICMBio (WFS/INDE) + IBAMA Dados Abertos',
    atualizadoEm: new Date().toISOString(),
    regiao: 'Pantanal',
    bbox,
    camadas,
    totais: { ucs: 0, autos: 0, embargos: 0 },
    casados: { ucs: 0, autos: 0, embargos: 0 },
    parciais,
    avisos,
    ucs: vazio(),
    autos: vazio(),
    embargos: vazio(),
  };

  const tarefas = [];

  if (camadas.includes('ucs')) {
    tarefas.push(buscarIcmbio(CAMADAS.ucs, bbox, max).then((r) => {
      const features = r.features.map(normalizarUC).filter((f) => f.geometry);
      corpo.ucs = { type: 'FeatureCollection', features };
      corpo.totais.ucs = features.length;
      corpo.casados.ucs = r.casado;
      parciais.ucs = r.casado > features.length;
    }).catch((e) => {
      parciais.ucs = true;
      avisos.push('UCs federais (ICMBio): ' + e.message);
    }));
  }

  if (camadas.includes('autos')) {
    tarefas.push(buscarIcmbio(CAMADAS.autos, bbox, max).then((r) => {
      const features = r.features.map(normalizarAuto).filter((f) => f.geometry);
      corpo.autos = { type: 'FeatureCollection', features };
      corpo.totais.autos = features.length;
      corpo.casados.autos = r.casado;
      parciais.autos = r.casado > features.length;
    }).catch((e) => {
      parciais.autos = true;
      avisos.push('Autos de infração (ICMBio): ' + e.message);
    }));
  }

  if (camadas.includes('embargos')) {
    tarefas.push(buscarEmbargos(bbox, max, force).then((r) => {
      corpo.embargos = { type: 'FeatureCollection', features: r.features };
      corpo.totais.embargos = r.features.length;
      corpo.casados.embargos = r.poligonosCasados;
      parciais.embargos = r.poligonosCasados > r.features.length;
    }).catch((e) => {
      parciais.embargos = true;
      avisos.push('Termos de embargo (IBAMA): ' + e.message);
    }));
  }

  await Promise.all(tarefas);

  const todasFalharam = camadas.every((c) => parciais[c] === true);
  const status = todasFalharam ? 502 : 200;
  if (status === 502) {
    return jsonResponse(502, {
      erro: 'Nenhuma fonte do ICMBio/IBAMA respondeu.',
      detalhes: avisos,
    }, origin);
  }

  const res = jsonResponse(status, corpo, origin);
  return cabecalhoCache(res);
});

module.exports.parseBbox = parseBbox;
module.exports.parseCamadas = parseCamadas;
module.exports.parseMax = parseMax;
module.exports.processarEmbargos = processarEmbargos;
module.exports.normalizarUC = normalizarUC;
module.exports.normalizarAuto = normalizarAuto;
module.exports.limparCache = limparCache;
module.exports.PANTANAL_BBOX = PANTANAL_BBOX;
module.exports.buscarIcmbio = buscarIcmbio;
module.exports.buscarEmbargos = buscarEmbargos;
module.exports.CAMADAS = CAMADAS;
