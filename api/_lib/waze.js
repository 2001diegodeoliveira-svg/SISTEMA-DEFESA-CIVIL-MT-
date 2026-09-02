/* ============================================================
   Integração Waze — versão consolidada para as funções serverless
   do frontend (mesmo pipeline do backend/src/services/waze/*,
   porém num único arquivo, seguindo o estilo já usado em
   frontend/api/_lib/auth.js). NÃO inventa endpoints do Waze: só
   usa WAZE_FEED_URL quando configurada (credenciais oficiais).
   Sem configuração, usa MockWazeService para desenvolvimento.
   ============================================================ */
const { readCollection, writeCollection, push } = require('./store');

/* ---------- config ---------- */
function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}
function config() {
  return {
    enabled: bool(process.env.WAZE_ENABLED, false),
    mockEnabled: bool(process.env.WAZE_MOCK_ENABLED, true),
    feedUrl: process.env.WAZE_FEED_URL || '',
    apiKey: process.env.WAZE_API_KEY || '',
    pollingInterval: Number(process.env.WAZE_POLLING_INTERVAL) || 120000,
    fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || 10000,
  };
}

/* ---------- logger (histórico em memória) ---------- */
const MAX_HISTORY = 200;
const logHistory = [];
function log(level, event, message, metadata) {
  const entry = { timestamp: new Date().toISOString(), level, event, message: message || '', metadata: metadata || {} };
  logHistory.push(entry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
  const line = `[${entry.timestamp}] ${level.toUpperCase()} ${event} — ${entry.message}`;
  if (level === 'error') console.error(line, metadata || '');
  else if (level === 'warn') console.warn(line, metadata || '');
  else console.log(line, metadata || '');
  return entry;
}
const logger = {
  info: (e, m, d) => log('info', e, m, d),
  warn: (e, m, d) => log('warn', e, m, d),
  error: (e, m, d) => log('error', e, m, d),
  history: (limit = MAX_HISTORY) => logHistory.slice(-limit).reverse(),
};

/* ---------- validação ---------- */
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }
function extractCoords(raw) {
  if (raw.location && isFiniteNumber(raw.location.y) && isFiniteNumber(raw.location.x)) {
    return { lat: raw.location.y, lon: raw.location.x };
  }
  if (isFiniteNumber(raw.latitude) && isFiniteNumber(raw.longitude)) return { lat: raw.latitude, lon: raw.longitude };
  if (isFiniteNumber(raw.lat) && isFiniteNumber(raw.lon)) return { lat: raw.lat, lon: raw.lon };
  return null;
}
function validateRawOccurrence(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { valid: false, errors: ['item não é um objeto'], coords: null };
  if (!(raw.uuid || raw.id || raw.externalId)) errors.push('faltando id externo (uuid/id/externalId)');
  if (!(raw.type || raw.alertType)) errors.push('faltando tipo (type/alertType)');
  const coords = extractCoords(raw);
  if (!coords) errors.push('faltando coordenadas válidas');
  else {
    if (coords.lat < -90 || coords.lat > 90) errors.push('latitude fora do intervalo válido');
    if (coords.lon < -180 || coords.lon > 180) errors.push('longitude fora do intervalo válido');
  }
  return { valid: errors.length === 0, errors, coords };
}

/* ---------- normalização ---------- */
const TYPE_MAP = {
  ACCIDENT: 'ACIDENTE', JAM: 'ENGARRAFAMENTO', HAZARD: 'PERIGO', WEATHERHAZARD: 'CLIMA',
  ROAD_CLOSED: 'INTERDICAO', CONSTRUCTION: 'OBRA', POLICE: 'PERIGO',
};
function mapType(rawType) {
  if (!rawType) return 'OUTROS';
  return TYPE_MAP[String(rawType).toUpperCase()] || 'OUTROS';
}
function normalizeOccurrence(raw, { source = 'WAZE' } = {}) {
  const coords = extractCoords(raw);
  const now = Date.now();
  return {
    externalId: String(raw.uuid || raw.id || raw.externalId),
    source,
    type: mapType(raw.type || raw.alertType),
    subtype: raw.subtype || raw.subType || null,
    description: raw.description || raw.reportDescription || '',
    latitude: coords ? coords.lat : null,
    longitude: coords ? coords.lon : null,
    street: raw.street || null,
    city: raw.city || null,
    state: raw.state || null,
    country: raw.country || null,
    direction: raw.direction || raw.roadType || null,
    magnitude: typeof raw.magnitude === 'number' ? raw.magnitude : null,
    reliability: typeof raw.reliability === 'number' ? raw.reliability : null,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : null,
    reportedAt: raw.pubMillis || raw.reportedAt || now,
    receivedAt: now,
    updatedAt: now,
    status: 'NOVA',
    priority: null,
    rawData: raw,
  };
}

