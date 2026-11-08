/* ============================================================
   Testes da delimitação e do monitoramento do Pantanal-MT.
   Sem rede: global.fetch substituído em cada teste.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const REGIAO = require('../api/_lib/pantanal-mt.json');
const rota = require('../api/_routes/pantanal-mt');
const apiHandler = rota;
const ana = require('../api/_routes/ana-hidrologia');
const ambiental = require('../api/_routes/ambiental-pantanal');
const inmet = require('../api/_routes/inmet-chuva');
const { demoReset } = require('../api/_lib/demo');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV',
  'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'FIRMS_MAP_KEY',
];

function setupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.VERCEL_ENV = 'preview';
  demoReset();
  rota.limparCache();
  ana.limparCache();
  ambiental.limparCache();
  inmet.limparCache();
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

/* ---------- delimitação (snapshot IBGE) ---------- */

test('região: polígono válido, municípios com código IBGE de MT e bbox coerente', () => {
  assert.equal(REGIAO.geojson.geometry.type, 'Polygon');
  const anel = REGIAO.geojson.geometry.coordinates[0];
  assert.equal(anel[0][0], anel[anel.length - 1][0]);
  assert.equal(anel[0][1], anel[anel.length - 1][1]);
  const [minLon, minLat, maxLon, maxLat] = REGIAO.bbox;
  for (const [x, y] of anel) {
    assert.ok(x >= minLon - 1e-6 && x <= maxLon + 1e-6, 'vértice fora do bbox (lon)');
    assert.ok(y >= minLat - 1e-6 && y <= maxLat + 1e-6, 'vértice fora do bbox (lat)');
  }
  assert.equal(REGIAO.municipios.length, 11);
  for (const m of REGIAO.municipios) {
    assert.match(m.codigo, /^51\d{5}$/, 'código IBGE de município de MT');
    assert.ok(m.percentualNoBioma >= 1, 'corte de 1% da área no bioma');
  }
});

test('naRegiao: pontos dentro do Pantanal-MT e fora (MS e Cuiabá)', () => {
  assert.equal(rota.naRegiao(-56.7136, -16.7722), true, 'interior do Pantanal (Poconé)');
  // A sede de Poconé fica no planalto, fora do bioma (o município tem 80% no Pantanal).
  assert.equal(rota.naRegiao(-56.6231, -16.2556), false, 'sede de Poconé (fora do bioma)');
  assert.equal(rota.naRegiao(-54.6295, -20.4697), false, 'Campo Grande (MS)');
  assert.equal(rota.naRegiao(-56.0979, -15.6014), false, 'Cuiabá (fora do bioma)');
  assert.equal(rota.naRegiao(-70, -10), false, 'fora do bbox');
});

/* ---------- risco e utilidades ---------- */

test('índice de risco: limites e classes', () => {
  assert.equal(rota.indiceRisco(15, 40, 30, 14), 100);
  assert.equal(rota.indiceRisco(95, 15, 0, 0), 0);
  assert.equal(rota.classeRisco(10), 'Baixo');
  assert.equal(rota.classeRisco(30), 'Moderado');
  assert.equal(rota.classeRisco(50), 'Alto');
  assert.equal(rota.classeRisco(70), 'Extremo');
});

test('dias sem chuva ignoram o dia corrente (último índice)', () => {
  assert.equal(rota.diasSemChuva([5, 0, 0, 0, 2]), 3);
  assert.equal(rota.diasSemChuva([0, 0, 0, 8]), 3, 'o último valor é o dia corrente e não entra');
});

/* ---------- rota com fontes simuladas ---------- */

