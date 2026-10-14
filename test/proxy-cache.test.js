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
  // DNS determinístico: hosts de teste resolvem para IP público.
  proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
  proxyHandler.limparSaudeCache();
  demoReset();
}

function restoreEnv(prev) {
  proxyHandler.definirResolvedor(null);
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
    restoreEnv(prev);
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
    restoreEnv(prev);
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
    restoreEnv(prev);
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
    restoreEnv(prev);
  }
});

test('SSRF: IPs literais/internos e localhost são 403 sem DNS', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  let chamadasDns = 0;
  try {
    setupEnv();
    process.env.PROXY_HOSTS = 'alvo.test';
    proxyHandler.definirResolvedor(async () => { chamadasDns += 1; return ['93.184.216.34']; });
    const alvos = [
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:3000/api/areas',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.20.10.4/x',
      'http://0.0.0.0/x',
      'http://2130706433/', // 127.0.0.1 em decimal
      'http://0x7f.0x0.0x0.0x1/', // 127.0.0.1 em hexa
      'http://[::1]/x',
    ];
    for (const alvo of alvos) {
      const res = await proxyHandler(request(alvo));
      assert.equal(res.status, 403, alvo);
      assert.ok((await res.json()).motivo);
    }
    assert.equal(chamadasDns, 0); // literais/nomes locais: sem DNS
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('SSRF: hostname que resolve p/ privado é 403; público passa', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    process.env.PROXY_HOSTS = 'interno.test,publico.test';
    proxyHandler.definirResolvedor(async (host) => {
      if (host === 'interno.test') return ['10.1.2.3'];
      if (host === 'publico.test') return ['93.184.216.34'];
      throw new Error('NXDOMAIN simulado');
    });
    global.fetch = () => Promise.resolve(new Response('ok', { status: 200 }));
    const ruim = await proxyHandler(request('https://interno.test/x'));
    assert.equal(ruim.status, 403);
    const bom = await proxyHandler(request('https://publico.test/x'));
    assert.equal(bom.status, 200);
    const semDns = await proxyHandler(request('https://nxdominio.test/x'));
    assert.equal(semDns.status, 403); // fail closed
  } finally {
    global.fetch = fetchOrig;
    await restore(snap);
    restoreEnv(prev);
  }
});

test('produção sem PROXY_HOSTS recusa com 503; raw documentado', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    process.env.NODE_ENV = 'production';
    process.env.PROXY_HOSTS = '';
    global.fetch = () => Promise.resolve(new Response('x', { status: 200 }));
    const r503 = await proxyHandler(request('https://example.test/x'));
    assert.equal(r503.status, 503);
    assert.ok((await r503.json()).erro.includes('PROXY_HOSTS'));
    process.env.PROXY_HOSTS = 'example.test';
    const comRaw = (alvo, raw) => new Request(
      `http://localhost/api/proxy?url=${encodeURIComponent(alvo)}&raw=${raw}`,
      { method: 'GET' }
    );
    const r1 = await proxyHandler(comRaw('https://example.test/x', '1'));
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('x-proxy-raw'), '1');
    const r0 = await proxyHandler(comRaw('https://example.test/x', '0'));
    assert.equal(r0.status, 200);
    assert.equal(r0.headers.get('x-proxy-raw'), '0');
  } finally {
    global.fetch = fetchOrig;
    await restore(snap);
    restoreEnv(prev);
  }
});
