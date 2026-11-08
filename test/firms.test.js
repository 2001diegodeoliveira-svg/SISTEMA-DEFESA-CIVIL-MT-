/* ============================================================
   Testes da integração NASA FIRMS (api/_routes/firms.js).
   Sem rede: global.fetch substituído. A MAP_KEY usada é um
   FIXTURE FALSO (não é credencial real) e nunca deve aparecer
   em respostas.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
/* Handler da própria rota (não o roteador api/index.js, que outra frente
   está alterando e hoje não carrega). */
const apiHandler = require('../api/_routes/firms');
const firms = require('../api/_routes/firms');
const { demoReset } = require('../api/_lib/demo');

const CHAVE_FIXTURE = 'FIXTURE-NAO-REAL-0000';
const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV',
  'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'FIRMS_MAP_KEY',
];

const CSV_OK = [
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
  '-16.5,-56.7,320.1,0.4,0.4,2026-11-07,1830,N,VIIRS,nominal,2.0,290.2,12.5,D',
  '-17.0,-57.1,330.0,0.4,0.4,2026-11-07,0005,N,VIIRS,high,2.0,290.2,4.1,N',
  'xx,-57.1,330.0,0.4,0.4,2026-11-07,0005,N,VIIRS,high,2.0,290.2,4.1,N',
].join('\n');

function comEnv(chave, fn) {
  return async () => {
    const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const fetchOrig = global.fetch;
    try {
      for (const k of ENV_KEYS) delete process.env[k];
      process.env.NODE_ENV = 'test';
      process.env.VERCEL_ENV = 'preview';
      if (chave !== undefined) process.env.FIRMS_MAP_KEY = chave;
      demoReset();
      firms.limparCache();
      await fn();
    } finally {
      global.fetch = fetchOrig;
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      demoReset();
      firms.limparCache();
    }
  };
}

function get(path) {
  return new Request(`http://localhost/api/${path}`, { method: 'GET' });
}

function stub(corpo, status = 200) {
  const chamadas = [];
  global.fetch = async (url) => {
    chamadas.push(String(url));
    return new Response(corpo, { status });
  };
  return chamadas;
}

/* ---------- validação e parsing (sem rede) ---------- */

test('parseDias: 1..5 aceitos; 0, 6, 7 e fracionários recusados', () => {
  assert.equal(firms.parseDias('1'), 1);
  assert.equal(firms.parseDias('5'), 5);
  assert.equal(firms.parseDias(undefined), 5);
  for (const v of ['0', '6', '7', '2.5', 'abc']) {
    assert.throws(() => firms.parseDias(v), /dias inválido/, v);
  }
});

test('parseFonte: apenas produtos NRT da documentação oficial', () => {
  assert.equal(firms.parseFonte('viirs_noaa21_nrt'), 'VIIRS_NOAA21_NRT');
  assert.equal(firms.parseFonte(undefined), 'VIIRS_SNPP_NRT');
  assert.throws(() => firms.parseFonte('LANDSAT_NRT'), /fonte inválida/);
  assert.throws(() => firms.parseFonte('MODIS_SP'), /fonte inválida/);
});

test('parseBbox: formato e intervalos', () => {
  const b = firms.parseBbox('-58.9,-22.2,-54.9,-15.5');
  assert.equal(b.minLon, -58.9);
  assert.throws(() => firms.parseBbox('1,2,3'), /bbox inválida/);
  assert.throws(() => firms.parseBbox('-50,-20,-60,-10'), /mínimo deve ser menor/);
  assert.throws(() => firms.parseBbox('-200,0,0,10'), /fora dos intervalos/);
});

test('parseCsv: descarta linhas inválidas e normaliza hora', () => {
  const focos = firms.parseCsv(CSV_OK);
  assert.equal(focos.length, 2, 'linha com latitude inválida fica de fora');
  assert.equal(focos[0].hora, '18:30');
  assert.equal(focos[1].hora, '00:05');
  assert.equal(focos[0].frp, 12.5);
  assert.equal(focos[1].confianca, 'high');
});

test('parseCsv: CSV sem colunas obrigatórias -> erro 502', () => {
  assert.throws(() => firms.parseCsv('foo,bar\n1,2'), (e) => e.status === 502 && /colunas/.test(e.message));
});

/* ---------- rota ---------- */

test('sem FIRMS_MAP_KEY: 503 com mensagem clara e nenhuma chamada à NASA', comEnv(undefined, async () => {
  const chamadas = stub(CSV_OK);
  const res = await apiHandler(get('firms'));
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.match(j.erro, /FIRMS_MAP_KEY não configurada/);
  assert.equal(chamadas.length, 0);
}));

test('com chave: 200, focos normalizados, cache e chave fora da resposta', comEnv(CHAVE_FIXTURE, async () => {
  const chamadas = stub(CSV_OK);
  const res = await apiHandler(get('firms?dias=3&fonte=VIIRS_SNPP_NRT'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fonte'), 'nasa-firms');
  assert.match(res.headers.get('cache-control') || '', /s-maxage=1800/);
  const texto = await res.text();
  const j = JSON.parse(texto);
  assert.equal(j.total, 2);
  assert.equal(j.diasConsultados, 3);
  assert.equal(texto.includes(CHAVE_FIXTURE), false, 'MAP_KEY nunca volta ao cliente');

  // A chave segue só na URL enviada à NASA, no formato da Area API.
  assert.equal(chamadas.length, 1);
  assert.match(chamadas[0], new RegExp('/api/area/csv/' + CHAVE_FIXTURE + '/VIIRS_SNPP_NRT/-58.9,-22.2,-54.9,-15.5/3$'));

  // Segunda chamada igual: cache, sem nova transação na NASA.
  await apiHandler(get('firms?dias=3&fonte=VIIRS_SNPP_NRT'));
  assert.equal(chamadas.length, 1);
}));

test('mensagem de erro da NASA ("Invalid MAP_KEY") vira 502 sem ecoar a chave', comEnv(CHAVE_FIXTURE, async () => {
  stub('Invalid MAP_KEY.', 200);
  const res = await apiHandler(get('firms?dias=1'));
  assert.equal(res.status, 502);
  const texto = await res.text();
  assert.equal(texto.includes(CHAVE_FIXTURE), false);
  assert.match(texto, /recusou a MAP_KEY/);
}));

test('HTTP de erro da NASA vira 502 sem URL nem chave', comEnv(CHAVE_FIXTURE, async () => {
  stub('erro', 500);
  const res = await apiHandler(get('firms?dias=1'));
  assert.equal(res.status, 502);
  const texto = await res.text();
  assert.equal(texto.includes(CHAVE_FIXTURE), false);
  assert.match(texto, /HTTP 500/);
}));

test('parâmetros inválidos na rota: 400 antes de qualquer chamada', comEnv(CHAVE_FIXTURE, async () => {
  const chamadas = stub(CSV_OK);
  assert.equal((await apiHandler(get('firms?dias=7'))).status, 400);
  assert.equal((await apiHandler(get('firms?fonte=LANDSAT_NRT'))).status, 400);
  assert.equal((await apiHandler(get('firms?bbox=1,2,3'))).status, 400);
  assert.equal(chamadas.length, 0);
}));

test('método não suportado: 405', comEnv(CHAVE_FIXTURE, async () => {
  const res = await apiHandler(new Request('http://localhost/api/firms', { method: 'POST' }));
  assert.equal(res.status, 405);
}));
