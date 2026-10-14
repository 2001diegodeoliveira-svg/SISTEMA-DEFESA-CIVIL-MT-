/* ============================================================
   Testes da Fase 3 (cobertura nacional).
   ?uf= nas rotas ANA e INMET-chuva, nova rota de barragens
   (SNISB/ArcGIS) e nova rota de avisos INMET (CAP). Sem rede:
   fetch global com stub em cada teste.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const apiHandler = require('../api/index');
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

/* ---------- ANA ?uf= ---------- */
const ANA_XML = `<DataSet>
<Table><NomeEstacao>PONTE</NomeEstacao><CodEstacao>01560000</CodEstacao><Municipio-UF>CUIABA-MT</Municipio-UF><Latitude>-15,60</Latitude><Longitude>-56,10</Longitude><NomeRio>RIO CUIABA</NomeRio><StatusEstacao>Ativo</StatusEstacao></Table>
<Table><NomeEstacao>SERRA</NomeEstacao><CodEstacao>02246000</CodEstacao><Municipio-UF>CAMPOS DO JORDAO-SP</Municipio-UF><Latitude>-22,74</Latitude><Longitude>-45,59</Longitude><NomeRio>RIO SAPUCAI</NomeRio><StatusEstacao>Ativo</StatusEstacao></Table>
<Table><NomeEstacao>VELHA</NomeEstacao><CodEstacao>01560001</CodEstacao><Municipio-UF>CUIABA-MT</Municipio-UF><Latitude>-15,60</Latitude><Longitude>-56,10</Longitude><NomeRio></NomeRio><StatusEstacao>Inativo</StatusEstacao></Table>
</DataSet>`;

test('registro de fontes inclui qualidade do ar (Open-Meteo AQ)', () => {
  const { origemPara } = require('../api/_lib/origens');
  const aq = origemPara('air-quality-api.open-meteo.com');
  assert.equal(aq.id, 'open-meteo-aq');
  assert.ok(aq.ttlSeg >= 600);
});

test('ANA: default MT (compat), ?uf=SP, ?uf=BR, UF inválida', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = () => Promise.resolve(new Response(ANA_XML, { status: 200 }));
    const d0 = await (await apiHandler(get('ana-hidrologia'))).json();
    assert.equal(d0.uf, 'MT');
    assert.equal(d0.totalEstacoes, 1);
    const sp = await (await apiHandler(get('ana-hidrologia?uf=SP'))).json();
    assert.equal(sp.uf, 'SP');
    assert.equal(sp.estacoes[0].codigo, '02246000');
    const br = await (await apiHandler(get('ana-hidrologia?uf=BR'))).json();
    assert.equal(br.totalEstacoes, 2); // só ativas
    const ruim = await apiHandler(get('ana-hidrologia?uf=XXL'));
    assert.equal(ruim.status, 400);
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
});

/* ---------- INMET-chuva ?uf= (zip mínimo montado à mão) ---------- */
function montarZip(arquivos) {
  // arquivos: [{nome, conteudo}] — deflate, diretório central mínimo.
  const locais = [];
  const centrais = [];
  let off = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const dados = zlib.deflateRawSync(Buffer.from(a.conteudo, 'latin1'));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nome.length, 26);
    locais.push({ off, buf: Buffer.concat([local, nome, dados]) });
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(off, 42);
    centrais.push(Buffer.concat([central, nome]));
    off += 30 + nome.length + dados.length;
  }
  const cdOff = off;
  const cd = Buffer.concat(centrais);
  off += cd.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrais.length, 8);
  eocd.writeUInt16LE(centrais.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOff, 16);
  return Buffer.concat([...locais.map((l) => l.buf), cd, eocd]);
}

const CSV_SP = [
  'CODIGO (WMO): A701;',
  'ESTACAO: SAO PAULO - SP;',
  'LATITUDE:;-23,55;',
  'LONGITUDE:;-46,63;',
  'Data;Hora UTC;PRECIPITACAO TOTAL HORARIO (mm)',
  '2026/10/12;1200 UTC;5,0',
  '2026/10/12;1300 UTC;3,0',
].join('\n');
const CSV_MT = CSV_SP.replace('A701', 'A901').replace('SAO PAULO - SP', 'CUIABA - MT');

