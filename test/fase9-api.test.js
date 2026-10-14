/* ============================================================
   Testes mínimos da Fase 9: endpoints /api sem cobertura
   (pluv-alerta, alertas, areas) + avaliar do pluviômetro.
   Sem rede: fetch com stub.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const apiHandler = require('../api/index');
const pluv = require('../api/_lib/pluvialerta');
const { demoReset } = require('../api/_lib/demo');
const { readCollection, writeCollection } = require('../api/_lib/store');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV',
  'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'SEED_USERS',
];

function setupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.VERCEL_ENV = 'preview';
  demoReset();
}
function restoreEnv(prev) {
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  demoReset();
}
function get(path) {
  return new Request(`http://localhost/api/${path}`, { method: 'GET' });
}

test('pluv-alerta GET devolve config default; avaliar aplica limiar', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    setupEnv();
    const r = await apiHandler(get('pluv-alerta'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.limiteMm, 100);
    assert.equal(j.metrica, 'c24');
    assert.ok(j.limiarMm > 0);
    const cfg = { limiteMm: 100, percentual: 30 };
    const ok = pluv.avaliar([{ codigo: 'A', c24: 50 }], cfg);
    assert.equal(ok.totalAcima, 1);
    assert.equal(ok.estacoes[0].acima, true);
    const abaixo = pluv.avaliar([{ codigo: 'A', c24: 5 }], cfg);
    assert.equal(abaixo.totalAcima, 0);
    assert.equal(abaixo.estacoes[0].acima, false);
  } finally {
    restoreEnv(prev);
  }
});

test('alertas GET combina curados + INMET ao vivo (mockado)', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = () => Promise.resolve(new Response(
      '<rss><channel><item><guid>9</guid><description><![CDATA[<table>'
      + '<tr><th>Evento</th><td>Tempestade</td></tr>'
      + '<tr><th>Severidade</th><td>Perigo</td></tr>'
      + '<tr><th>Área</th><td>Norte Mato-grossense</td></tr>'
      + '<tr><th>Fim</th><td>2099-01-01 00:00:00.0</td></tr>'
      + '</table>]]></description></item></channel></rss>',
      { status: 200, headers: { 'content-type': 'application/rss+xml' } }
    ));
    const r = await apiHandler(get('alertas'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.alertas));
    assert.ok(Array.isArray(j.inmet));
    assert.ok(j.inmet.some((a) => a.fonte === 'inmet' && a.evento === 'Tempestade'));
    const sem = await apiHandler(get('alertas?inmet=0'));
    assert.equal(sem.status, 200);
    assert.deepEqual((await sem.json()).inmet, []);
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
});

test('areas GET público vazio; POST exige login', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    setupEnv();
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    const r = await apiHandler(get('areas'));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).areas ?? (await r.json()).lista ?? []));
    const post = await apiHandler(new Request('http://localhost/api/areas', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ nome: 'X' }),
    }));
    assert.ok([401, 403].includes(post.status));
  } finally {
    restoreEnv(prev);
  }
});
