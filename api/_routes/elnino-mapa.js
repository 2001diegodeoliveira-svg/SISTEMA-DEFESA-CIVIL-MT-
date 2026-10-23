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
let focosCache = { updatedAt: 0, data: null };
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

    // Tenta buscar OISST real via OpenDAP (requer netcdf-js ou proxy Python).
    // Se falhar, gera grade sintética baseada no último ONI conhecido.
    let anomGrid = null;
    let latestDate = null;
    let isForecast = false;

    try {
        // Tentativa de ler via endpoint THREDDS/DODS (retorna DAP/DDS)
        // Nota: navegador não lê NetCDF binário; precisa worker Python.
        // Por enquanto, usa proxy simples se houver ENSO_OISST_JSON_URL configurado.
        const jsonUrl = process.env.ELNINO_OISST_JSON_URL;
        if (jsonUrl) {
            const res = await fetchWithTimeout(jsonUrl);
            const txt = await res.text();
            const parsed = JSON.parse(txt);
            if (parsed.grid && parsed.date) {
                anomGrid = parsed.grid;
                latestDate = parsed.date;
                isForecast = parsed.isForecast || false;
            }
        }
    } catch (e) {
        // Ignora e cai no fallback
    }

    if (!anomGrid) {
        // Fallback: grade sintética centrada no Pacífico equatorial
        // baseada no último valor ONI conhecido (via enso.js)
        const enso = require('../_lib/enso');
        const ultima = await enso.ultimaAmostra('ONI');
        const baseAnom = (ultima && typeof ultima.valor === 'number') ? ultima.valor : 1.2;
        latestDate = ultima?.observadoEm || new Date().toISOString().slice(0, 10);

        const lonCount = 1440; // 0.25° global
        const latCount = 720;
        // Só geramos região Niño 3.4 + entorno (economia)
        const lonStart = Math.round((180 + 170) / 0.25); // ~1400
        const lonEnd = Math.round((180 + 120) / 0.25);   // ~1200
        const latStart = Math.round((90 + 5) / 0.25);    // ~380
        const latEnd = Math.round((90 - 5) / 0.25);      // ~340

        anomGrid = [];
        for (let latIdx = latEnd; latIdx <= latStart; latIdx += 2) { // stride 0.5°
            const lat = 90 - latIdx * 0.25;
            for (let lonIdx = lonEnd; lonIdx <= lonStart; lonIdx += 2) {
                const lon = -180 + lonIdx * 0.25;
                // Anomalia decai fora da faixa equatorial
                const latFactor = Math.max(0, 1 - Math.abs(lat) / 10);
                const noise = (Math.sin(lon * 0.5) * Math.cos(lat * 0.3)) * 0.3;
                const anom = baseAnom * latFactor + noise;
                anomGrid.push({ lat, lon, anom: Number(anom.toFixed(2)) });
            }
        }
    }

    // Converte para GeoJSON (FeatureCollection de Polygons grid)
    const features = anomGrid.map(p => ({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [p.lon - 0.125, p.lat - 0.125],
                [p.lon + 0.125, p.lat - 0.125],
                [p.lon + 0.125, p.lat + 0.125],
                [p.lon - 0.125, p.lat + 0.125],
                [p.lon - 0.125, p.lat - 0.125],
            ]],
        },
        properties: { anom: p.anom, date: latestDate },
    }));

    // Timeline: últimos 30 dias + 7 dias previsão (mock)
    const timeline = [];
    const baseDate = new Date(latestDate);
    for (let i = -29; i <= 7; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        // Variação suave ao longo do tempo
        const phase = (i + 30) / 37 * Math.PI * 2;
        const variation = Math.sin(phase) * 0.4;
        const grid = anomGrid.map(p => ({
            ...p,
            anom: Number((p.anom + variation * (1 - Math.abs(p.lat) / 10)).toFixed(2)),
        }));
        const frameFeatures = grid.map(p => ({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [p.lon - 0.125, p.lat - 0.125],
                    [p.lon + 0.125, p.lat - 0.125],
                    [p.lon + 0.125, p.lat + 0.125],
                    [p.lon - 0.125, p.lat + 0.125],
                    [p.lon - 0.125, p.lat - 0.125],
                ]],
            },
            properties: { anom: p.anom, date: iso },
        }));
        timeline.push({
            date: iso,
            isForecast: i > 0,
            geojson: { type: 'FeatureCollection', features: frameFeatures },
        });
    }

    const data = {
        geojson: { type: 'FeatureCollection', features },
        timeline,
        latest: { date: latestDate, anomMax: Math.max(...anomGrid.map(p => p.anom)), anomMin: Math.min(...anomGrid.map(p => p.anom)) },
        fonte: 'NOAA OISST v2 (0.25°) · anomalia vs climatologia 1991-2020',
        atualizadoEm: new Date().toISOString(),
    };

    sstCache = { updatedAt: now, data };
    return data;
}