/* ---------- prioridade ---------- */
const PRIORITY = { CRITICA: 'CRITICA', ALTA: 'ALTA', MEDIA: 'MEDIA', BAIXA: 'BAIXA' };
const BASE_PRIORITY_BY_TYPE = {
  ACIDENTE: PRIORITY.ALTA, PERIGO: PRIORITY.ALTA, INTERDICAO: PRIORITY.ALTA,
  CLIMA: PRIORITY.MEDIA, OBRA: PRIORITY.MEDIA, ENGARRAFAMENTO: PRIORITY.BAIXA, OUTROS: PRIORITY.BAIXA,
};
function escalate(p) {
  if (p === PRIORITY.BAIXA) return PRIORITY.MEDIA;
  if (p === PRIORITY.MEDIA) return PRIORITY.ALTA;
  if (p === PRIORITY.ALTA) return PRIORITY.CRITICA;
  return p;
}
function classify(occurrence, context = {}) {
  let priority = BASE_PRIORITY_BY_TYPE[occurrence.type] || PRIORITY.BAIXA;
  if (occurrence.magnitude != null && occurrence.magnitude >= 8) priority = PRIORITY.CRITICA;
  else if (context.nearbyOccurrencesCount != null && context.nearbyOccurrencesCount >= 5) priority = escalate(priority);
  return priority;
}

/* ---------- mock ---------- */
const TYPES = ['ACCIDENT', 'JAM', 'HAZARD', 'WEATHERHAZARD', 'ROAD_CLOSED', 'CONSTRUCTION'];
const SUBTYPES = {
  ACCIDENT: ['ACCIDENT_MINOR', 'ACCIDENT_MAJOR'], JAM: ['JAM_MODERATE_TRAFFIC', 'JAM_HEAVY_TRAFFIC'],
  HAZARD: ['HAZARD_ON_ROAD', 'HAZARD_ON_SHOULDER'], WEATHERHAZARD: ['HAZARD_WEATHER_FLOOD', 'HAZARD_WEATHER_HEAVY_RAIN'],
  ROAD_CLOSED: ['ROAD_CLOSED_EVENT', 'ROAD_CLOSED_CONSTRUCTION'], CONSTRUCTION: ['CONSTRUCTION'],
};
const CITY_CENTERS = [
  { city: 'Cuiabá', lat: -15.6014, lon: -56.0979 }, { city: 'Várzea Grande', lat: -15.6467, lon: -56.1326 },
  { city: 'Rondonópolis', lat: -16.4706, lon: -54.6356 }, { city: 'Sinop', lat: -11.8642, lon: -55.5025 },
  { city: 'Tangará da Serra', lat: -14.6229, lon: -57.4931 },
];
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function jitter(v, spread = 0.06) { return v + (Math.random() - 0.5) * spread; }
let mockCounter = 0;
function generateMockAlert() {
  mockCounter += 1;
  const type = pick(TYPES);
  const center = pick(CITY_CENTERS);
  const label = type === 'ACCIDENT' ? 'Acidente' : type === 'JAM' ? 'Engarrafamento' : type === 'HAZARD' ? 'Perigo na via' : type === 'WEATHERHAZARD' ? 'Risco climático' : type === 'ROAD_CLOSED' ? 'Via interditada' : 'Obra na via';
  return {
    uuid: `MOCK-${String(mockCounter).padStart(3, '0')}-${Date.now()}`,
    type, subtype: pick(SUBTYPES[type]),
    description: `${label} reportado (dados simulados)`,
    location: { x: jitter(center.lon), y: jitter(center.lat) },
    city: center.city, state: 'MT', country: 'BR',
    reliability: Math.round(Math.random() * 10), confidence: Math.round(Math.random() * 10),
    pubMillis: Date.now(),
  };
}
function fetchMockAlerts() {
  const n = 3 + Math.floor(Math.random() * 6);
  return Array.from({ length: n }, generateMockAlert);
}