test('INMET-chuva: ?uf= filtra arquivos do zip; UF inválida é 400', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    const zip = montarZip([
      { nome: 'INMET_S_SP_A701_2026.CSV', conteudo: CSV_SP },
      { nome: 'INMET_S_MT_A901_2026.CSV', conteudo: CSV_MT },
    ]);
    // Emula servidor com HEAD + HTTP Range (206) como o portal INMET.
    global.fetch = (url, opts = {}) => {
      const metodo = ((opts && opts.method) || 'GET').toUpperCase();
      const range = opts && opts.headers && opts.headers.Range;
      if (metodo === 'HEAD') {
        return Promise.resolve(new Response(null, {
          status: 200, headers: { 'content-length': String(zip.length) },
        }));
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(range || '');
      if (!m) return Promise.reject(new Error('teste: Range esperado'));
      const ini = Number(m[1]);
      const fim = Math.min(Number(m[2]), zip.length - 1);
      const fatia = zip.slice(ini, fim + 1);
      return Promise.resolve(new Response(fatia, {
        status: 206,
        headers: { 'content-range': `bytes ${ini}-${fim}/${zip.length}` },
      }));
    };
    const sp = await (await apiHandler(get('inmet-chuva?ano=2026&uf=SP&refresh=1'))).json();
    assert.equal(sp.uf, 'SP');
    assert.equal(sp.totalEstacoes, 1);
    assert.equal(sp.estacoes[0].codigo.replace(/;$/, ''), 'A701');
    assert.ok(sp.estacoes[0].chuva24h >= 8);
    const mt = await (await apiHandler(get('inmet-chuva?ano=2026&uf=MT&refresh=1'))).json();
    assert.equal(mt.estacoes[0].codigo.replace(/;$/, ''), 'A901');
    const def = await (await apiHandler(get('inmet-chuva?ano=2026&refresh=1'))).json();
    assert.equal(def.uf, 'MT'); // compat: default MT
    const ruim = await apiHandler(get('inmet-chuva?uf=XXL'));
    assert.equal(ruim.status, 400);
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
});

/* ---------- Barragens SNISB ---------- */
const SNISB_JSON = {
  features: [
    { attributes: {
      BAR_CD_SNISB: 123, BAR_NM_NOME: 'REPRESA X', ING_NM_MUNICIPIO: 'CUIABA',
      ING_SG_UFMUNICIPIO: 'MT', BAR_NU_ALT_MAX_BASE_FUNDACAO: 20,
      BAR_NU_CAP_TOTAL_RESERV: 5.5, CATEGORIA_RISCO: 'Alto',
      DANO_POTENCIAL: 'Médio', FASE_DE_VIDA: 'Operação', USO_PRINCIPAL: 'Abastecimento',
      BAR_NU_LATITUDE: -15.6, BAR_NU_LONGITUDE: -56.1,
    } },
    { attributes: { BAR_CD_SNISB: 124, BAR_NM_NOME: 'SEM COORD', ING_SG_UFMUNICIPIO: 'MT' } },
  ],
};

