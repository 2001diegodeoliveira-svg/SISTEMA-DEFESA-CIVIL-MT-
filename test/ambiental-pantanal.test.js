/* ============================================================
   Testes da rota /api/ambiental-pantanal (ICMBio WFS + IBAMA).
   Sem rede: global.fetch substituído em cada teste.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const apiHandler = require('../api/index');
const rota = require('../api/_routes/ambiental-pantanal');
const { demoReset } = require('../api/_lib/demo');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV',
  'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
];

function setupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.VERCEL_ENV = 'preview';
  demoReset();
  rota.limparCache();
}

function get(path) {
  return new Request(`http://localhost/api/${path}`, { method: 'GET' });
}

const CSV_EMBARGOS = [
  'SEQ_TAD;NUM_TAD;SEQ_POLIGONO;SQ_POLIGONO_AIEMOB;NO_AREA;AREA_POLIGONO;SEQ_PONTO_POLIGONO;SQ_COORDENADA_AIEMOB;ORDEM;LONGITUDE;LATITUDE;WKT;ULTIMA_ATUALIZACAO_RELATORIO',
  '"1";"TAD1";"10";"";"";"";"3";"";"";"-56,5";"-19,5";"";"2026-01-01"',
  '"1";"TAD1";"10";"";"";"";"1";"";"";"-56,6";"-19,6";"";"2026-01-01"',
  '"1";"TAD1";"10";"";"";"";"2";"";"";"-56,4";"-19,4";"";"2026-01-01"',
  '"2";"TAD2";"20";"";"";"";"1";"";"";"-56,1";"-19,1";"";"2026-01-01"',
  '"3";"TAD3";"30";"";"";"";"1";"";"";"-40,0";"-10,0";"";"2026-01-01"',
  '"4";"TAD4";"40";"";"";"";"1";"";"";"-56,2";"-19,2";"";"2026-01-01"',
  '"4";"TAD4";"40";"";"";"";"2";"";"";"-56,3";"-19,3";"";"2026-01-01"',
  '"4";"TAD4";"40";"";"";"";"3";"";"";"-50,0";"-10,0";"";"2026-01-01"',
].join('\r\n');

const UCS_GEOJSON = {
  type: 'FeatureCollection',
  totalFeatures: 1,
  numberMatched: 1,
  numberReturned: 1,
  features: [{
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[-56.8, -19.0], [-56.7, -19.0], [-56.7, -19.1], [-56.8, -19.0]]] },
    properties: {
      ogc_fid: 1, nomeuc: 'PARQUE NACIONAL DO PANTANAL MATO-GROSSENSE', cnuc: '0000.00.0175',
      criacaoano: 1981, areahaalb: 183094.585, esferaadm: 'Federal', grupouc: 'PI',
      biomas: 'PANTANAL', bioma_pred: 'Pantanal', uf: 'MT',
      categoria_: 'Parque Nacional', sigla_cate: 'PARNA',
    },
  }],
};

const AUTOS_GEOJSON = {
  type: 'FeatureCollection',
  totalFeatures: 2,
  numberMatched: 2,
  numberReturned: 2,
  features: [{
    type: 'Feature',
    geometry: { type: 'MultiPoint', coordinates: [[-56.73, -20.79]] },
    properties: {
      ogc_fid: 1380, numero_ai: '2SGO17A0', tipo: 'Multa simples', valor_mult: 36000,
      embargo: 'Sim', apreensao: 'Não', autuado: 'FULANO DE TAL', cpf_cnpj: '35799285972',
      data: '2025-06-18Z', ano: 2025, tipo_infra: 'Das Infrações Contra a Flora',
      nome_uc: 'PARNA da Serra da Bodoquena', cnuc: '0000.00.0143', municipio: 'Bodoquena',
      uf: 'MS', processo: '02129000781202588', desc_ai_1: 'Destruir vegetação nativa.',
    },
  }],
};

function stubFetch({ falhar = {} } = {}) {
  const chamadas = [];
  global.fetch = async (url) => {
    const u = String(url);
    chamadas.push(u);
    if (u.includes('geoservicos.inde.gov.br')) {
      if (u.includes('limiteucsfederais_a')) {
        if (falhar.ucs) return new Response('erro', { status: 500 });
        return new Response(JSON.stringify(UCS_GEOJSON), { status: 200 });
      }
      if (u.includes('autos_infracao_icmbio')) {
        if (falhar.autos) return new Response('erro', { status: 500 });
        return new Response(JSON.stringify(AUTOS_GEOJSON), { status: 200 });
      }
    }
    if (u.includes('termo_de_embargo_coordenadas.csv')) {
      if (falhar.embargos) return new Response('erro', { status: 500 });
      return new Response(Buffer.from(CSV_EMBARGOS, 'latin1'), { status: 200 });
    }
    return new Response('não esperado: ' + u, { status: 404 });
  };
  return chamadas;
}

test('rota devolve UCs, autos e embargos normalizados', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    stubFetch();
    const res = await apiHandler(get('ambiental-pantanal'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=3600/);
    assert.equal(res.headers.get('x-fonte'), 'icmbio+ibama');

    const j = await res.json();
    assert.equal(j.regiao, 'Pantanal');
    assert.deepEqual(j.camadas, ['ucs', 'autos', 'embargos']);

    assert.equal(j.totais.ucs, 1);
    assert.equal(j.ucs.features[0].properties.nome, 'PARQUE NACIONAL DO PANTANAL MATO-GROSSENSE');
    assert.equal(j.ucs.features[0].properties.areaHa, 183094.59);
    assert.equal(j.ucs.features[0].geometry.type, 'Polygon');

    assert.equal(j.totais.autos, 1);
    assert.equal(j.autos.features[0].properties.numero, '2SGO17A0');
    assert.equal(j.autos.features[0].properties.valor, 36000);
    assert.equal(j.autos.features[0].properties.embargo, true);
    assert.equal(j.autos.features[0].properties.data, '2025-06-18');
    // Contrato: o WFS do ICMBio entrega MultiPoint — o front precisa tratar.
    assert.equal(j.autos.features[0].geometry.type, 'MultiPoint');

    // Três polígonos tocam o bbox; o quarto (fora) é descartado.
    assert.equal(j.totais.embargos, 3);
    assert.equal(j.casados.embargos, 3);
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('privacidade: autuado e CPF/CNPJ nunca saem da API', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    stubFetch();
    const res = await apiHandler(get('ambiental-pantanal'));
    const texto = await res.text();
    assert.equal(texto.includes('FULANO DE TAL'), false);
    assert.equal(texto.includes('35799285972'), false);
    assert.equal(texto.includes('cpf_cnpj'), false);
    assert.equal(texto.includes('autuado'), false);
    assert.equal(texto.includes('autuado'), false);
    assert.ok(texto.includes('PARNA da Serra da Bodoquena'));
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('embargos: agrupa por polígono, ordena vértices e fecha o anel', async () => {
  const bbox = { minLon: -58.9, minLat: -22.2, maxLon: -54.9, maxLat: -15.5 };
  const r = rota.processarEmbargos(CSV_EMBARGOS, bbox, 100);
  assert.equal(r.poligonosCasados, 3);
  assert.equal(r.vertices, 7); // TAD1 (3) + TAD2 (1) + TAD4 (3); TAD3 está fora

  const poligono = r.features.find((f) => f.properties.numTad === 'TAD1');
  assert.equal(poligono.geometry.type, 'Polygon');
  assert.deepEqual(poligono.geometry.coordinates[0], [
    [-56.6, -19.6], [-56.4, -19.4], [-56.5, -19.5], [-56.6, -19.6],
  ]);

  const ponto = r.features.find((f) => f.properties.numTad === 'TAD2');
  assert.equal(ponto.geometry.type, 'Point');
  assert.deepEqual(ponto.geometry.coordinates, [-56.1, -19.1]);

  // Polígono que cruza a borda entra inteiro (nenhum vértice perdido).
  const cruzando = r.features.find((f) => f.properties.numTad === 'TAD4');
  assert.equal(cruzando.geometry.type, 'Polygon');
  assert.equal(cruzando.properties.vertices, 3);
  assert.deepEqual(cruzando.geometry.coordinates[0], [
    [-56.2, -19.2], [-56.3, -19.3], [-50, -10], [-56.2, -19.2],
  ]);

  assert.equal(r.features.some((f) => f.properties.numTad === 'TAD3'), false);
});

test('cache: segunda chamada não baixa o CSV de embargos de novo', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    const chamadas = stubFetch();
    await apiHandler(get('ambiental-pantanal'));
    const baixou1 = chamadas.filter((u) => u.includes('termo_de_embargo_coordenadas.csv')).length;
    await apiHandler(get('ambiental-pantanal'));
    const baixou2 = chamadas.filter((u) => u.includes('termo_de_embargo_coordenadas.csv')).length;
    assert.equal(baixou1, 1);
    assert.equal(baixou2, 1);
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('validação: bbox, camadas e método', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    stubFetch();

    const bboxRuim = await apiHandler(get('ambiental-pantanal?bbox=1,2,3'));
    assert.equal(bboxRuim.status, 400);
    assert.ok((await bboxRuim.json()).erro);

    const invertida = await apiHandler(get('ambiental-pantanal?bbox=-50,-20,-60,-10'));
    assert.equal(invertida.status, 400);

    const grande = await apiHandler(get('ambiental-pantanal?bbox=-80,-40,-30,10'));
    assert.equal(grande.status, 400);

    const camadaRuim = await apiHandler(get('ambiental-pantanal?camadas=foo'));
    assert.equal(camadaRuim.status, 400);

    const post = await apiHandler(new Request('http://localhost/api/ambiental-pantanal', { method: 'POST' }));
    assert.equal(post.status, 405);
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('camadas=ucs não consulta autos nem embargos', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    const chamadas = stubFetch();
    const res = await apiHandler(get('ambiental-pantanal?camadas=ucs'));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(j.camadas, ['ucs']);
    assert.equal(j.totais.autos, 0);
    assert.equal(j.totais.embargos, 0);
    assert.equal(chamadas.some((u) => u.includes('autos_infracao_icmbio')), false);
    assert.equal(chamadas.some((u) => u.includes('termo_de_embargo')), false);
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('falha total das fontes vira 502 com {erro}', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    stubFetch({ falhar: { ucs: true, autos: true, embargos: true } });
    const res = await apiHandler(get('ambiental-pantanal'));
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.ok(j.erro);
    assert.ok(Array.isArray(j.detalhes));
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('falha parcial mantém as camadas que responderam', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    stubFetch({ falhar: { embargos: true } });
    const res = await apiHandler(get('ambiental-pantanal'));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.parciais.embargos, true);
    assert.equal(j.totais.ucs, 1);
    assert.equal(j.totais.autos, 1);
    assert.ok(j.avisos.some((a) => a.includes('IBAMA')));
  } finally {
    global.fetch = fetchOrig;
    for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
