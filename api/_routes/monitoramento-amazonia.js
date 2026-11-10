/* ============================================================
   GET /api/monitoramento-amazonia?horas=24|48|72|96|120&refresh=1
   Monitoramento 24 h do bioma Amazônia em Mato Grosso.

   Delimitação: api/_lib/amazonia-mt.json (IBGE: bioma Amazônia ∩ MT,
   gerada por scripts/pantanal-mt/gerar-regiao.py).

   Fontes e estado de cada uma (cada seção é isolada):
     inpe       INPE Programa Queimadas — CSV diário oficial de focos
                (dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario)
     firms      NASA FIRMS — via api/_routes/firms.js (MAP_KEY no servidor)
     censipam   CENSIPAM Painel do Fogo — eventos de fogo do MT
                (panorama.sipam.gov.br/painel-do-fogo/api/v1/eventos)
     mapbiomas  MapBiomas Alerta — GraphQL exige token pessoal da plataforma
                (MAPBIOMAS_TOKEN). Sem token, status "sem_token".
   TerraBrasilis (TerraBrasilis WFS de focos) é coberto pela seção INPE
   quando o CSV diário estiver indisponível: não é usado aqui para não
   duplicar contagens.
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { pointInPolygon, bboxOfGeometry } = require('../_lib/geo');
const REGIAO = require('../_lib/amazonia-mt.json');
const firms = require('./firms');

const INPE_CSV = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_';
const CENSIPAM_EVENTOS = 'https://panorama.sipam.gov.br/painel-do-fogo/api/v1/eventos?sigla_estado=MT';
const HORAS_PADRAO = 24;
const HORAS_MAX = 120;
const TIMEOUT = { inpe: 40000, censipam: 40000 };
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 8;

const cache = new Map();

function limparCache() {
  cache.clear();
}

function parseHoras(raw) {
  if (raw == null || raw === '') return HORAS_PADRAO;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > HORAS_MAX) {
    throw new Error(`horas inválidas: use um inteiro de 1 a ${HORAS_MAX}.`);
  }
  return n;
}

function dentroDaRegiao(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && pointInPolygon([lon, lat], REGIAO.geojson.geometry);
}

function bboxRegiao() {
  const [minLon, minLat, maxLon, maxLat] = bboxOfGeometry(REGIAO.geojson.geometry);
  return { minLon, minLat, maxLon, maxLat };
}

function datasDaJanela(horas, agora) {
  const datas = new Set();
  for (let t = agora - horas * 3600000; t <= agora + 1; t += 86400000) {
    datas.add(new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  }
  datas.add(new Date(agora).toISOString().slice(0, 10).replace(/-/g, ''));
  return [...datas].sort();
}

async function baixarTexto(url, ms, nome) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'SGIProtege/1.0 (+monitoramento)' } });
    if (res.status === 404) return null; // dia ainda não publicado
    if (!res.ok) throw new Error(`${nome} respondeu HTTP ${res.status}.`);
    return Buffer.from(await res.arrayBuffer()).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

/* CSV simples com aspas (campos do INPE podem trazer vírgula entre aspas). */
function splitCsv(linha) {
  const out = [];
  let atual = '';
  let dentro = false;
  for (let i = 0; i < linha.length; i += 1) {
    const ch = linha[i];
    if (ch === '"') {
      if (dentro && linha[i + 1] === '"') { atual += '"'; i += 1; } else { dentro = !dentro; }
    } else if (ch === ',' && !dentro) {
      out.push(atual); atual = '';
    } else {
      atual += ch;
    }
  }
  out.push(atual);
  return out;
}

function parseFocosInpe(texto, desdeMs) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) return [];
  const cab = splitCsv(linhas[0]).map((h) => h.trim().toLowerCase());
  const idx = (nome) => cab.indexOf(nome);
  const iLat = idx('lat'), iLon = idx('lon'), iData = idx('data_hora_gmt');
  if (iLat < 0 || iLon < 0 || iData < 0) throw new Error('CSV do INPE sem colunas lat/lon/data_hora_gmt.');
  const focos = [];
  for (let n = 1; n < linhas.length; n++) {
    const c = splitCsv(linhas[n]);
    if (c.length < cab.length) continue;
    const lat = Number(c[iLat]), lon = Number(c[iLon]);
    if (!dentroDaRegiao(lat, lon)) continue;
    const quando = Date.parse(c[iData]);
    if (!Number.isFinite(quando) || quando < desdeMs) continue;
    const campo = (nome) => (idx(nome) >= 0 ? (c[idx(nome)] || '').trim() : '');
    const frp = Number(campo('frp'));
    focos.push({
      lat, lon,
      dataHora: new Date(quando).toISOString(),
      satelite: campo('satelite') || null,
      municipio: campo('municipio') || null,
      municipioId: campo('municipio_id') || null,
      bioma: campo('bioma') || null,
      frp: Number.isFinite(frp) ? frp : null,
      risco: campo('risco_fogo') || null,
    });
  }
  return focos;
}

