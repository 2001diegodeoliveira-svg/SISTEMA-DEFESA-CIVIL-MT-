/* ============================================================
   GET /api/pantanal-mt
   Monitoramento integrado da região do Pantanal em Mato Grosso.

   Delimitação (api/_lib/pantanal-mt.json, gerada por
   scripts/pantanal-mt/gerar-regiao.py a partir de dados oficiais
   do IBGE: bioma 1:250.000 ∩ malha municipal MT 2022):
     - polígono da região, bbox e municípios com >= 1% da área no bioma.
   Nomes e códigos dos municípios são conferidos na API do IBGE
   (servicodados.ibge.gov.br/api/v1/localidades), com cache de 24 h.

   Seções de monitoramento (cada uma isolada: falha vira status "erro"):
     focos        INPE/TerraBrasilis WFS  focos_48h_br_todosats (bbox + recorte)
     clima        Open-Meteo (grade de pontos dentro da região) + índice de risco
     hidrologia   ANA telemetria (estações ativas dentro da região)
     chuva        INMET BDMEP (reaproveita /api/inmet-chuva)
     ambiental    ICMBio (UCs, autos) e IBAMA (embargos) reaproveitados de
                  /api/ambiental-pantanal

   Query: ?refresh=1 ignora o cache em memória (15 min).
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const REGIAO = require('../_lib/pantanal-mt.json');
const ana = require('./ana-hidrologia');
const inmet = require('./inmet-chuva');
const ambiental = require('./ambiental-pantanal');

const INPE_WFS = 'https://terrabrasilis.dpi.inpe.br/queimadas/geoserver/dados_abertos/ows';
const INPE_CAMADA = 'dados_abertos:focos_48h_br_todosats';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const IBGE_MUNICIPIOS_MT = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados/51/municipios';

const TIMEOUT = { focos: 25000, clima: 20000, ibge: 10000, chuva: 40000, ambiental: 45000 };
const GRADE_PASSO = 0.25;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_IBGE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_CLIMA_TTL_MS = 30 * 60 * 1000;
const CACHE_RESPOSTA_TTL_MS = 15 * 60 * 1000;

let cacheResposta = null;
let cacheIbge = null;
let cacheClima = null;
/* Antiabuso: refresh=1 e publico e dispara 5 fontes externas pesadas.
   Um cooldown por instancia evita que um loop externo zere o cache. */
const REFRESH_COOLDOWN_MS = 60 * 1000;
let ultimoRefreshForcado = 0;

function limparCache() {
  cacheResposta = null;
  cacheIbge = null;
  cacheClima = null;
  ultimoRefreshForcado = 0;
}

/* ---------- geometria da região ---------- */

function noAnel(lon, lat, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i];
    const [xj, yj] = anel[j];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi)) {
      dentro = !dentro;
    }
  }
  return dentro;
}

function naRegiao(lon, lat) {
  const [minLon, minLat, maxLon, maxLat] = REGIAO.bbox;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return false;
  const g = REGIAO.geojson.geometry;
  const poligonos = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return poligonos.some((p) => noAnel(lon, lat, p[0]) && !p.slice(1).some((h) => noAnel(lon, lat, h)));
}

function pontosDaGrade() {
  const [minLon, minLat, maxLon, maxLat] = REGIAO.bbox;
  const pontos = [];
  for (let la = minLat; la <= maxLat; la += GRADE_PASSO) {
    for (let lo = minLon; lo <= maxLon; lo += GRADE_PASSO) {
      const lat = Math.round(la * 1000) / 1000;
      const lon = Math.round(lo * 1000) / 1000;
      if (naRegiao(lon, lat)) pontos.push({ lat, lon });
    }
  }
  return pontos;
}

/* ---------- utilidades ---------- */

