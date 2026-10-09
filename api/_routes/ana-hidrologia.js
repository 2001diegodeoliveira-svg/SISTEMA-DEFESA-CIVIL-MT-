/* GET /api/ana-hidrologia → estações telemétricas ativas em Mato Grosso.
   O endpoint oficial retorna um catálogo XML nacional; os níveis são
   publicados em outro serviço e não são inferidos a partir do cadastro. */
const { jsonResponse } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const ANA_URL = 'https://telemetriaws1.ana.gov.br/ServiceANA.asmx/ListaEstacoesTelemetricas?statusEstacoes=0&origem=0';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20000;

let cache = { updatedAt: 0, stations: null };

function decodeXml(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const key = code.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return '\'';
    const point = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff &&
      (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : entity;
  }).trim();
}

function tagValue(row, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(row);
  return match ? decodeXml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
}

function numberValue(value) {
  const number = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function parseStations(xml) {
  const rows = [...xml.matchAll(/<Table\b[^>]*>([\s\S]*?)<\/Table>/gi)];
  if (!rows.length) throw new Error('A resposta da ANA não contém registros de estações.');

  return rows.map((match) => {
    const row = match[1];
    const municipioUf = tagValue(row, 'Municipio-UF');
    const splitAt = municipioUf.lastIndexOf('-');
    const uf = splitAt >= 0 ? municipioUf.slice(splitAt + 1).trim().toUpperCase() : '';
    const latitude = numberValue(tagValue(row, 'Latitude'));
    const longitude = numberValue(tagValue(row, 'Longitude'));
    const status = tagValue(row, 'StatusEstacao');
    return {
      codigo: tagValue(row, 'CodEstacao'),
      nome: tagValue(row, 'NomeEstacao'),
      rio: tagValue(row, 'NomeRio') || null,
      municipio: splitAt >= 0 ? municipioUf.slice(0, splitAt).trim() : municipioUf,
      uf,
      latitude,
      longitude,
      status,
    };
  }).filter((station) =>
    station.codigo &&
    station.uf === 'MT' &&
    station.status.toLowerCase() === 'ativo' &&
    station.latitude !== null &&
    station.longitude !== null
  );
}

async function fetchStations(force) {
  if (!force && cache.stations && Date.now() - cache.updatedAt < CACHE_TTL_MS) return cache;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ANA_URL, {
      headers: { Accept: 'text/xml', 'User-Agent': 'SGIProtege/1.0 (+monitoramento hidrológico)' },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error('Redirecionamento não permitido pelo serviço da ANA.');
    }
    if (!response.ok) throw new Error(`Serviço da ANA respondeu HTTP ${response.status}.`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_XML_BYTES) {
      throw new Error('Resposta da ANA excede o limite de tamanho.');
    }
    const xml = await response.text();
    if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) {
      throw new Error('Resposta da ANA excede o limite de tamanho.');
    }
    const stations = parseStations(xml);
    cache = { updatedAt: Date.now(), stations };
    return cache;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const url = new URL(req.url, 'http://localhost');
  const force = url.searchParams.get('refresh') === '1';
  try {
    const result = await fetchStations(force);
    return jsonResponse(200, {
      fonte: 'ANA — Telemetria',
      atualizadoEm: new Date(result.updatedAt).toISOString(),
      totalEstacoes: result.stations.length,
      observacao: 'Cadastro de estações telemétricas ativas em Mato Grosso; este serviço não fornece os níveis medidos.',
      estacoes: result.stations,
    }, origin);
  } catch (error) {
    console.error('[ana-hidrologia] falha ao consultar a ANA:', error && error.message);
    return jsonResponse(502, {
      erro: 'Não foi possível consultar as estações telemétricas da ANA.',
      detalhes: error && error.message ? error.message : 'Falha desconhecida.',
    }, origin);
  }
});
