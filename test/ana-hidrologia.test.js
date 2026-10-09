const { test } = require('node:test');
const assert = require('node:assert/strict');
const apiHandler = require('../api/index');
const { demoReset } = require('../api/_lib/demo');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV',
  'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
];

function stationRow({ code, name, municipality, latitude, longitude, river, status = 'Ativo' }) {
  return `<Table>
    <NomeEstacao>${name}</NomeEstacao>
    <CodEstacao>${code}</CodEstacao>
    <Municipio-UF>${municipality}</Municipio-UF>
    <Latitude>${latitude}</Latitude>
    <Longitude>${longitude}</Longitude>
    <NomeRio>${river || ''}</NomeRio>
    <StatusEstacao>${status}</StatusEstacao>
  </Table>`;
}

test('endpoint ANA filtra estações ativas de MT, decodifica XML e usa cache', async () => {
  const originalFetch = global.fetch;
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  let calls = 0;
  const xml = `<DataSet>
    ${stationRow({
      code: '01560000',
      name: 'PONTE &amp; RIO',
      municipality: 'CUIABÁ-MT',
      latitude: '-15.60',
      longitude: '-56.10',
      river: 'RIO CUIABÁ',
    })}
    ${stationRow({
      code: '00047008',
      name: 'CURUÇÁ',
      municipality: 'CURUÇÁ-PA',
      latitude: '-0.72',
      longitude: '-47.85',
      river: '',
    })}
    ${stationRow({
      code: '01560001',
      name: 'INATIVA',
      municipality: 'CUIABÁ-MT',
      latitude: '-15.60',
      longitude: '-56.10',
      river: 'RIO CUIABÁ',
      status: 'Manutenção',
    })}
  </DataSet>`;

  global.fetch = async (url, options) => {
    calls += 1;
    assert.match(String(url), /^https:\/\/telemetriaws1\.ana\.gov\.br\//);
    assert.equal(options.redirect, 'manual');
    return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
  };

  try {
    process.env.AUTH_LOGIN_ENABLED = 'false';
    process.env.DEMO_HORAS = '0';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    demoReset();

    const first = await apiHandler(new Request('http://localhost/api/ana-hidrologia'));
    assert.equal(first.status, 200);
    const data = await first.json();
    assert.equal(data.totalEstacoes, 1);
    assert.equal(data.estacoes[0].codigo, '01560000');
    assert.equal(data.estacoes[0].nome, 'PONTE & RIO');
    assert.equal(data.estacoes[0].municipio, 'CUIABÁ');
    assert.equal(data.estacoes[0].rio, 'RIO CUIABÁ');
    assert.equal(data.estacoes[0].latitude, -15.6);
    assert.equal(calls, 1);

    const cached = await apiHandler(new Request('http://localhost/api/ana-hidrologia'));
    assert.equal(cached.status, 200);
    assert.equal(calls, 1);

    const refreshed = await apiHandler(new Request('http://localhost/api/ana-hidrologia?refresh=1'));
    assert.equal(refreshed.status, 200);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    demoReset();
  }
});

test('endpoint ANA retorna erro explícito se o serviço oficial estiver indisponível', async () => {
  const originalFetch = global.fetch;
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  global.fetch = async () => new Response('indisponível', { status: 503 });
  try {
    process.env.AUTH_LOGIN_ENABLED = 'false';
    process.env.DEMO_HORAS = '0';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    demoReset();
    const response = await apiHandler(new Request('http://localhost/api/ana-hidrologia?refresh=1'));
    assert.equal(response.status, 502);
    assert.match((await response.json()).erro, /ANA/);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    demoReset();
  }
});
