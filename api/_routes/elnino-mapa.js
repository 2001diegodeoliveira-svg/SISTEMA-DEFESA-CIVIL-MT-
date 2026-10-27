/* ============================================================
   GET /api/elnino-mapa — dados para o mapa El Niño (Fase 1+2).
   Parâmetros:
     ?camada=sst           → anomalia SST (NOAA OISST) + timeline (GeoJSON)
     ?camada=focos         → focos de calor (INPE/FIRMS) (GeoJSON)
     ?camada=nino34-series → série histórica Niño 3.4 (ONI) p/ gráfico
     ?camada=chuva         → precipitação + anomalia (GPM IMERG / CHIRPS)
     ?camada=seca          → índices de seca (SPI, NDVI, umidade solo)
     ?camada=rios          → níveis e vazão (ANA)
     ?camada=alertas       → alertas geoespaciais por regra
     ?municipio=XXX        → filtro por município (código IBGE)
     ?bacia=XXX            → filtro por bacia (código ANA/Ottobacias)
   ============================================================ */
const { jsonResponse, reqUrl, cacheHeaders } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const OISST_URL = process.env.ELNINO_OISST_URL || 'https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/sst.day.mean.lon.-180.180.nc';
const FIRMS_URL = process.env.ELNINO_FIRMS_URL || 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/KEY/MODIS_NRT/-180,-90,180,90/1';
const INPE_QUEIMADAS_URL = process.env.ELNINO_INPE_URL || 'https://dadosabertos.ibge.gov.br/dataset/queimadas';
const GPM_IMERG_URL = process.env.ELNINO_GPM_URL || 'https://gpm1.gesdisc.eosdis.nasa.gov/data/GPM_L3/GPM_3IMERGDF.07';
const CHIRPS_URL = process.env.ELNINO_CHIRPS_URL || 'https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_daily/tifs';
const ANA_HIDRO_URL = process.env.ELNINO_ANA_URL || 'https://telemetriaws1.ana.gov.br/ServiceANA.asmx/HidroSerieHistorica';
const CACHE_TTL_SST = 3600;
const CACHE_TTL_FOCOS = 1800;
const CACHE_TTL_CHUVA = 3600;
const CACHE_TTL_SECA = 21600;
const CACHE_TTL_RIOS = 1800;
const CACHE_TTL_ALERTAS = 600;
const TIMEOUT_MS = 20000;

let sstCache = { updatedAt: 0, data: null };
const focosCache = {}; // chave `${regiao}:${dias}` -> { updatedAt, data }
let chuvaCache = { updatedAt: 0, data: null };
let secaCache = { updatedAt: 0, data: null };
let riosCache = { updatedAt: 0, data: null };
let alertasCache = { updatedAt: 0, data: null };

