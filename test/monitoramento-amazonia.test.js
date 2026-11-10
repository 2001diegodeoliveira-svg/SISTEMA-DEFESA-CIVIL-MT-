/* ============================================================
   Testes do monitoramento 24 h da Amazônia-MT.
   Sem rede: global.fetch substituído. Handler da própria rota.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rota = require('../api/_routes/monitoramento-amazonia');
const geo = require('../api/_lib/geo');
const REGIAO = require('../api/_lib/amazonia-mt.json');

const handler = rota;
const ENV_KEYS = ['FIRMS_MAP_KEY', 'MAPBIOMAS_TOKEN'];

function comEnv(vars, fn) {
  return async () => {
    const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const fetchOrig = global.fetch;
    try {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, vars);
      rota.limparCache();
      await fn();
    } finally {
      global.fetch = fetchOrig;
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rota.limparCache();
    }
  };
}

function get(qs = '') {
  return new Request(`http://localhost/api/monitoramento-amazonia${qs}`, { method: 'GET' });
}

const agoraIso = (deltaMin = 0) => new Date(Date.now() + deltaMin * 60000).toISOString().replace('.000Z', 'Z').slice(0, 19) + 'Z';

function csvInpe(linhas) {
  const cab = 'id,lat,lon,data_hora_gmt,satelite,municipio,estado,pais,municipio_id,estado_id,pais_id,numero_dias_sem_chuva,precipitacao,risco_fogo,bioma,frp';
  return [cab, ...linhas].join('\n');
}

/* ---------- regiao e utilidades ---------- */

test('regiao: MultiPolygon/Polygon válido com municípios de MT e bbox coerente', () => {
  assert.match(REGIAO.geojson.geometry.type, /^(Multi)?Polygon$/);
  assert.ok(REGIAO.municipios.length > 50);
  for (const m of REGIAO.municipios) assert.match(m.codigo, /^51\d{5}$/);
  const [a, b, c, d] = geo.bboxOfGeometry(REGIAO.geojson.geometry);
  assert.ok(Math.abs(a - REGIAO.bbox[0]) < 0.01 && Math.abs(d - REGIAO.bbox[3]) < 0.01);
});

test('pontos de controle: Sinop e Aripuanã dentro; Cuiabá, Poconé e Campo Grande fora', () => {
  const dentro = (lon, lat) => geo.pointInPolygon([lon, lat], REGIAO.geojson.geometry);
  assert.equal(dentro(-55.5, -11.86), true, 'Sinop');
  assert.equal(dentro(-60.5, -10.2), true, 'Aripuanã');
  assert.equal(dentro(-56.1, -15.6), false, 'Cuiabá');
  assert.equal(dentro(-56.7136, -16.7722), false, 'Poconé (Pantanal)');
  assert.equal(dentro(-54.63, -20.47), false, 'Campo Grande (MS)');
});

test('parseHoras: 1..120 aceitos; fora da faixa recusado', () => {
  assert.equal(rota.parseHoras(undefined), 24);
  assert.equal(rota.parseHoras('48'), 48);
  for (const v of ['0', '121', '2.5', 'x']) assert.throws(() => rota.parseHoras(v), /horas inválidas/, v);
});

test('datasDaJanela: 24 h cobre hoje e ontem; 72 h cobre 4 datas', () => {
  const agora = Date.parse('2026-11-10T06:00:00Z');
  assert.deepEqual(rota.datasDaJanela(24, agora), ['20261109', '20261110']);
  assert.equal(rota.datasDaJanela(72, agora).length, 4);
});

test('splitCsv: respeita vírgula entre aspas', () => {
  assert.deepEqual(rota.splitCsv('1,"Nova Maringá, MT",2'), ['1', 'Nova Maringá, MT', '2']);
});

test('parseFocosInpe: só pontos dentro da Amazônia-MT e dentro da janela', () => {
  const agora = Date.now();
  const recente = agoraIso(-120);
  const antigo = agoraIso(-60 * 30);
  const csv = csvInpe([
    `1,-11.86,-55.5,${recente},AQUA_M-T,"Sinop, MT",MATO GROSSO,Brasil,5107909,51,76,0,0,1,Amazônia,12.5`,
    `2,-16.7722,-56.7136,${recente},AQUA_M-T,Poconé,MATO GROSSO,Brasil,5106505,51,76,0,0,1,Pantanal,30`,
    `3,-11.86,-55.5,${antigo},AQUA_M-T,Sinop,MATO GROSSO,Brasil,5107909,51,76,0,0,1,Amazônia,8`,
  ]);
  const focos = rota.parseFocosInpe(csv, agora - 24 * 3600000);
  assert.equal(focos.length, 1);
  assert.equal(focos[0].municipio, 'Sinop, MT');
  assert.equal(focos[0].frp, 12.5);
});

/* ---------- rota com fontes simuladas ---------- */

