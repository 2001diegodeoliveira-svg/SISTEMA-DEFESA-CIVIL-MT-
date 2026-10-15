/* ============================================================
   Testes do proxy IBGE (mock total — sem rede).
   ============================================================ */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const ibgeHandler = require('../api/_routes/ibge');
const proxyHandler = require('../api/_routes/proxy');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

const fetchOriginal = global.fetch;

afterEach(() => {
  global.fetch = fetchOriginal;
  proxyHandler.definirTransporte(null);
  demoReset();
});

const ENV_KEYS = [
  'VERCEL', 'VERCEL_ENV', 'NODE_ENV', 'FILE_STORE', 'DATABASE_URL',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'PROXY_HOSTS',
];

function setupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.NODE_ENV = 'test';
  process.env.FILE_STORE = '0';
  process.env.PROXY_HOSTS = 'servicodados.ibge.gov.br,brasilapi.com.br';
  demoReset();
}

function restoreEnv(prev) {
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  demoReset();
}

async function snapshot() {
  return { system: await readCollection('system_config') };
}
async function restore(snap) {
  await writeCollection('system_config', snap.system);
}

function respostaUpstream(corpo, { status = 200, contentType = 'application/json', location = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (nome) => {
        const chave = String(nome || '').toLowerCase();
        if (chave === 'content-type') return contentType;
        if (chave === 'location') return location;
        return null;
      },
    },
    body: Buffer.from(corpo),
  };
}

function transporteSimulado(rotas) {
  const chamadas = [];
  const fn = async ({ parsed }) => {
    chamadas.push(parsed.hostname + parsed.pathname);
    const rota = rotas[parsed.pathname] || rotas.default;
    if (!rota) throw new Error('rota não mockada: ' + parsed.pathname);
    if (rota.erro) throw rota.erro;
    return respostaUpstream(rota.corpo || '', rota);
  };
  fn.chamadas = chamadas;
  return fn;
}

test('GET /api/ibge/estados retorna lista', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(transporteSimulado({
      '/api/v1/localidades/estados': { corpo: '[{"id":51,"sigla":"MT","nome":"Mato Grosso"}]', contentType: 'application/json' },
      default: { erro: new Error('rota não mockada') },
    }));
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/estados', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j));
    assert.equal(j[0].sigla, 'MT');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('GET /api/ibge/municipios?uf=51 retorna municípios', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(transporteSimulado({
      '/api/v1/localidades/estados/51/municipios': { corpo: '[{"id":5103402,"nome":"Cuiabá"}]', contentType: 'application/json' },
      default: { erro: new Error('rota não mockada') },
    }));
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/municipios?uf=51', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j));
    assert.equal(j[0].nome, 'Cuiabá');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('GET /api/ibge/municipios sem uf retorna 400', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/municipios', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.ok(j.erro);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('GET /api/ibge/malhas/estados retorna GeoJSON', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(transporteSimulado({
      '/api/ibge/malhas/estados': { corpo: '{"type":"FeatureCollection","features":[]}', contentType: 'application/vnd.geo+json' },
      default: { erro: new Error('rota não mockada') },
    }));
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/malhas/estados', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.type, 'FeatureCollection');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('GET /api/ibge/malhas/estados/51 retorna GeoJSON da UF', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(transporteSimulado({
      '/api/ibge/malhas/estados/51': { corpo: '{"type":"FeatureCollection","features":[]}', contentType: 'application/vnd.geo+json' },
      default: { erro: new Error('rota não mockada') },
    }));
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/malhas/estados/51', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.type, 'FeatureCollection');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('GET /api/ibge/malhas/estados/XX inválida retorna 400', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/malhas/estados/99', { method: 'GET' });
    const res = await mod(req);
    assert.equal(res.status, 400);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('OPTIONS retorna 204', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/estados', { method: 'OPTIONS' });
    const res = await mod(req);
    assert.equal(res.status, 204);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('POST retorna 405', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    const mod = require('../api/_routes/ibge');
    const req = new Request('http://localhost/api/ibge/estados', { method: 'POST' });
    const res = await mod(req);
    assert.equal(res.status, 405);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});