async function fetchWithTimeout(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------------- SST Anomaly (NOAA OISST) ---------------------- */
// Para Fase 1 MVP: usamos dados simplificados (grade regular 0.25°).
// Em produção, ler NetCDF via xarray (Python worker) e servir COG/Tiles.
// Aqui, mock realista para validar o front; trocar por leitura real na Fase 2.
async function buildSSTGeoJSON() {
    const now = Date.now();
    if (sstCache.data && now - sstCache.updatedAt < CACHE_TTL_SST * 1000) {
        return { ...sstCache.data, _cached: true };
    }

    const fs = require('fs');
    const path = require('path');
    function readLocalOisst() {
        const candidates = [
            path.join(process.cwd(), 'data', 'oisst-anomaly.json'),
            path.join(process.cwd(), 'oisst-anomaly.json'),
            path.join(__dirname, '..', '..', 'data', 'oisst-anomaly.json'),
            path.join(__dirname, '..', '..', 'oisst-anomaly.json'),
        ];
        for (const p of candidates) {
            try {
                if (fs.existsSync(p)) {
                    const raw = fs.readFileSync(p, 'utf8');
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.geojson && Array.isArray(parsed.geojson.features) && parsed.geojson.features.length) return parsed;
                }
            } catch (e) { /* ignora */ }
        }
        return null;
    }

    let real = null;
    const jsonUrl = process.env.ELNINO_OISST_JSON_URL;
    if (jsonUrl) {
        try {
            const res = await fetchWithTimeout(jsonUrl);
            const parsed = await res.json();
            if (parsed && parsed.geojson && Array.isArray(parsed.geojson.features) && parsed.geojson.features.length) real = parsed;
        } catch (e) { /* ignora, cai no fallback */ }
    }
    if (!real) real = readLocalOisst();

    let data;
    if (real) {
        const latestDate = real.date || (real.latest && real.latest.date) || new Date().toISOString().slice(0, 10);
        data = {
            geojson: real.geojson,
            timeline: [{ date: latestDate, isForecast: false, geojson: real.geojson }],
            latest: { date: latestDate },
            fonte: real.fonte || 'NOAA OISST v2.1 (anomalia)',
            atualizadoEm: real.atualizadoEm || new Date().toISOString(),
            real: true,
        };
    } else {
        // Fallback ilustrativo: grade sintetica baseada no ultimo ONI.
        const enso = require('../_lib/enso');
        const ultima = await enso.ultimaAmostra('ONI');
        const baseAnom = (ultima && typeof ultima.valor === 'number') ? ultima.valor : 1.2;
        const latestDate = ultima?.observadoEm || new Date().toISOString().slice(0, 10);

        const anomGrid = [];
        const latStart = 5, latEnd = -5, lonStart = -170, lonEnd = -120;
        for (let lat = latEnd; lat <= latStart; lat += 0.5) {
            for (let lon = lonEnd; lon <= lonStart; lon += 0.5) {
                const latFactor = Math.max(0, 1 - Math.abs(lat) / 10);
                const noise = (Math.sin(lon * 0.5) * Math.cos(lat * 0.3)) * 0.3;
                const anom = baseAnom * latFactor + noise;
                anomGrid.push({ lat, lon, anom: Number(anom.toFixed(2)) });
            }
        }
        const features = anomGrid.map(p => ({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [p.lon - 0.25, p.lat - 0.25],
                    [p.lon + 0.25, p.lat - 0.25],
                    [p.lon + 0.25, p.lat + 0.25],
                    [p.lon - 0.25, p.lat + 0.25],
                    [p.lon - 0.25, p.lat - 0.25],
                ]],
            },
            properties: { anom: p.anom, date: latestDate },
        }));
        const geojson = { type: 'FeatureCollection', features };
        data = {
            geojson,
            timeline: [{ date: latestDate, isForecast: false, geojson }],
            latest: { date: latestDate },
            fonte: 'Grade sintetica ilustrativa (baseada no ONI) - configure OISST real',
            atualizadoEm: new Date().toISOString(),
            ilustrativo: true,
        };
    }

    sstCache = { updatedAt: now, data };
    return data;
}

/* ---------------------- Focos de Calor (INPE/FIRMS) ---------------------- */
async function buildFocosGeoJSON(opts) {
    opts = opts || {};
    const diasRaw = Number(opts.dias);
    const dias = Number.isFinite(diasRaw) ? Math.min(7, Math.max(1, Math.round(diasRaw))) : 3;
    const regiao = opts.regiao === 'brasil' ? 'brasil' : 'mt';
    const cacheKey = regiao + ':' + dias;
    const now = Date.now();
    const cached = focosCache[cacheKey];
    if (cached && now - cached.updatedAt < CACHE_TTL_FOCOS * 1000) {
        return { ...cached.data, _cached: true };
    }

    const bbox = regiao === 'brasil'
        ? '-74.0,-33.8,-34.8,5.3'
        : '-61.7,-18.1,-50.2,-7.3';

    let features = [];
    let fonte = 'NASA FIRMS (VIIRS SNPP NRT)';
    let erro = null;
    const updated = new Date().toISOString();

    const mapKey = (process.env.FIRMS_MAP_KEY || '').trim();
    if (!mapKey) {
        fonte = 'NASA FIRMS (MAP_KEY nao configurado)';
        erro = 'FIRMS_MAP_KEY ausente no servidor.';
    } else {
        const url = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/' + mapKey + '/VIIRS_SNPP_NRT/' + bbox + '/' + dias;
        try {
            const res = await fetchWithTimeout(url);
            const csv = await res.text();
            const linhas = csv.trim().split(/\r?\n/);
            if (linhas.length < 2) throw new Error('CSV vazio');
            const header = linhas[0].split(',').map(h => h.trim().toLowerCase());
            const idx = (name) => header.indexOf(name);
            const iLat = idx('latitude');
            const iLon = idx('longitude');
            const iDate = idx('acq_date');
            const iTime = idx('acq_time');
            const iSat = idx('satellite');
            const iConf = idx('confidence');
            const iFrp = idx('frp');
            for (let i = 1; i < linhas.length; i++) {
                const cols = linhas[i].split(',');
                if (cols.length < header.length) continue;
                const lat = parseFloat(cols[iLat]);
                const lon = parseFloat(cols[iLon]);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const acqDate = (cols[iDate] || '').trim();
                const acqTime = (cols[iTime] || '').trim().padStart(4, '0');
                const dataHora = acqDate ? (acqDate + 'T' + acqTime.slice(0,2) + ':' + acqTime.slice(2,4) + ':00') : new Date().toISOString();
                const frp = parseFloat(cols[iFrp]);
                const conf = (cols[iConf] || '').trim();
                const sat = (cols[iSat] || '').trim();
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                    properties: {
                        lat, lon,
                        frp: Number.isFinite(frp) ? frp : null,
                        satellite: sat || 'VIIRS SNPP',
                        data_hora: dataHora,
                        confianca: conf || null,
                    },
                });
            }
        } catch (e) {
            console.warn('[elnino-mapa] falha ao buscar focos FIRMS:', e.message);
            fonte = 'NASA FIRMS (falha: ' + e.message + ')';
            erro = e.message;
            features = [];
        }
    }

    const data = {
        geojson: { type: 'FeatureCollection', features },
        total: features.length,
        updated,
        fonte,
        atualizadoEm: updated,
        regiao,
        dias,
        erro: erro || undefined,
    };

    focosCache[cacheKey] = { updatedAt: now, data };
    return data;
}

