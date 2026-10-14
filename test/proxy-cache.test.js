/* ============================================================
   Testes do proxy com cache por fonte (Fase 1).
   TTL por fonte, headers de CDN, fallback "último válido" (X-Stale)
   e preservação dos erros 400/403/405/502. Sem rede: transporte
   e DNS são substituídos por stubs em cada teste.
   ============================================================ */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const proxyHandler = require('../api/_routes/proxy');
const { origemPara, DEFAULT } = require('../api/_lib/origens');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

const fetchOriginal = global.fetch;

/* FIX-01: rede de segurança — mesmo que um teste falhe antes do
   finally, nenhum stub vaza para o teste seguinte. */
afterEach(() => {
  global.fetch = fetchOriginal;
  proxyHandler.definirResolvedor(null);
  proxyHandler.definirTransporte(null);
  proxyHandler.definirProcurarDns(null);
  proxyHandler.limparSaudeCache();
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
  process.env.PROXY_HOSTS = 'example.test,api.rainviewer.com';
  // DNS determinístico: hosts de teste resolvem para IP público,
  // na pré-checagem e no pin da conexão.
  proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
  proxyHandler.definirProcurarDns(async () => ({ address: '93.184.216.34', family: 4 }));
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

/* Resposta fake no formato do transporte nativo
   ({ status, ok, headers: { get }, body: Buffer }). */
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

/* Transporte fake que SIMULA a resolução do momento da conexão:
   chama `lookup` antes de responder — é assim que o teste de
   rebinding prova que a conexão é abortada. */
function transporteSimulado(rotas) {
  const chamadas = [];
  const fn = async ({ parsed, lookup }) => {
    await new Promise((resolve, reject) => {
      lookup(parsed.hostname, {}, (erro) => (erro ? reject(erro) : resolve()));
    });
    // Só conta como transferência o que passou pelo lookup (abort não conta).
    chamadas.push(parsed.hostname + parsed.pathname);
    const rota = rotas[parsed.pathname] || rotas.default;
    if (!rota) throw new Error('rota não mockada: ' + parsed.pathname);
    if (rota.erro) throw rota.erro;
    return respostaUpstream(rota.corpo || '', rota);
  };
  fn.chamadas = chamadas;
  return fn;
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
  try {
    setupEnv();
    proxyHandler.definirTransporte(async () => respostaUpstream('{"a":1}'));
    const res = await proxyHandler(request('https://api.rainviewer.com/public/weather-maps.json'));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"a":1}');
    assert.match(res.headers.get('cache-control'), /s-maxage=300/);
    assert.equal(res.headers.get('x-fonte'), 'rainviewer');
    assert.equal(res.headers.get('x-upstream-status'), '200');
    assert.ok(Number(res.headers.get('x-upstream-latency-ms')) >= 0);
    assert.equal(res.headers.get('x-stale'), null);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('origem fora do ar serve último válido com X-Stale', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(async () => { throw new Error('origem caiu'); });
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
    await restore(snap);
    restoreEnv(prev);
  }
});

test('sem fallback e com origem fora: 502 com JSON de erro', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    proxyHandler.definirTransporte(async () => { throw new Error('origem caiu'); });
    await writeCollection('system_config', []);
    const res = await proxyHandler(request('https://example.test/vazio'));
    assert.equal(res.status, 502);
    assert.ok((await res.json()).erro);
  } finally {
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
  try {
    setupEnv();
    process.env.PROXY_HOSTS = 'interno.test,publico.test';
    proxyHandler.definirResolvedor(async (host) => {
      if (host === 'interno.test') return ['10.1.2.3'];
      if (host === 'publico.test') return ['93.184.216.34'];
      throw new Error('NXDOMAIN simulado');
    });
    proxyHandler.definirTransporte(async () => respostaUpstream('ok', { contentType: 'text/plain' }));
    const ruim = await proxyHandler(request('https://interno.test/x'));
    assert.equal(ruim.status, 403);
    const bom = await proxyHandler(request('https://publico.test/x'));
    assert.equal(bom.status, 200);
    const semDns = await proxyHandler(request('https://nxdominio.test/x'));
    assert.equal(semDns.status, 403); // fail closed
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('produção sem PROXY_HOSTS recusa com 503; raw documentado', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.NODE_ENV = 'production';
    process.env.PROXY_HOSTS = '';
    proxyHandler.definirTransporte(async () => respostaUpstream('x', { contentType: 'text/plain' }));
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
    await restore(snap);
    restoreEnv(prev);
  }
});

test('TOCTOU: DNS que vira privado no meio da conexão é abortado', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.PROXY_HOSTS = 'publico.test';
    // Pré-checagem vê IP público (passa o 403)...
    proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
    // ...mas na hora de conectar o DNS já virou privado.
    const pings = [];
    proxyHandler.definirProcurarDns(async (host) => {
      pings.push(host);
      return pings.length === 1
        ? { address: '93.184.216.34', family: 4 }
        : { address: '10.9.9.9', family: 4 };
    });
    const transporte = transporteSimulado({
      '/primeiro': { status: 302, location: '/segundo' },
      '/segundo': { corpo: 'nunca-chega-aqui' },
    });
    proxyHandler.definirTransporte(transporte);
    const res = await proxyHandler(request('https://publico.test/primeiro'));
    assert.equal(res.status, 502);
    assert.ok((await res.json()).erro);
    // Hop 1 conectou; hop 2 foi abortado no lookup (sem 2ª transferência).
    assert.deepEqual(transporte.chamadas, ['publico.test/primeiro']);
    assert.ok(pings.length >= 2);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('redirect público→público é seguido; p/ privado é 403; excesso é 502', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.PROXY_HOSTS = 'a.test,b.test';
    proxyHandler.definirResolvedor(async () => ['93.184.216.34']);
    proxyHandler.definirTransporte(transporteSimulado({
      '/vai': { status: 302, location: 'https://b.test/chegou' },
      '/chegou': { corpo: '{"ok":true}' },
      '/mal': { status: 302, location: 'http://169.254.169.254/x' },
      '/loop': { status: 302, location: 'https://a.test/loop' },
    }));
    const seguido = await proxyHandler(request('https://a.test/vai'));
    assert.equal(seguido.status, 200);
    assert.equal(await seguido.text(), '{"ok":true}');
    const pPrivado = await proxyHandler(request('https://a.test/mal'));
    assert.equal(pPrivado.status, 403);
    assert.ok((await pPrivado.json()).motivo);
    const excesso = await proxyHandler(request('https://a.test/loop'));
    assert.equal(excesso.status, 502);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('motivoEnderecoBloqueado cobre faixas privadas, metadata e mapeadas', () => {
  for (const ip of ['10.0.0.5', '127.0.0.1', '172.20.10.4', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:10.0.0.1', '0:0:0:0:0:ffff:192.168.0.1', '2130706433']) {
    assert.ok(proxyHandler.motivoEnderecoBloqueado(ip), ip);
    assert.equal(proxyHandler.ehIpPrivado(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:db8::1']) {
    assert.equal(proxyHandler.motivoEnderecoBloqueado(ip), null, ip);
    assert.equal(proxyHandler.ehIpPrivado(ip), false, ip);
  }
});

test('lookupSeguro barra privado e libera público sem rede', async () => {
  proxyHandler.definirProcurarDns(async (host) => (
    host === 'privado.test' ? { address: '10.1.2.3', family: 4 } : { address: '93.184.216.34', family: 4 }
  ));
  try {
    await assert.rejects(
      new Promise((resolve, reject) => {
        proxyHandler.lookupSeguro('privado.test', {}, (erro) => (erro ? reject(erro) : resolve()));
      }),
      /SSRF/
    );
    const [endereco, familia] = await new Promise((resolve, reject) => {
      proxyHandler.lookupSeguro('publico.test', {}, (erro, address, family) => (
        erro ? reject(erro) : resolve([address, family])
      ));
    });
    assert.equal(endereco, '93.184.216.34');
    assert.equal(familia, 4);
  } finally {
    proxyHandler.definirProcurarDns(null);
  }
});

test('coletarCorpoLimitado estoura e destrói o stream', async () => {
  const { Readable } = require('node:stream');
  const lento = Readable.from([Buffer.alloc(100), Buffer.alloc(100), Buffer.alloc(100)]);
  await assert.rejects(
    proxyHandler.coletarCorpoLimitado(lento, 150),
    /excede o limite/
  );
  const exato = Readable.from([Buffer.alloc(100), Buffer.alloc(50)]);
  assert.equal((await proxyHandler.coletarCorpoLimitado(exato, 150)).length, 150);
});

test('transporteNativo aplica teto e timeout contra servidor local', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/grande') {
      // Content-Length mente para cima: pré-checagem deve barrar.
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '99999999' });
      res.end('x');
      return;
    }
    if (req.url === '/lento') return; // nunca responde → timeout
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('corpo-real');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const porta = server.address().port;
  // Mock no formato que o net do Node 24 exige (array quando all:true).
  const permissivo = (hostname, opcoes, cb) => {
    const done = typeof opcoes === 'function' ? opcoes : cb;
    const emLote = opcoes && typeof opcoes === 'object' && opcoes.all === true;
    if (emLote) done(null, [{ address: '127.0.0.1', family: 4 }]);
    else done(null, '127.0.0.1', 4);
  };
  try {
    const alvo = (caminho) => new URL(`http://localhost:${porta}${caminho}`);
    const ok = await proxyHandler.transporteNativo({ parsed: alvo('/ok'), timeoutMs: 5000, maxBytes: 1024, lookup: permissivo });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), 'corpo-real');
    await assert.rejects(
      proxyHandler.transporteNativo({ parsed: alvo('/grande'), timeoutMs: 5000, maxBytes: 1024, lookup: permissivo }),
      /excede o limite/
    );
    await assert.rejects(
      proxyHandler.transporteNativo({ parsed: alvo('/lento'), timeoutMs: 200, maxBytes: 1024, lookup: permissivo }),
      /Timeout/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
