/* ============================================================
   Testes da saúde das fontes (Fase 2).
   GET /api/fontes/saude, regra de estado ok/lento/fora e o hook
   do proxy que registra sucesso/falha (com throttle). Sem rede.
   ============================================================ */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const proxyHandler = require('../api/_routes/proxy');
const fontesHandler = require('../api/_routes/fontes');
const { estadoFonte } = require('../api/_routes/fontes');
const { FONTES } = require('../api/_lib/origens');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

const fetchOriginal = global.fetch;

/* FIX-01: rede de segurança — nenhum stub vaza entre testes. */
afterEach(() => {
  global.fetch = fetchOriginal;
  proxyHandler.definirResolvedor(null);
  proxyHandler.definirTransporte(null);
  proxyHandler.definirProcurarDns(null);
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
  process.env.PROXY_HOSTS = 'example.test';
  // DNS determinístico (o proxy agora valida SSRF antes do fetch).
  proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
  proxyHandler.limparSaudeCache();
  demoReset();
}

function restoreEnv(prev) {
  proxyHandler.definirResolvedor(null);
  proxyHandler.definirTransporte(null);
  proxyHandler.definirProcurarDns(null);
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  demoReset();
}

function respostaUpstream(corpo, contentType = 'text/plain') {
  return {
    status: 200,
    ok: true,
    headers: { get: (nome) => (String(nome || '').toLowerCase() === 'content-type' ? contentType : null) },
    body: Buffer.from(corpo),
  };
}

async function snapshot() {
  return { system: await readCollection('system_config') };
}
async function restore(snap) {
  await writeCollection('system_config', snap.system);
}
function request(target) {
  return new Request(`http://localhost/api/proxy?url=${encodeURIComponent(target)}`);
}
function get(path) {
  return new Request(`http://localhost/api/${path}`, { method: 'GET' });
}

test('estadoFonte: ok/lento/fora por idade e falha', () => {
  const cfg = { ttlSeg: 600, timeoutMs: 10000 };
  const agora = Date.now();
  assert.equal(estadoFonte(cfg, {}), 'fora');
  assert.equal(estadoFonte(cfg, { ultimoSucesso: new Date(agora - 60000).toISOString() }), 'ok');
  assert.equal(
    estadoFonte(cfg, { ultimoSucesso: new Date(agora - 60000).toISOString(), latenciaMs: 9500 }),
    'lento'
  );
  assert.equal(estadoFonte(cfg, { ultimoSucesso: new Date(agora - 3600000).toISOString() }), 'lento');
  assert.equal(estadoFonte(cfg, { ultimoSucesso: new Date(agora - 6 * 3600000).toISOString() }), 'fora');
  assert.equal(estadoFonte(cfg, {
    ultimoSucesso: new Date(agora - 3600000).toISOString(),
    ultimaFalha: new Date(agora - 60000).toISOString(),
  }), 'fora');
});

test('GET /api/fontes/saude lista o registro com estado inicial fora', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    const res = await fontesHandler(get('fontes/saude'));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.fontes.length, FONTES.length);
    assert.ok(j.fontes.every((f) => f.estado === 'fora'));
    assert.ok(j.atualizadoEm);
    const rain = j.fontes.find((f) => f.id === 'rainviewer');
    assert.deepEqual(rain.hosts, ['api.rainviewer.com']);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('proxy registra sucesso e falha na saúde da fonte', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    proxyHandler.definirTransporte(async () => respostaUpstream('ok'));
    const r1 = await proxyHandler(request('https://example.test/a'));
    assert.equal(r1.status, 200);
    let col = await readCollection('system_config');
    let doc = col.find((d) => d.id === 'fonte-saude');
    assert.ok(doc.fontes.default.ultimoSucesso);
    assert.equal(doc.fontes.default.ultimaFalha, undefined);

    proxyHandler.definirTransporte(async () => { throw new Error('caiu'); });
    // com fallback guardado do sucesso acima: serve stale + registra falha
    const r2 = await proxyHandler(request('https://example.test/a'));
    assert.equal(r2.status, 200);
    assert.equal(r2.headers.get('x-stale'), '1');
    col = await readCollection('system_config');
    doc = col.find((d) => d.id === 'fonte-saude');
    assert.ok(doc.fontes.default.ultimaFalha);
    // sem fallback guardado: 502 com JSON
    const r3 = await proxyHandler(request('https://example.test/outro'));
    assert.equal(r3.status, 502);
    assert.ok((await r3.json()).erro);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('POST /api/fontes/vigilancia audita host que resolve p/ privado', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    const vigilancia = require('../api/_routes/fontes-vigilancia');
    const post = () => vigilancia(new Request('http://localhost/api/fontes/vigilancia', { method: 'POST' }));
    proxyHandler.definirResolvedor(async (host) => (
      host === 'ruim.test' ? ['10.9.9.9'] : ['93.184.216.34']
    ));
    process.env.PROXY_HOSTS = 'ruim.test,bom.test';
    const r1 = await post();
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.ok(j1.verificados > 0);
    const achado = j1.achados.find((a) => a.host === 'ruim.test');
    assert.ok(achado && !achado.recuperado);
    const logs = await readCollection('audit_logs');
    assert.ok(logs.some((l) => l.action === 'fonte.vigilancia' && l.metadata.host === 'ruim.test'));
    // segunda rodada com tudo público: registra recuperação, sem novo alarme
    proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
    const j2 = await (await post()).json();
    const rec = j2.achados.find((a) => a.host === 'ruim.test');
    assert.ok(rec && rec.recuperado === true);
    const logs2 = await readCollection('audit_logs');
    assert.equal(logs2.filter((l) => l.action === 'fonte.vigilancia').length, 1);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('vigilancia exige secret quando configurado; GET serve o cron', async () => {
  const prev = new Map([...ENV_KEYS, 'VIGILANCIA_SECRET'].map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    const vigilancia = require('../api/_routes/fontes-vigilancia');
    process.env.VIGILANCIA_SECRET = 'segredo-do-cron-com-20+';
    const semCred = await vigilancia(new Request('http://localhost/api/fontes/vigilancia', { method: 'POST' }));
    assert.equal(semCred.status, 401);
    const errada = await vigilancia(new Request('http://localhost/api/fontes/vigilancia?secret=errada', { method: 'POST' }));
    assert.equal(errada.status, 401);
    const comQuery = await vigilancia(new Request('http://localhost/api/fontes/vigilancia?secret=segredo-do-cron-com-20%2B', { method: 'GET' }));
    assert.equal(comQuery.status, 200);
    assert.ok((await comQuery.json()).verificados >= 0);
    const comBearer = await vigilancia(new Request('http://localhost/api/fontes/vigilancia', {
      method: 'POST',
      headers: { authorization: 'Bearer segredo-do-cron-com-20+' },
    }));
    assert.equal(comBearer.status, 200);
    delete process.env.VIGILANCIA_SECRET;
    const aberto = await vigilancia(new Request('http://localhost/api/fontes/vigilancia', { method: 'GET' }));
    assert.equal(aberto.status, 200);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});