function comTimeout(promessa, ms, nome) {
  let timer;
  const limite = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${nome}: tempo esgotado após ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

async function jsonComTimeout(url, ms, nome) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'SGIProtege/1.0 (+monitoramento)' } });
    if (!res.ok) throw new Error(`${nome} respondeu HTTP ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ---------- IBGE: nomes oficiais dos municípios ---------- */

async function municipiosIbge() {
  if (cacheIbge && Date.now() - cacheIbge.ts < CACHE_IBGE_TTL_MS) return cacheIbge.mapa;
  const lista = await jsonComTimeout(IBGE_MUNICIPIOS_MT, TIMEOUT.ibge, 'IBGE');
  const mapa = new Map(lista.map((m) => [String(m.id), m.nome]));
  cacheIbge = { ts: Date.now(), mapa };
  return mapa;
}

/* ---------- risco climático (mesma heurística de pantanal-fogo.html) ---------- */

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function indiceRisco(rh, t, vento, diasSemChuva) {
  return Math.round(
    clamp01(diasSemChuva / 14) * 35 +
    clamp01((60 - rh) / 45) * 30 +
    clamp01((t - 25) / 15) * 20 +
    clamp01(vento / 30) * 15
  );
}

function classeRisco(s) {
  if (s < 25) return 'Baixo';
  if (s < 45) return 'Moderado';
  if (s < 65) return 'Alto';
  return 'Extremo';
}

function diasSemChuva(precipitacao) {
  let d = 0;
  for (let i = precipitacao.length - 2; i >= 0; i--) {
    if ((precipitacao[i] || 0) < 1) d++;
    else break;
  }
  return d;
}

/* ---------- seções ---------- */

async function secaoFocos() {
  const [minLon, minLat, maxLon, maxLat] = REGIAO.bbox;
  const qs = new URLSearchParams({
    service: 'WFS',
    version: '1.1.0',
    request: 'GetFeature',
    typeName: INPE_CAMADA,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${minLon},${minLat},${maxLon},${maxLat},EPSG:4326`,
    maxFeatures: '20000',
  });
  const j = await jsonComTimeout(`${INPE_WFS}?${qs}`, TIMEOUT.focos, 'INPE');
  const feats = Array.isArray(j.features) ? j.features : [];
  const dentro = feats.filter((f) => f.geometry && naRegiao(f.geometry.coordinates[0], f.geometry.coordinates[1]));
  const porCodigo = new Map(REGIAO.municipios.map((m) => [m.codigo, { codigo: m.codigo, nome: m.nome, focos: 0 }]));
  let frp = 0;
  for (const f of dentro) {
    const p = f.properties || {};
    frp += num(p.frp) || 0;
    const alvo = porCodigo.get(String(p.id_2));
    if (alvo) alvo.focos++;
  }
  const ultimos = dentro
    .map((f) => ({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      dataHora: f.properties.data_hora_gmt || null,
      satelite: f.properties.satelite || null,
      municipio: f.properties.municipio || null,
      frp: num(f.properties.frp),
    }))
    .sort((a, b) => String(b.dataHora).localeCompare(String(a.dataHora)))
    .slice(0, 10);
  return {
    janela: '48 h (INPE BDQueimadas)',
    total: dentro.length,
    frpTotalMW: Math.round(frp * 10) / 10,
    porMunicipio: [...porCodigo.values()].filter((m) => m.focos > 0).sort((a, b) => b.focos - a.focos),
    ultimos,
  };
}

