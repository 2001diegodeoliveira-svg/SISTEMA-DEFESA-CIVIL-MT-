const { jsonResponse, reqUrl, cacheHeaders, corsHeaders } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { registrar } = require('../_lib/saude-fontes');
const { pointInPolygon, featureCentroid } = require('../_lib/geo');

const WFS_URL = 'https://terrabrasilis.dpi.inpe.br/geoserver/deter-amz/wfs';
const CACHE_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 25000;
const cache = new Map();

function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

async function buscar({ dias, uf, limit, offset }) {
  const key = `${uf}:${dias}:${limit}:${offset}`;
  const c = cache.get(key);
  if (c && Date.now() - c.updatedAt < CACHE_TTL_MS) return { ...c.data, _cached: true };

  const start = Date.now();
  const inicio = daysAgo(dias);
  const cql = `uf='${uf}' AND view_date >= '${inicio}'`;
  const url = `${WFS_URL}?service=WFS&version=2.0.0&request=GetFeature&typeName=deter-amz:deter_amz&outputFormat=application/json&count=${limit}&startIndex=${offset}&sortBy=view_date+D&CQL_FILTER=${encodeURIComponent(cql)}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const features = (json.features || []).map((f) => ({
      type: 'Feature',
      id: f.id,
      geometry: f.geometry,
      properties: {
        id: f.id,
        classe: f.properties.classname,
        municipio: f.properties.municipality,
        codigoMunicipio: f.properties.mun_geocod,
        uf: f.properties.uf,
        data: f.properties.view_date,
        areaKm: Number(String(f.properties.areamunkm || '0').replace(',', '.')) || 0,
        sensor: f.properties.sensor,
        satelite: f.properties.satellite,
      },
    }));
    const totalFeatures = json.totalFeatures != null ? json.totalFeatures : features.length;
    // alertas: DETER dentro de TI/UC sera calculado quando territorios disponivel; aqui apenas marca classe
    const data = {
      fonte: 'INPE DETER (Terra Brasilis)',
      atualizadoEm: new Date().toISOString(),
      status: features.length ? 'ok' : 'atrasado',
      dados: {
        uf,
        dias,
        inicio,
        totalFeatures,
        retornados: features.length,
        offset,
        areaTotalKm: features.reduce((a, f) => a + (f.properties.areaKm || 0), 0),
        features: { type: 'FeatureCollection', features },
      },
    };
    cache.set(key, { updatedAt: Date.now(), data });
    registrar('deter', { ok: true, latenciaMs: Date.now() - start });
    return data;
  } catch (e) {
    registrar('deter', { ok: false, erro: e.message });
    const c2 = cache.get(key);
    if (c2) return { ...c2.data, status: 'atrasado', _cached: true, _erro: e.message };
    return {
      fonte: 'INPE DETER (Terra Brasilis)',
      atualizadoEm: new Date().toISOString(),
      status: 'erro',
      dados: { uf, dias, inicio, totalFeatures: 0, retornados: 0, offset, areaTotalKm: 0, features: { type: 'FeatureCollection', features: [] }, erro: e.message },
    };
  } finally {
    clearTimeout(t);
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Metodo nao permitido.' }, origin);
  const url = reqUrl(req);
  const params = url ? url.searchParams : new URLSearchParams();
  const uf = (params.get('uf') || 'MT').toUpperCase();
  const dias = Math.max(1, Math.min(parseInt(params.get('dias') || '7', 10) || 7, 30));
  const limit = Math.max(1, Math.min(parseInt(params.get('limit') || '2000', 10) || 2000, 5000));
  const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);
  const data = await buscar({ dias, uf, limit, offset });
  const cacheH = cacheHeaders(1800, 3600);
  return new Response(JSON.stringify(data), {
    status: data.status === 'erro' ? 502 : 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...cacheH },
  });
});