/* ---------- feed oficial (sem endpoints inventados) ---------- */
function parseFeedPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.alerts)) return payload.alerts;
  if (payload && Array.isArray(payload.data)) return payload.data;
  return [];
}
async function fetchOfficialAlerts() {
  const cfg = config();
  if (!cfg.feedUrl) throw new Error('WAZE_FEED_URL não configurada — integração aguardando credenciais oficiais.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs);
  try {
    const headers = {};
    if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    const res = await fetch(cfg.feedUrl, { headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) throw new Error(`Falha de autenticação no feed Waze (HTTP ${res.status}).`);
    if (!res.ok) throw new Error(`Feed Waze retornou HTTP ${res.status}.`);
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); } catch (e) { throw new Error('Resposta do feed Waze não é um JSON válido: ' + e.message); }
    return parseFeedPayload(payload);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout ao consultar o feed oficial do Waze.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------- estado + sync ---------- */
const state = { lastError: null, lastSyncAt: null, nextSyncAt: null, totalReceived: 0, lastSyncDurationMs: null, usingMock: true };

function computeStatus(cfg) {
  if (!cfg.enabled && !cfg.mockEnabled) return 'AGUARDANDO_CONFIGURACAO';
  if (state.lastError && !state.usingMock) return 'ERRO';
  return 'CONECTADO';
}

async function auditLog(action, metadata) {
  await push('audit_logs', { id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7), action, metadata, createdAt: Date.now() });
}

async function upsertOccurrence(occurrence) {
  const all = await readCollection('occurrences');
  const idx = all.findIndex((o) => o.source === occurrence.source && String(o.externalId) === String(occurrence.externalId));
  if (idx === -1) {
    const withId = { ...occurrence, id: `${occurrence.source}-${occurrence.externalId}` };
    all.push(withId);
    await writeCollection('occurrences', all);
    logger.info('WAZE_OCCURRENCE_CREATED', `Nova ocorrência ${withId.id}`);
    return { created: withId, updated: null };
  }
  const existing = all[idx];
  const merged = { ...existing, ...occurrence, id: existing.id, status: existing.status, receivedAt: existing.receivedAt, updatedAt: Date.now() };
  all[idx] = merged;
  await writeCollection('occurrences', all);
  logger.info('WAZE_OCCURRENCE_UPDATED', `Ocorrência atualizada ${merged.id}`);
  return { created: null, updated: merged };
}

async function runSyncCycle() {
  const cfg = config();
  const startedAt = Date.now();
  logger.info('WAZE_SYNC_STARTED', 'Iniciando ciclo de sincronização Waze', { usingMock: cfg.mockEnabled, enabled: cfg.enabled });

  if (!cfg.enabled && !cfg.mockEnabled) {
    return { ok: false, reason: 'Integração Waze aguardando configuração oficial.' };
  }

  let rawAlerts = [];
  try {
    if (cfg.enabled && !cfg.mockEnabled) {
      rawAlerts = await fetchOfficialAlerts();
      state.usingMock = false;
    } else {
      rawAlerts = fetchMockAlerts();
      state.usingMock = true;
    }
  } catch (e) {
    state.lastError = e.message;
    logger.error('WAZE_SYNC_ERROR', e.message);
    await auditLog('sincronizacao_erro', { message: e.message });
    return { ok: false, reason: e.message };
  }

  let created = 0, updated = 0, ignored = 0;
  for (const raw of rawAlerts) {
    const validation = validateRawOccurrence(raw);
    if (!validation.valid) {
      logger.warn('WAZE_INVALID_DATA', 'Item do feed ignorado', { errors: validation.errors });
      ignored += 1;
      continue;
    }
    const occurrence = normalizeOccurrence(raw, { source: 'WAZE' });
    occurrence.priority = classify(occurrence);
    const result = await upsertOccurrence(occurrence);
    if (result.created) created += 1; else updated += 1;
  }

  state.lastError = null;
  state.lastSyncAt = Date.now();
  state.nextSyncAt = Date.now() + cfg.pollingInterval;
  state.totalReceived += rawAlerts.length;
  state.lastSyncDurationMs = Date.now() - startedAt;

  await auditLog('sincronizacao', { created, updated, ignored, total: rawAlerts.length });
  logger.info('WAZE_SYNC_SUCCESS', `Ciclo concluído: ${created} criadas, ${updated} atualizadas, ${ignored} ignoradas`);
  return { ok: true, created, updated, ignored, total: rawAlerts.length };
}

function getStatus() {
  const cfg = config();
  return { ...state, status: computeStatus(cfg), enabled: cfg.enabled, mockEnabled: cfg.mockEnabled, pollingInterval: cfg.pollingInterval };
}

/* ---------- job (só usado pelo server.js standalone, não em serverless) ---------- */
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
  if (!cfg.enabled && !cfg.mockEnabled) {
    logger.info('WAZE_SYNC_JOB', 'Job não iniciado — integração desabilitada.');
    return;
  }
  logger.info('WAZE_SYNC_JOB', `Job iniciado — intervalo de ${cfg.pollingInterval}ms`);
  jobTick();
  jobTimer = setInterval(jobTick, cfg.pollingInterval);
}
function stopJob() {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = null;
}

module.exports = {
  config, logger, validateRawOccurrence, normalizeOccurrence, classify, PRIORITY,
  fetchMockAlerts, generateMockAlert, fetchOfficialAlerts, runSyncCycle, getStatus,
  upsertOccurrence, startJob, stopJob,
};