async function secaoInpe(horas, agora) {
  const desde = agora - horas * 3600000;
  const datas = datasDaJanela(horas, agora);
  const textos = await Promise.all(datas.map((d) => baixarTexto(INPE_CSV + d + '.csv', TIMEOUT.inpe, 'INPE')));
  const focos = [];
  let diasSemDados = 0;
  textos.forEach((t) => {
    if (t === null) { diasSemDados++; return; }
    focos.push(...parseFocosInpe(t, desde));
  });
  if (diasSemDados === datas.length) throw new Error('INPE: nenhum arquivo diário publicado para a janela.');
  return { focos, diasConsultados: datas.length, diasSemDados };
}

async function secaoCensipam(horas, agora) {
  const desde = agora - horas * 3600000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT.censipam);
  let lista;
  try {
    const res = await fetch(CENSIPAM_EVENTOS, { signal: ctrl.signal, headers: { 'User-Agent': 'SGIProtege/1.0 (+monitoramento)' } });
    if (!res.ok) throw new Error(`CENSIPAM respondeu HTTP ${res.status}.`);
    lista = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (!Array.isArray(lista)) throw new Error('CENSIPAM: resposta fora do formato esperado.');
  const eventos = lista
    .filter((e) => dentroDaRegiao(Number(e.latitude), Number(e.longitude)))
    .filter((e) => Date.parse(e.dt_ultima_visao) >= desde)
    .map((e) => ({
      id: e.id_evento,
      status: e.status_evento || null,
      municipio: e.municipio || null,
      ultimaVisao: e.dt_ultima_visao || null,
      persistenciaDias: Number.isFinite(Number(e.persistencia_dias)) ? Number(e.persistencia_dias) : null,
      area: Number.isFinite(Number(e.area_total_evento)) ? Number(e.area_total_evento) : null,
      lat: Number(e.latitude),
      lon: Number(e.longitude),
      unidadeConservacao: e.unidade_conservacao || null,
      terraIndigena: e.terra_indigena || null,
      retangulo: e.retangulo_envolvente || null,
    }));
  return { eventos };
}

function resumirFocos(focos) {
  const porMun = new Map();
  const porSat = {};
  let frp = 0;
  for (const f of focos) {
    frp += f.frp || 0;
    const chave = f.municipioId || f.municipio || 'desconhecido';
    const m = porMun.get(chave) || { codigo: f.municipioId, nome: f.municipio, focos: 0 };
    m.focos++;
    porMun.set(chave, m);
    const s = f.satelite || 'desconhecido';
    porSat[s] = (porSat[s] || 0) + 1;
  }
  return {
    total: focos.length,
    frpTotalMW: Math.round(frp * 10) / 10,
    porMunicipio: [...porMun.values()].sort((a, b) => b.focos - a.focos).slice(0, 15),
    porSatelite: porSat,
    ultimos: focos.slice().sort((a, b) => b.dataHora.localeCompare(a.dataHora)).slice(0, 10),
  };
}