function stubFontes({ inpeCsv = null, censipam = [], firmsCorpo = null, falhar = [] } = {}) {
  const chamadas = [];
  global.fetch = async (url) => {
    const u = String(url);
    chamadas.push(u);
    if (u.includes('dataserver-coids.inpe.br')) {
      if (falhar.includes('inpe')) return new Response('x', { status: 500 });
      if (inpeCsv === null) return new Response('', { status: 404 });
      return new Response(inpeCsv, { status: 200 });
    }
    if (u.includes('panorama.sipam.gov.br')) {
      if (falhar.includes('censipam')) return new Response('x', { status: 500 });
      return new Response(JSON.stringify(censipam), { status: 200 });
    }
    if (u.includes('firms.modaps.eosdis.nasa.gov')) {
      return new Response(firmsCorpo ?? 'Invalid MAP_KEY.', { status: 200 });
    }
    return new Response('x', { status: 404 });
  };
  return chamadas;
}

test('rota: INPE + CENSIPAM ao vivo (simulados), FIRMS sem chave, MapBiomas sem token', comEnv({}, async () => {
  const recente = agoraIso(-200);
  stubFontes({
    inpeCsv: csvInpe([`1,-11.86,-55.5,${recente},AQUA_M-T,"Sinop, MT",MATO GROSSO,Brasil,5107909,51,76,0,0,1,Amazônia,12.5`]),
    censipam: [{
      id_evento: 7, status_evento: 'Em observação', dt_ultima_visao: recente, persistencia_dias: 3,
      area_total_evento: 6.1, latitude: -12.67, longitude: -57.31, municipio: 'Nova Maringá - MT',
      unidade_conservacao: null, terra_indigena: null,
    }],
  });
  const res = await handler(get('?horas=24'));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.janelaHoras, 24);
  assert.equal(j.status.inpe, 'ok');
  assert.equal(j.inpe.total >= 1, true);
  assert.equal(j.status.censipam, 'ok');
  assert.equal(j.censipam.total, 1);
  assert.equal(j.status.firms, 'sem_chave');
  assert.equal(j.status.mapbiomas, 'sem_token');
  assert.match(j.mapbiomas.mensagem, /MAPBIOMAS_TOKEN/);
  assert.ok(j.avisos.some((a) => /FIRMS_MAP_KEY/.test(a)));
}));

test('rota: dados demonstrativos não existem — resposta vem só das fontes', comEnv({}, async () => {
  stubFontes({ inpeCsv: csvInpe([]), censipam: [] });
  const res = await handler(get('?horas=24'));
  const texto = await res.text();
  assert.equal(/demo|mock|exemplo|simulad/i.test(texto.replace(/dados simulados|simulad[oa]s/gi, '')), false);
  const j = JSON.parse(texto);
  assert.equal(j.inpe.total, 0);
  assert.equal(j.censipam.total, 0);
}));

test('rota: CENSIPAM filtra eventos fora da janela e fora da região', comEnv({}, async () => {
  const recente = agoraIso(-100);
  const antigo = agoraIso(-60 * 24 * 3);
  stubFontes({
    inpeCsv: csvInpe([]),
    censipam: [
      { id_evento: 1, dt_ultima_visao: recente, latitude: -12.6, longitude: -57.3, municipio: 'A', area_total_evento: 1 },
      { id_evento: 2, dt_ultima_visao: antigo, latitude: -12.6, longitude: -57.3, municipio: 'B', area_total_evento: 1 },
      { id_evento: 3, dt_ultima_visao: recente, latitude: -16.7, longitude: -56.7, municipio: 'C', area_total_evento: 1 },
    ],
  });
  const j = await (await handler(get('?horas=24'))).json();
  assert.equal(j.censipam.total, 1);
  assert.equal(j.censipam.eventos[0].id, 1);
}));

test('rota: FIRMS com chave configurada usa o módulo firms (MAP_KEY não vaza)', comEnv({ FIRMS_MAP_KEY: 'FIXTURE-NAO-REAL-0000' }, async () => {
  const chamadas = stubFontes({
    inpeCsv: csvInpe([]),
    censipam: [],
    firmsCorpo: 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n-11.86,-55.5,320,0.4,0.4,2026-11-10,0310,N,VIIRS,high,2.0,290,9.0,D',
  });
  const res = await handler(get('?horas=24'));
  const texto = await res.text();
  assert.equal(texto.includes('FIXTURE-NAO-REAL-0000'), false);
  const j = JSON.parse(texto);
  assert.equal(j.status.firms, 'ok');
  assert.ok(chamadas.some((u) => u.includes('firms.modaps.eosdis.nasa.gov')));
}));

test('rota: INPE e CENSIPAM indisponíveis -> 502 com {erro}', comEnv({}, async () => {
  stubFontes({ falhar: ['inpe', 'censipam'] });
  const res = await handler(get('?horas=24'));
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.ok(j.erro);
  assert.ok(Array.isArray(j.detalhes));
}));

test('rota: parâmetro inválido -> 400 antes de qualquer chamada', comEnv({}, async () => {
  const chamadas = stubFontes();
  assert.equal((await handler(get('?horas=500'))).status, 400);
  assert.equal(chamadas.length, 0);
}));

test('rota: método não suportado -> 405', comEnv({}, async () => {
  const res = await handler(new Request('http://localhost/api/monitoramento-amazonia', { method: 'POST' }));
  assert.equal(res.status, 405);
}));