const ANA_XML = `<DataSet>
<Table><NomeEstacao>CACERES</NomeEstacao><CodEstacao>66070004</CodEstacao><Municipio-UF>CACERES-MT</Municipio-UF><Latitude>-16,07</Latitude><Longitude>-57,70</Longitude><NomeRio>RIO PARAGUAI</NomeRio><StatusEstacao>Ativo</StatusEstacao></Table>
<Table><NomeEstacao>CACERES</NomeEstacao><CodEstacao>66070004</CodEstacao><Municipio-UF>CACERES-MT</Municipio-UF><Latitude>-16,07</Latitude><Longitude>-57,70</Longitude><NomeRio>RIO PARAGUAI</NomeRio><StatusEstacao>Ativo</StatusEstacao></Table>
<Table><NomeEstacao>CUIABA</NomeEstacao><CodEstacao>66000001</CodEstacao><Municipio-UF>CUIABA-MT</Municipio-UF><Latitude>-15,60</Latitude><Longitude>-56,10</Longitude><NomeRio>RIO CUIABA</NomeRio><StatusEstacao>Ativo</StatusEstacao></Table>
</DataSet>`;

const FOCOS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-56.7136, -16.7722] }, properties: { id_2: 5106505, municipio: 'POCONE', frp: 40, data_hora_gmt: '2026-11-07T10:00:00Z', satelite: 'AQUA' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-57.68, -16.07] }, properties: { id_2: 5102504, municipio: 'CACERES', frp: 10, data_hora_gmt: '2026-11-07T12:00:00Z', satelite: 'GOES-19' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-54.63, -20.47] }, properties: { id_2: 5002704, municipio: 'CAMPO GRANDE', frp: 99, data_hora_gmt: '2026-11-07T13:00:00Z', satelite: 'AQUA' } },
  ],
};

const ICMBIO_UCS = {
  type: 'FeatureCollection',
  numberMatched: 1,
  features: [{
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[[[-56.9, -16.8], [-56.4, -16.8], [-56.4, -16.4], [-56.9, -16.8]]]] },
    properties: { ogc_fid: 1, nomeuc: 'RESERVA TESTE', areahaalb: 1000 },
  }],
};

const ICMBIO_AUTOS = {
  type: 'FeatureCollection',
  numberMatched: 2,
  features: [
    { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-56.7136, -16.7722]] }, properties: { ogc_fid: 10, numero_ai: 'A1', valor_mult: 1000, embargo: 'Sim', data: '2026-01-01Z', autuado: 'NAO DEVE VAZAR', cpf_cnpj: '000' } },
    { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-54.6, -20.4]] }, properties: { ogc_fid: 11, numero_ai: 'A2', valor_mult: 5000, embargo: 'Nao' } },
  ],
};

const CSV_EMB = [
  'SEQ_TAD;NUM_TAD;SEQ_POLIGONO;SQ_POLIGONO_AIEMOB;NO_AREA;AREA_POLIGONO;SEQ_PONTO_POLIGONO;SQ_COORDENADA_AIEMOB;ORDEM;LONGITUDE;LATITUDE;WKT;ULTIMA',
  '"1";"TAD1";"10";"";"";"";"1";"";"";"-56,5";"-16,3";"";"x"',
  '"1";"TAD1";"10";"";"";"";"2";"";"";"-56,4";"-16,4";"";"x"',
  '"1";"TAD1";"10";"";"";"";"3";"";"";"-56,6";"-16,5";"";"x"',
].join('\r\n');

function stubFontes({ falhar = [] } = {}) {
  const chamadas = [];
  global.fetch = async (url) => {
    const u = String(url);
    chamadas.push(u);
    const cai = (nome) => falhar.includes(nome);
    if (u.includes('terrabrasilis')) {
      if (cai('inpe')) return new Response('x', { status: 500 });
      return new Response(JSON.stringify(FOCOS), { status: 200 });
    }
    if (u.includes('open-meteo')) {
      if (cai('clima')) return new Response('x', { status: 500 });
      const n = new URL(u).searchParams.get('latitude').split(',').length;
      const registro = { current: { temperature_2m: 33, relative_humidity_2m: 35, wind_speed_10m: 18 }, daily: { precipitation_sum: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } };
      return new Response(JSON.stringify(Array.from({ length: n }, () => registro)), { status: 200 });
    }
    if (u.includes('telemetriaws')) return new Response(ANA_XML, { status: 200 });
    if (u.includes('servicodados.ibge.gov.br')) {
      return new Response(JSON.stringify([{ id: 5101605, nome: 'Barão de Melgaço' }, { id: 5106505, nome: 'Poconé' }]), { status: 200 });
    }
    if (u.includes('geoservicos.inde.gov.br')) {
      if (cai('ambiental')) return new Response('x', { status: 500 });
      if (u.includes('limiteucsfederais_a')) return new Response(JSON.stringify(ICMBIO_UCS), { status: 200 });
      return new Response(JSON.stringify(ICMBIO_AUTOS), { status: 200 });
    }
    if (u.includes('termo_de_embargo_coordenadas.csv')) {
      return new Response(Buffer.from(CSV_EMB, 'latin1'), { status: 200 });
    }
    // INMET (zip via Range) e demais: indisponíveis neste teste.
    return new Response('indisponível', { status: 503 });
  };
  return chamadas;
}