async function montar(horas, agora) {
  const avisos = [];
  const [inpeR, firmsR, censipamR] = await Promise.allSettled([
    secaoInpe(horas, agora),
    firms.buscarFocos({
      bbox: bboxRegiao(),
      dias: Math.min(5, Math.max(1, Math.ceil(horas / 24))),
      fonte: 'VIIRS_SNPP_NRT',
    }),
    secaoCensipam(horas, agora),
  ]);

  const status = {};
  const inpe = inpeR.status === 'fulfilled' ? { ...inpeR.value, ...resumirFocos(inpeR.value.focos) } : null;
  if (inpeR.status === 'fulfilled') status.inpe = 'ok';
  else { status.inpe = 'erro'; avisos.push('INPE: ' + inpeR.reason.message); }

  let firmsOut = null;
  if (firmsR.status === 'fulfilled') {
    const focos = firmsR.value.focos
      .filter((f) => dentroDaRegiao(f.lat, f.lon))
      .filter((f) => Date.parse(`${f.data}T${f.hora}:00Z`) >= agora - horas * 3600000);
    firmsOut = {
      fonte: firmsR.value.fonte,
      ...resumirFocos(focos.map((f) => ({
        lat: f.lat, lon: f.lon,
        dataHora: `${f.data}T${f.hora}:00.000Z`,
        satelite: f.satelite, municipio: null, municipioId: null, bioma: null,
        frp: f.frp, risco: f.confianca,
      }))),
    };
    status.firms = 'ok';
  } else if (firmsR.reason && firmsR.reason.semChave) {
    status.firms = 'sem_chave';
    avisos.push('NASA FIRMS: FIRMS_MAP_KEY não configurada no servidor.');
  } else {
    status.firms = 'erro';
    avisos.push('NASA FIRMS: ' + (firmsR.reason && firmsR.reason.message));
  }

  let censipam = null;
  if (censipamR.status === 'fulfilled') {
    const ev = censipamR.value.eventos;
    censipam = {
      total: ev.length,
      areaTotal: Math.round(ev.reduce((s, e) => s + (e.area || 0), 0) * 100) / 100,
      emUnidadeConservacao: ev.filter((e) => e.unidadeConservacao).length,
      emTerraIndigena: ev.filter((e) => e.terraIndigena).length,
      eventos: ev.slice(0, 200),
    };
    status.censipam = 'ok';
  } else {
    status.censipam = 'erro';
    avisos.push('CENSIPAM: ' + censipamR.reason.message);
  }

  const token = (process.env.MAPBIOMAS_TOKEN || '').trim();
  const mapbiomas = token
    ? { status: 'pendente', mensagem: 'Token presente. Consulta de alertas ainda não validada contra o schema GraphQL do MapBiomas Alerta.' }
    : { status: 'sem_token', mensagem: 'Defina MAPBIOMAS_TOKEN no servidor (conta em plataforma.alerta.mapbiomas.org).' };
  status.mapbiomas = mapbiomas.status;

  return {
    corpo: {
      janelaHoras: horas,
      atualizadoEm: new Date(agora).toISOString(),
      regiao: {
        nome: REGIAO.regiao,
        criterio: REGIAO.criterio,
        bbox: REGIAO.bbox,
        municipios: REGIAO.municipios,
        geojson: REGIAO.geojson,
        fontes: { delimitacao: REGIAO.fontes, geradoEm: REGIAO.geradoEm },
      },
      status,
      inpe,
      firms: firmsOut,
      censipam,
      mapbiomas,
      avisos,
    },
    falhouTudo: status.inpe === 'erro' && status.censipam === 'erro',
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin, { Allow: 'GET' });

  const ru = reqUrl(req);
  const q = ru ? ru.searchParams : new URLSearchParams();
  let horas;
  try {
    horas = parseHoras(q.get('horas'));
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }

  const agora = Date.now();
  const chave = String(horas);
  const emCache = cache.get(chave);
  if (q.get('refresh') !== '1' && emCache && Date.now() - emCache.ts < CACHE_TTL_MS) {
    const res = jsonResponse(200, emCache.corpo, origin);
    Object.entries(cacheHeaders(600, 1800)).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }

  const r = await montar(horas, agora);
  if (r.falhouTudo) {
    return jsonResponse(502, { erro: 'INPE e CENSIPAM indisponíveis.', detalhes: r.corpo.avisos }, origin);
  }
  cache.delete(chave);
  cache.set(chave, { ts: Date.now(), corpo: r.corpo });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  const res = jsonResponse(200, r.corpo, origin);
  Object.entries(cacheHeaders(600, 1800)).forEach(([k, v]) => res.headers.set(k, v));
  res.headers.set('X-Fonte', 'inpe+firms+censipam+mapbiomas');
  return res;
});

module.exports.parseHoras = parseHoras;
module.exports.parseFocosInpe = parseFocosInpe;
module.exports.splitCsv = splitCsv;
module.exports.datasDaJanela = datasDaJanela;
module.exports.limparCache = limparCache;
