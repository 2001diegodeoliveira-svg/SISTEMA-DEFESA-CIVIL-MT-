/* ============================================================
   Integração TomTom Traffic API (API aberta/self-service, alternativa
   ao Waze CCP — ver docs/WAZE_INTEGRATION.md) para as funções
   serverless do frontend. Reaproveita upsertOccurrence/classify/logger
   de ./waze (agnósticos de fonte).
   ============================================================ */
const wazeLib = require('./waze');
const { push } = require('./store');

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}
function config() {
  return {
    enabled: bool(process.env.TOMTOM_ENABLED, false),
    mockEnabled: bool(process.env.TOMTOM_MOCK_ENABLED, true),
    apiKey: process.env.TOMTOM_API_KEY || '',
    bbox: process.env.TOMTOM_BBOX || '-61.6,-18.0,-50.2,-7.3',
    pollingInterval: Number(process.env.TOMTOM_POLLING_INTERVAL) || 120000,
    fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || 10000,
  };
}

const ICON_CATEGORY_MAP = {
  accident: 'ACIDENTE', jam: 'ENGARRAFAMENTO', roadClosed: 'INTERDICAO', laneClosed: 'INTERDICAO',
  roadWorks: 'OBRA', flooding: 'CLIMA', rain: 'CLIMA', ice: 'CLIMA', fog: 'CLIMA', wind: 'CLIMA',
  dangerousConditions: 'PERIGO', brokenDownVehicle: 'PERIGO', unknown: 'OUTROS',
};
function firstPoint(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const coords = geometry.type === 'Point' ? geometry.coordinates : geometry.coordinates[0];
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return { lon: coords[0], lat: coords[1] };
}
function normalizeTomTomIncident(raw) {
  const props = raw.properties || {};
  const point = firstPoint(raw.geometry);
  const now = Date.now();
  const description = (props.events || []).map((e) => e.description).filter(Boolean).join('; ') || 'Incidente de trânsito (TomTom)';
  return {
    externalId: String(props.id || `${point ? point.lat + ',' + point.lon : 'sem-coord'}-${props.startTime || now}`),
    source: 'TOMTOM',
    type: ICON_CATEGORY_MAP[props.iconCategory] || 'OUTROS',
    subtype: props.iconCategory || null,
    description,
    latitude: point ? point.lat : null,
    longitude: point ? point.lon : null,
    street: props.from || null, city: null, state: 'MT', country: 'BR',
    direction: props.to ? `até ${props.to}` : null,
    magnitude: { minor: 2, moderate: 5, major: 8, undefined: 6, unknown: 0 }[props.magnitudeOfDelay] ?? null,
    reliability: null,
    confidence: props.probabilityOfOccurrence === 'certain' ? 10 : props.probabilityOfOccurrence === 'probable' ? 7 : 4,
    reportedAt: props.startTime ? Date.parse(props.startTime) : now,
    receivedAt: now, updatedAt: now, status: 'NOVA', priority: null, rawData: raw,
  };
}