async function comEnv(fn) {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    return await fn();
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
}

test('rota: focos recortados pela região, ANA deduplicada, IBGE e ICMBio/IBAMA', () => comEnv(async () => {
  stubFontes();
  const res = await apiHandler(get('pantanal-mt'));
  assert.equal(res.status, 200);
  const j = await res.json();

  assert.equal(j.regiao.nome, REGIAO.regiao);
  assert.equal(j.regiao.fontes.municipiosIbge, 'api.ibge');
  const pocone = j.regiao.municipios.find((m) => m.codigo === '5106505');
  assert.equal(pocone.nome, 'Poconé');

  assert.equal(j.status.focos, 'ok');
  const m = j.monitoramento;
  // Campo Grande (MS) cai fora da região: só 2 focos de MT contam.
  assert.equal(m.focos.total, 2);
  assert.equal(m.focos.porMunicipio.find((x) => x.codigo === '5106505').focos, 1);

  // Estação ANA repetida conta uma vez; Cuiabá fica fora.
  assert.equal(m.hidrologia.total, 1);

  assert.equal(m.ambiental.ucs.total, 1);
  assert.equal(m.ambiental.autos.total, 1, 'auto fora da região não conta');
  assert.equal(m.ambiental.autos.comEmbargo, 1);
  assert.equal(m.ambiental.embargos.total, 1);

  const texto = JSON.stringify(j);
  assert.equal(texto.includes('NAO DEVE VAZAR'), false, 'autuado não pode sair da API');
  assert.equal(texto.includes('"cpf_cnpj"'), false);
}));

test('rota: falha de uma seção não derruba as outras (status erro + aviso)', () => comEnv(async () => {
  stubFontes({ falhar: ['inpe'] });
  const res = await apiHandler(get('pantanal-mt'));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status.focos, 'erro');
  assert.equal(j.status.clima, 'ok');
  assert.equal(j.monitoramento.focos, null);
  assert.ok(j.avisos.some((a) => a.startsWith('focos:')));
}));

test('rota: clima calculado sobre a grade dentro da região', () => comEnv(async () => {
  stubFontes({ falhar: ['inpe', 'ambiental'] });
  const res = await apiHandler(get('pantanal-mt'));
  const j = await res.json();
  assert.equal(j.status.clima, 'ok');
  const c = j.monitoramento.clima;
  assert.ok(c.pontos > 0);
  assert.equal(c.classes.Baixo + c.classes.Moderado + c.classes.Alto + c.classes.Extremo, c.pontos);
  assert.equal(c.riscoMaximo.classe, 'Extremo', 'T 33 °C, UR 35%, sem chuva');
}));

test('rota: todas as fontes falham -> 502 com {erro}', () => comEnv(async () => {
  global.fetch = async () => new Response('x', { status: 500 });
  const res = await apiHandler(get('pantanal-mt'));
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.ok(j.erro);
  assert.ok(Array.isArray(j.detalhes));
}));

test('rota: método não suportado -> 405', () => comEnv(async () => {
  const res = await apiHandler(new Request('http://localhost/api/pantanal-mt', { method: 'POST' }));
  assert.equal(res.status, 405);
}));