test('Barragens: normaliza, filtra sem-coords, valida UF/bbox', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  let ultimaUrl = '';
  try {
    setupEnv();
    global.fetch = (url) => {
      ultimaUrl = String(url);
      return Promise.resolve(new Response(JSON.stringify(SNISB_JSON), { status: 200 }));
    };
    const r = await apiHandler(get('barragens?uf=MT'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.uf, 'MT');
    assert.equal(j.total, 1); // sem coords cai fora
    assert.equal(j.barragens[0].nome, 'REPRESA X');
    assert.equal(j.barragens[0].cap, 5.5);
    assert.ok(ultimaUrl.includes('ING_SG_UFMUNICIPIO'));
    assert.ok(r.headers.get('cache-control').includes('s-maxage=86400'));
    assert.equal((await apiHandler(get('barragens?uf=XXL'))).status, 400);
    assert.equal((await apiHandler(get('barragens?bbox=1,2,3'))).status, 400);
    const bb = await apiHandler(get('barragens?uf=BR&bbox=-60,-15,-50,-10&limit=5'));
    assert.equal(bb.status, 200);
    assert.ok(ultimaUrl.includes('geometry='));
    global.fetch = () => Promise.resolve(new Response('erro', { status: 500 }));
    assert.equal((await apiHandler(get('barragens?uf=MT'))).status, 502);
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
});

/* ---------- Avisos INMET (CAP) ---------- */
const RSS_FIX = `<?xml version="1.0"?><rss><channel>
<item><title>Aviso de Tempestade. Severidade Grau: Perigo</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/56064</link><description><![CDATA[<table><tr><th>Evento</th><td>Tempestade</td></tr><tr><th>Severidade</th><td>Perigo</td></tr><tr><th>Início</th><td>2000-01-01 00:01:00.0</td></tr><tr><th>Fim</th><td>2099-01-01 23:59:00.0</td></tr><tr><th>Descrição</th><td>Chuva forte.</td></tr><tr><th>Área</th><td>Aviso para as Áreas: Norte MT</td></tr></table>]]></description></item>
<item><title>Aviso futuro. Severidade Grau: Perigo</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/2</link><description><![CDATA[<table><tr><th>Evento</th><td>Tempestade</td></tr><tr><th>Severidade</th><td>Perigo</td></tr><tr><th>Início</th><td>2099-06-01 00:01:00.0</td></tr><tr><th>Fim</th><td>2099-06-02 23:59:00.0</td></tr></table>]]></description></item>
<item><title>Aviso de Onda de Calor. Severidade Grau: Perigo Potencial</title><link>https://apiprevmet3.inmet.gov.br/avisos/rss/1</link><description><![CDATA[<table><tr><th>Evento</th><td>Onda de Calor</td></tr><tr><th>Severidade</th><td>Perigo Potencial</td></tr><tr><th>Início</th><td>2000-01-01 00:01:00.0</td></tr><tr><th>Fim</th><td>2000-01-01 23:59:00.0</td></tr></table>]]></description></item>
</channel></rss>`;
const CAP_FIX = `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><sent>2026-10-13T13:09:28-03:00</sent><info><event>Tempestade</event><severity>Severe</severity><urgency>Future</urgency><certainty>Likely</certainty><onset>2026-10-14T00:01:00-03:00</onset><expires>2026-10-14T23:59:00-03:00</expires><areaDesc>Area X</areaDesc><polygon>-20.0,-50.0 -21.0,-51.0 -20.5,-52.0 -20.0,-50.0</polygon></info></alert>`;

test('Avisos: lista nacional ordenada + detalhe CAP com polígono', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const fetchOrig = global.fetch;
  try {
    setupEnv();
    global.fetch = (url) => Promise.resolve(new Response(
      String(url).includes('/rss/') ? CAP_FIX : RSS_FIX, { status: 200 }
    ));
    const r = await apiHandler(get('avisos'));
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.total, 3);
    const porId = Object.fromEntries(j.avisos.map((a) => [a.id, a]));
    assert.equal(porId['56064'].nivel, 2);
    assert.equal(porId['56064'].vigente, true);
    assert.equal(j.vigentes, 1);
    assert.equal(porId['2'].vigente, false); // ainda não começou: sem modal
    assert.equal(porId['1'].vigente, false); // expirado
    assert.ok(j.avisos.indexOf(porId['1']) > j.avisos.indexOf(porId['56064'])); // severidade ordena
    assert.ok(r.headers.get('cache-control').includes('s-maxage=600'));
    const d = await (await apiHandler(get('avisos?id=56064'))).json();
    assert.equal(d.evento, 'Tempestade');
    assert.deepEqual(d.poligono[0], [-20.0, -50.0]);
    assert.ok(d.poligono.length >= 3);
    assert.equal((await apiHandler(get('avisos?id=abc'))).status, 400);
  } finally {
    global.fetch = fetchOrig;
    restoreEnv(prev);
  }
});