/* ---------- mock ---------- */
const CATEGORIES = ['accident', 'jam', 'roadClosed', 'roadWorks', 'flooding', 'dangerousConditions', 'brokenDownVehicle'];
const CITY_CENTERS = [
  { lat: -15.6014, lon: -56.0979 }, { lat: -15.6467, lon: -56.1326 },
  { lat: -16.4706, lon: -54.6356 }, { lat: -11.8642, lon: -55.5025 }, { lat: -14.6229, lon: -57.4931 },
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(v, spread = 0.08) { return v + (Math.random() - 0.5) * spread; }
let counter = 0;
function generateMockIncident() {
  counter += 1;
  const category = pick(CATEGORIES);
  const center = pick(CITY_CENTERS);
  return {
    type: 'Feature',
    properties: {
      id: `TOMTOM-MOCK-${String(counter).padStart(3, '0')}-${Date.now()}`,
      iconCategory: category,
      magnitudeOfDelay: pick(['minor', 'moderate', 'major']),
      events: [{ description: `${category} reportado (dados simulados)`, code: 0, iconCategory: category }],
      startTime: new Date().toISOString(),
      probabilityOfOccurrence: pick(['certain', 'probable']),
    },
    geometry: { type: 'Point', coordinates: [jitter(center.lon), jitter(center.lat)] },
  };
}
function fetchMockIncidents() {
  const n = 2 + Math.floor(Math.random() * 5);
  return Array.from({ length: n }, generateMockIncident);
}

/* ---------- feed oficial (endpoint documentado, sem invenção) ---------- */
const BASE_URL = 'https://api.tomtom.com/maps/orbis/traffic/incidents/details';
async function fetchOfficialIncidents() {
  const cfg = config();
  if (!cfg.apiKey) throw new Error('TOMTOM_API_KEY não configurada — cadastre-se gratuitamente em developer.tomtom.com.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
  try {
    const url = `${BASE_URL}?apiVersion=2&bbox=${encodeURIComponent(cfg.bbox)}&timeValidity=present`;
    const res = await fetch(url, {
      headers: {
        'TomTom-Api-Key': cfg.apiKey,
        Attributes: 'incidents(type,geometry(type,coordinates),properties(id,iconCategory,magnitudeOfDelay,events,from,to,startTime,probabilityOfOccurrence))',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error(`Falha de autenticação na TomTom Traffic API (HTTP ${res.status}).`);
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`TomTom Traffic API retornou HTTP ${res.status}.`);
    const json = await res.json();
    return Array.isArray(json.incidents) ? json.incidents : [];
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout ao consultar a TomTom Traffic API.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- estado + sync (reaproveita upsertOccurrence/classify de ./waze) ---------- */
const state = { lastError: null, lastSyncAt: null, nextSyncAt: null, totalReceived: 0, lastSyncDurationMs: null, usingMock: true };
function computeStatus(cfg) {
  if (!cfg.enabled && !cfg.mockEnabled) return 'AGUARDANDO_CONFIGURACAO';
  if (state.lastError && !state.usingMock) return 'ERRO';
  return 'CONECTADO';
}
async function auditLog(action, metadata) {
  await push('audit_logs', { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7), action, metadata, createdAt: Date.now() });
}
async function runSyncCycle() {
  const cfg = config();
  const startedAt = Date.now();
  wazeLib.logger.info('TOMTOM_SYNC_STARTED', 'Iniciando ciclo de sincronização TomTom', { usingMock: cfg.mockEnabled, enabled: cfg.enabled });

  if (!cfg.enabled && !cfg.mockEnabled) return { ok: false, reason: 'Integração TomTom aguardando configuração (TOMTOM_API_KEY).' };

  let rawIncidents = [];
  try {
    if (cfg.enabled && !cfg.mockEnabled) { rawIncidents = await fetchOfficialIncidents(); state.usingMock = false; }
    else { rawIncidents = fetchMockIncidents(); state.usingMock = true; }
  } catch (e) {
    state.lastError = e.message;
    wazeLib.logger.error('TOMTOM_SYNC_ERROR', e.message);
    await auditLog('tomtom_sincronizacao_erro', { message: e.message });
    return { ok: false, reason: e.message };
  }

  let created = 0, updated = 0;
  for (const raw of rawIncidents) {
    const occurrence = normalizeTomTomIncident(raw);
    if (occurrence.latitude == null || occurrence.longitude == null) continue;
    occurrence.priority = wazeLib.classify(occurrence);
    const result = await wazeLib.upsertOccurrence(occurrence);
    if (result.created) created += 1; else updated += 1;
  }

  state.lastError = null;
  state.lastSyncAt = Date.now();
  state.nextSyncAt = Date.now() + cfg.pollingInterval;
  state.totalReceived += rawIncidents.length;
  state.lastSyncDurationMs = Date.now() - startedAt;
  await auditLog('tomtom_sincronizacao', { created, updated, total: rawIncidents.length });
  wazeLib.logger.info('TOMTOM_SYNC_SUCCESS', `Ciclo concluído: ${created} criadas, ${updated} atualizadas`);
  return { ok: true, created, updated, total: rawIncidents.length };
}
function getStatus() {
  const cfg = config();
  return { ...state, status: computeStatus(cfg), enabled: cfg.enabled, mockEnabled: cfg.mockEnabled, pollingInterval: cfg.pollingInterval };
}

/* ---------- job (só server.js standalone) ---------- */
let jobTimer = null;
let jobRunning = false;
async function jobTick() {
  if (jobRunning) return;
  jobRunning = true;
  try { await runSyncCycle(); } finally { jobRunning = false; }
}
function startJob() {
  if (jobTimer) return;
  const cfg = config();
  if (!cfg.enabled && !cfg.mockEnabled) { wazeLib.logger.info('TOMTOM_SYNC_JOB', 'Job não iniciado — integração desabilitada.'); return; }
  wazeLib.logger.info('TOMTOM_SYNC_JOB', `Job iniciado — intervalo de ${cfg.pollingInterval}ms`);
  jobTick();
  jobTimer = setInterval(jobTick, cfg.pollingInterval);
}
function stopJob() { if (jobTimer) clearInterval(jobTimer); jobTimer = null; }

module.exports = { config, normalizeTomTomIncident, fetchMockIncidents, generateMockIncident, fetchOfficialIncidents, runSyncCycle, getStatus, startJob, stopJob };