/* ---------------------- Série Niño 3.4 (ONI) ---------------------- */
async function buildNino34Series() {
    const enso = require('../_lib/enso');
    const col = await enso.readCollection?.('system_config') || [];
    const doc = (Array.isArray(col) ? col : []).find(d => d && d.id === 'enso-indice');
    const lista = Array.isArray(doc?.lista) ? doc.lista : [];

    // Filtra só ONI e NINO34, ordena por data
    const series = lista
        .filter(a => a.indice === 'ONI' || a.indice === 'NINO34')
        .map(a => ({ data: a.observadoEm?.slice(0, 10), valor: a.valor, indice: a.indice, fonte: a.fonte }))
        .sort((a, b) => a.data.localeCompare(b.data));

    // Agrupa por data (média se houver ONI + NINO34 no mesmo mês)
    const grouped = {};
    for (const s of series) {
        if (!grouped[s.data]) grouped[s.data] = { soma: 0, n: 0 };
        grouped[s.data].soma += s.valor;
        grouped[s.data].n += 1;
    }
    const merged = Object.entries(grouped).map(([data, v]) => ({
        data,
        valor: Number((v.soma / v.n).toFixed(2)),
    })).sort((a, b) => a.data.localeCompare(b.data));

    return {
        series: merged.slice(-60), // últimos 60 meses
        fonte: 'NOAA/CPC (ONI + Niño 3.4) via coletor ENOS',
        atualizadoEm: new Date().toISOString(),
    };
}

module.exports = serve(async function handler(req) {
    const origin = req.headers.get?.('origin');
    if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

    const ru = reqUrl(req);
    const camada = ru?.searchParams?.get('camada') || 'sst';

    try {
        let data;
        let ttl = CACHE_TTL_SST;
        if (camada === 'sst') {
            data = await buildSSTGeoJSON();
        } else if (camada === 'focos') {
            data = await buildFocosGeoJSON({ dias: ru?.searchParams?.get('dias'), regiao: ru?.searchParams?.get('regiao') });
            ttl = CACHE_TTL_FOCOS;
        } else if (camada === 'nino34-series') {
            data = await buildNino34Series();
            ttl = 3600;
        } else {
            return jsonResponse(400, { erro: 'Camada inválida. Use: sst, focos ou nino34-series.' }, origin);
        }

        const res = jsonResponse(200, data, origin);
        Object.entries(cacheHeaders(ttl, ttl)).forEach(([k, v]) => res.headers.set(k, v));
        return res;
    } catch (e) {
        console.error('[elnino-mapa] erro:', e);
        return jsonResponse(502, { erro: 'Falha ao gerar camada do mapa.', detalhes: e.message }, origin);
    }
});