async function secaoClima() {
  if (cacheClima && Date.now() - cacheClima.ts < CACHE_CLIMA_TTL_MS) return cacheClima.dados;
  const pontos = pontosDaGrade();
  const qs = new URLSearchParams({
    latitude: pontos.map((p) => p.lat).join(','),
    longitude: pontos.map((p) => p.lon).join(','),
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m',
    daily: 'precipitation_sum',
    past_days: '14',
    forecast_days: '1',
    timezone: 'auto',
  });
  const j = await jsonComTimeout(`${OPEN_METEO}?${qs}`, TIMEOUT.clima, 'Open-Meteo');
  const lista = Array.isArray(j) ? j : [j];
  const medidas = lista.map((d, i) => {
    const c = d.current || {};
    const dias = diasSemChuva((d.daily && d.daily.precipitation_sum) || []);
    const risco = indiceRisco(num(c.relative_humidity_2m) ?? 60, num(c.temperature_2m) ?? 25, num(c.wind_speed_10m) ?? 0, dias);
    return { lat: pontos[i].lat, lon: pontos[i].lon, t: num(c.temperature_2m), rh: num(c.relative_humidity_2m), vento: num(c.wind_speed_10m), dias, risco };
  }).filter((m) => m.t !== null);
  if (!medidas.length) throw new Error('Open-Meteo não devolveu medições.');
  const soma = (k) => medidas.reduce((s, m) => s + m[k], 0) / medidas.length;
  const classes = { Baixo: 0, Moderado: 0, Alto: 0, Extremo: 0 };
  medidas.forEach((m) => { classes[classeRisco(m.risco)]++; });
  const pior = medidas.reduce((a, b) => (b.risco > a.risco ? b : a));
  const dados = {
    fonte: 'Open-Meteo (modelo) · índice heurístico de risco',
    pontos: medidas.length,
    temperaturaMediaC: Math.round(soma('t') * 10) / 10,
    umidadeMediaPct: Math.round(soma('rh')),
    ventoMaxKmh: Math.round(Math.max(...medidas.map((m) => m.vento))),
    diasSemChuvaMax: Math.max(...medidas.map((m) => m.dias)),
    riscoMedio: Math.round(soma('risco')),
    riscoMaximo: { valor: pior.risco, classe: classeRisco(pior.risco), lat: pior.lat, lon: pior.lon },
    classes,
  };
  cacheClima = { ts: Date.now(), dados };
  return dados;
}

async function secaoHidrologia() {
  const { stations } = await ana.fetchStations(false);
  const porCodigo = new Map();
  for (const s of stations) {
    if (String(s.status || '').toLowerCase() !== 'ativo' || !naRegiao(s.longitude, s.latitude)) continue;
    if (!porCodigo.has(s.codigo)) porCodigo.set(s.codigo, s);
  }
  const ativas = [...porCodigo.values()];
  return {
    fonte: 'ANA — telemetria (cadastro de estações ativas; níveis não incluídos)',
    total: ativas.length,
    estacoes: ativas.slice(0, 50).map((s) => ({ codigo: s.codigo, nome: s.nome, rio: s.rio, municipio: s.municipio, lat: s.latitude, lon: s.longitude })),
  };
}

async function secaoChuva() {
  const ano = String(new Date().getUTCFullYear());
  const dados = await inmet.obterDados(ano, 'MT', false);
  const dentro = dados.estacoes.filter((e) => naRegiao(e.lon, e.lat));
  const media = (k) => (dentro.length ? Math.round((dentro.reduce((s, e) => s + e[k], 0) / dentro.length) * 10) / 10 : null);
  const maior = dentro.reduce((a, b) => (b.chuva24h > (a ? a.chuva24h : -1) ? b : a), null);
  return {
    fonte: 'INMET — BDMEP (dados históricos)',
    cobertura: dados.cobertura,
    total: dentro.length,
    chuva24hMediaMm: media('chuva24h'),
    chuva7dMediaMm: media('chuva7d'),
    maiorChuva24h: maior ? { estacao: maior.nome, codigo: maior.codigo, mm: maior.chuva24h } : null,
  };
}

async function secaoAmbiental() {
  const bbox = { minLon: REGIAO.bbox[0], minLat: REGIAO.bbox[1], maxLon: REGIAO.bbox[2], maxLat: REGIAO.bbox[3] };
  const [ucsR, autosR, embR] = await Promise.all([
    ambiental.buscarIcmbio(ambiental.CAMADAS.ucs, bbox, 200),
    ambiental.buscarIcmbio(ambiental.CAMADAS.autos, bbox, 2000),
    ambiental.buscarEmbargos(bbox, 2000, false),
  ]);
  const ucs = ucsR.features.map(ambiental.normalizarUC).filter((f) => f.geometry &&
    (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates])
      .some((poli) => poli.some((anel) => anel.some(([x, y]) => naRegiao(x, y)))));
  const autos = autosR.features.map(ambiental.normalizarAuto).filter((f) => {
    const c = f.geometry && f.geometry.coordinates && f.geometry.coordinates[0];
    return c && naRegiao(c[0], c[1]);
  });
  const embargos = embR.features.filter((f) => {
    const g = f.geometry;
    const anel = g.type === 'Polygon' ? g.coordinates[0] : [g.coordinates];
    return anel.some(([x, y]) => naRegiao(x, y));
  });
  const valorAutos = autos.reduce((s, f) => s + (f.properties.valor || 0), 0);
  return {
    fonte: 'ICMBio (UCs e autos de infração) · IBAMA (termos de embargo)',
    ucs: { total: ucs.length, nomes: ucs.map((f) => f.properties.nome).filter(Boolean).slice(0, 20) },
    autos: { total: autos.length, comEmbargo: autos.filter((f) => f.properties.embargo).length, valorTotal: valorAutos },
    embargos: { total: embargos.length },
  };
}

