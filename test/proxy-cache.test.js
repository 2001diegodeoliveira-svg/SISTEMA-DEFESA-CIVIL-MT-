/* ============================================================
   Testes do proxy com cache por fonte (Fase 1).
   TTL por fonte, headers de CDN, fallback "último válido" (X-Stale)
   e preservação dos erros 400/403/405/502. Sem rede: fetch global
   é substituído por stub em cada teste.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyHandler = require('../api/_routes/proxy');
const { origemPara, DEFAULT } = require('../api/_lib/origens');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

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
  process.env.PROXY_HOSTS = 'example.test,api.rainviewer.com';
  demoReset();
}

async function snapshot() {
  return { system: await readCollection('system_config') };
}
async function restore(snap) {
  await writeCollection('system_config', snap.system);
}
function request(target, method = 'GET') {
  return new Request(`http://localhost/api/proxy?url=${encodeURIComponent(target)}`, { method });
}

test('origemPara resolve TTL por host e default seguro', () => {
  const r = origemPara('api.rainviewer.com');
  assert.equal(r.id, 'rainviewer');
  assert.equal(r.ttlSeg, 300);
  const sub = origemPara('sub.dataserver-coids.inpe.br');
  assert.equal(sub.id, 'inpe-csv');
  const d = origemPara('desconhecido.example');
  assert.equal(d.id, DEFAULT.id);
  assert.ok(d.ttlSeg > 0);
});

test('sucesso devolve corpo + Cache-Control da fonte + métricas', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = () => Promise.resolve(
      new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const res = await proxyHandler(request('https://api.rainviewer.com/public/weather-maps.json'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"a":1}');
    assert.match(res.headers.get('cache-control'), /s-maxage=300/);
    assert.equal(res.headers.get('x-fonte'), 'rainviewer');
    assert.equal(res.headers.get('x-upstream-status'), '200');
    assert.ok(Number(res.headers.get('x-upstream-latency-ms')) >= 0);
    assert.equal(res.headers.get('x-stale'), null);
  } finally {
    global.fetch = fetchOrig;
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('origem fora do ar serve último válido com X-Stale', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = () => Promise.reject(new Error('origem caiu'));
    await writeCollection('system_config', [{
      id: 'proxy-fallback:example.test/dados',
      corpo: {
        status: 200, contentType: 'application/json',
        base64: Buffer.from('{"velho":true}').toString('base64'),
        salvoEm: new Date(Date.now() - 600000).toISOString(),
      },
      updatedAt: new Date().toISOString(),
    }]);
    const res = await proxyHandler(request('https://example.test/dados?x=1'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"velho":true}');
    assert.equal(res.headers.get('x-stale'), '1');
    assert.ok(Number(res.headers.get('x-stale-age-seg')) >= 590);
  } finally {
    global.fetch = fetchOrig;
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('sem fallback e com origem fora: 502 com JSON de erro', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = () => Promise.reject(new Error('origem caiu'));
    await writeCollection('system_config', []);
    const res = await proxyHandler(request('https://example.test/vazio'));
    assert.equal(res.status, 502);
    assert.ok((await res.json()).erro);
  } finally {
    global.fetch = fetchOrig;
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('host fora do allowlist: 403; método != GET: 405; sem ?url=: 400', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    setupEnv();
    const r403 = await proxyHandler(request('https://evil.example/x'));
    assert.equal(r403.status, 403);
    const r405 = await proxyHandler(request('https://example.test/x', 'POST'));
    assert.equal(r405.status, 405);
    const r400 = await proxyHandler(new Request('http://localhost/api/proxy', { method: 'GET' }));
    assert.equal(r400.status, 400);
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});