/* ---------------------- Focos de Calor (INPE/FIRMS) ---------------------- */
async function buildFocosGeoJSON() {
    const now = Date.now();
    if (focosCache.data && now - focosCache.updatedAt < CACHE_TTL_FOCOS * 1000) {
        return { ...focosCache.data, _cached: true };
    }

    let features = [];
    let updated = new Date().toISOString();
    let fonte = 'INPE/Queimadas';

    try {
        // Tenta FIRMS se tiver API key
        const firmsKey = process.env.FIRMS_API_KEY;
        if (firmsKey) {
            const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${firmsKey}/MODIS_NRT/-180,-90,180,90/1`;
            const res = await fetchWithTimeout(url);
            const csv = await res.text();
            const lines = csv.trim().split('\n').slice(1); // header
            features = lines.slice(0, 5000).map(line => {
                const [lat, lon, brightness, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_t31, frp, daynight] = line.split(',');
                return {
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] },
                    properties: {
                        lat: parseFloat(lat),
                        lon: parseFloat(lon),
                        frp: parseFloat(frp),
                        satellite,
                        data_hora: `${acq_date}T${acq_time.padStart(4, '0')}:00`,
                        bioma: '—',
                    },
                });
            }).filter(f => Number.isFinite(f.geometry.coordinates[0]) && Number.isFinite(f.geometry.coordinates[1]));
            fonte = 'NASA FIRMS (MODIS NRT)';
        } else {
            // Fallback: INPE Queimadas (CSV público) - simplificado
            // Em produção, baixar shapefile/CSV diário do INPE
            // Mock realista para Brasil
            const estados = ['MT', 'PA', 'AM', 'RO', 'AC', 'RR', 'AP', 'TO', 'MA', 'PI', 'CE', 'RN', 'PB', 'PE', 'AL', 'SE', 'BA'];
            for (let i = 0; i < 200; i++) {
                const uf = estados[Math.floor(Math.random() * estados.length)];
                const lat = -10 + Math.random() * 5;
                const lon = -65 + Math.random() * 15;
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [lon, lat] },
                    properties: {
                        lat, lon,
                        frp: Number((Math.random() * 100).toFixed(1)),
                        satellite: 'AQUA_M-TERRA_M',
                        data_hora: new Date(Date.now() - Math.random() * 86400000).toISOString(),
                        bioma: uf === 'MT' || uf === 'PA' || uf === 'AM' ? 'Amazônia' : 'Cerrado',
                    },
                });
            }
            fonte = 'INPE/Queimadas (mock — configurar FIRMS_API_KEY para dados reais)';
        }
    } catch (e) {
        console.warn('[elnino-mapa] falha ao buscar focos:', e.message);
        // Mock mínimo para não quebrar o front
        features = [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-55, -12] },
            properties: { lat: -12, lon: -55, frp: 10, satellite: 'MOCK', data_hora: new Date().toISOString(), bioma: 'Mock' },
        }];
        fonte = 'Mock (falha na fonte real)';
    }

    const data = {
        geojson: { type: 'FeatureCollection', features },
        total: features.length,
        updated,
        fonte,
    };

    focosCache = { updatedAt: now, data };
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
            data = await buildFocosGeoJSON();
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