/* ---------- agregação ---------- */

const SECOES = {
  focos: { fn: secaoFocos, timeout: TIMEOUT.focos },
  clima: { fn: secaoClima, timeout: TIMEOUT.clima },
  hidrologia: { fn: secaoHidrologia, timeout: 20000 },
  chuva: { fn: secaoChuva, timeout: TIMEOUT.chuva },
  ambiental: { fn: secaoAmbiental, timeout: TIMEOUT.ambiental },
};

async function montarResposta() {
  const avisos = [];
  const nomes = Object.keys(SECOES);
  const resultados = await Promise.allSettled(nomes.map((n) => comTimeout(SECOES[n].fn(), SECOES[n].timeout, n)));
  const monitoramento = {};
  const status = {};
  nomes.forEach((n, i) => {
    const r = resultados[i];
    if (r.status === 'fulfilled') {
      monitoramento[n] = r.value;
      status[n] = 'ok';
    } else {
      status[n] = 'erro';
      monitoramento[n] = null;
      avisos.push(`${n}: ${r.reason && r.reason.message ? r.reason.message : 'falha desconhecida.'}`);
    }
  });

  let nomesIbge = null;
  try {
    nomesIbge = await municipiosIbge();
  } catch (e) {
    avisos.push('IBGE (nomes oficiais): ' + e.message + ' Usando nomes do snapshot.');
  }
  const municipios = REGIAO.municipios.map((m) => ({
    codigo: m.codigo,
    nome: nomesIbge && nomesIbge.get(m.codigo) ? nomesIbge.get(m.codigo) : m.nome,
    percentualNoBioma: m.percentualNoBioma,
  }));

  const todosFalharam = nomes.every((n) => status[n] === 'erro');
  return {
    erro: todosFalharam,
    corpo: {
      regiao: {
        nome: REGIAO.regiao,
        criterio: REGIAO.criterio,
        bbox: REGIAO.bbox,
        municipios,
        geojson: REGIAO.geojson,
        fontes: { delimitacao: REGIAO.fontes, geradoEm: REGIAO.geradoEm, municipiosIbge: nomesIbge ? 'api.ibge' : 'snapshot' },
      },
      atualizadoEm: new Date().toISOString(),
      status,
      monitoramento,
      avisos,
    },
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin, { Allow: 'GET' });

  const ru = reqUrl(req);
  const pediuRefresh = ru ? ru.searchParams.get('refresh') === '1' : false;
  const force = pediuRefresh && (Date.now() - ultimoRefreshForcado >= REFRESH_COOLDOWN_MS);
  if (force) ultimoRefreshForcado = Date.now();
  if (!force && cacheResposta && Date.now() - cacheResposta.ts < CACHE_RESPOSTA_TTL_MS) {
    const res = jsonResponse(200, cacheResposta.corpo, origin);
    Object.entries(cacheHeaders(900, 3600)).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }

  const r = await montarResposta();
  if (r.erro) {
    return jsonResponse(502, { erro: 'Nenhuma fonte de monitoramento respondeu.', detalhes: r.corpo.avisos }, origin);
  }
  cacheResposta = { ts: Date.now(), corpo: r.corpo };
  const res = jsonResponse(200, r.corpo, origin);
  Object.entries(cacheHeaders(900, 3600)).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set('X-Fonte', 'inpe+open-meteo+ana+inmet+icmbio+ibama+ibge');
  return res;
});

module.exports.limparCache = limparCache;
module.exports.naRegiao = naRegiao;
module.exports.indiceRisco = indiceRisco;
module.exports.classeRisco = classeRisco;
module.exports.diasSemChuva = diasSemChuva;
