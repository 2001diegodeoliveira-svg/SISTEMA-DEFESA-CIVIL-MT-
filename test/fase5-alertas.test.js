/* ============================================================
   Testes da Fase 5 (alertas ativos).
   Motor com fetchers injetados (sem rede), CRUD de áreas,
   avaliar com cron secret, reconhecer, push e webhook Telegram.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const motor = require('../api/_lib/motor');
const apiHandler = require('../api/index');
const { demoReset } = require('../api/_lib/demo');
const { readCollection, writeCollection } = require('../api/_lib/store');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'VERCEL', 'VERCEL_ENV',
  'NODE_ENV', 'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'SEED_USERS', 'ALERTAS_CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_MAP_URL',
];

function setupEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.NODE_ENV = 'test';
  process.env.FILE_STORE = '0';
  process.env.JWT_SECRET = 'dc-mt-dev-secret-change-me';
  process.env.AUTH_LOGIN_ENABLED = 'true';
  process.env.DEMO_HORAS = '0';
  process.env.SEED_USERS = JSON.stringify([{ usuario: 'gestor', senha: 'test-password', perfil: 'admin' }]);
  demoReset();
}
async function snapshot() {
  return {
    system: await readCollection('system_config'),
    audit: await readCollection('audit_logs'),
    users: await readCollection('users'),
  };
}
async function restore(snap) {
  await writeCollection('system_config', snap.system);
  await writeCollection('audit_logs', snap.audit);
  await writeCollection('users', snap.users);
}
function restoreEnv(prev) {
  for (const [k, v] of prev) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  demoReset();
}
function request(method, path, { token, body } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`http://localhost/api/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function adminToken() {
  // mfa:true = sessão com multifator verificado (exigido p/ coordenadores)
  return jwt.sign({ sub: 'gestor-1', usuario: 'gestor', perfil: 'admin', mfa: true }, process.env.JWT_SECRET);
}
async function seedGestor() {
  await writeCollection('users', [{
    id: 'gestor-1', usuario: 'gestor', nome: 'Gestor Teste',
    perfil: 'admin', ativo: true, senhaHash: 'x',
  }]);
}
const AREA = {
  id: 'area-teste',
  nome: 'Área Teste',
  bbox: { minLat: -16, maxLat: -15, minLon: -57, maxLon: -56 },
  coords: [[-16, -57], [-16, -56], [-15, -56], [-15, -57]],
  uf: 'MT',
  regras: [{ tipo: 'foco_novo' }, { tipo: 'chuva_24h', mm: 10 }, { tipo: 'aviso_inmet' }, { tipo: 'estacao_pane' }],
  canais: { push: false, telegram: false, telegramChats: [] },
};
const BUSCAR = {
  focosDoDia: () => Promise.resolve([
    { lat: -15.5, lon: -56.5, data: 'x', satelite: 'S', municipio: 'C', estado: 'MATO GROSSO' },
    { lat: -10, lon: -50, data: 'x', satelite: 'S', municipio: 'F', estado: 'X' },
  ]),
  avisos: () => Promise.resolve([{ id: '1', evento: 'Tempestade', severidade: 'Perigo', nivel: 2, vigente: true }]),
  avisoDetalhe: () => Promise.resolve({ poligono: [[-15.5, -56.5], [-15.4, -56.5], [-15.4, -56.4], [-15.5, -56.5]] }),
  chuva24h: () => Promise.resolve(42),
  estacoes: () => Promise.resolve([
    { VL_LATITUDE: '-15.5', VL_LONGITUDE: '-56.5', CD_SITUACAO: 'Pane', DC_NOME: 'E1', CD_ESTACAO: 'A1' },
    { VL_LATITUDE: '-15.5', VL_LONGITUDE: '-56.5', CD_SITUACAO: 'Operante', DC_NOME: 'E2', CD_ESTACAO: 'A2' },
  ]),
  limiarChuvaGlobal: () => Promise.resolve(30),
};

test('geometria: bbox, ponto-no-polígono e parser CSV', () => {
  assert.deepEqual(motor.bboxDaArea(AREA), AREA.bbox);
  assert.equal(motor.bboxDaArea({}), null);
  assert.ok(motor.emBbox(-15.5, -56.5, AREA.bbox));
  assert.ok(!motor.emBbox(-10, -50, AREA.bbox));
  assert.ok(motor.emPoligono(-15.5, -56.5, AREA.coords));
  assert.ok(!motor.emPoligono(-10, -50, AREA.coords));
  assert.ok(motor.emPoligono(0, 0, null)); // sem polígono: vale o bbox
  const rows = motor.parseFocosCSV('lat,lon,data_hora_gmt,satelite,municipio,estado\n-15.5,-56.5,x,S,C,MG\nruim\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, -15.5);
});

test('avaliarArea dispara os 4 tipos e dedup evita recriar', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    const r1 = await motor.avaliarArea(AREA, BUSCAR, { snaps: {} });
    assert.equal(r1.erros.length, 0);
    const tipos = r1.eventos.map((e) => e.tipo).sort();
    assert.deepEqual(tipos, ['aviso_inmet', 'chuva_24h', 'estacao_pane', 'foco_novo']);
    assert.ok(r1.eventos.every((e) => e.dedup && e.severidade));
    const n1 = await motor.registrarEventos(AREA, r1.eventos);
    assert.equal(n1.length, 4);
    const n2 = await motor.registrarEventos(AREA, r1.eventos);
    assert.equal(n2.length, 0); // dedup: nada novo
    // chuva abaixo do limiar não dispara
    const r3 = await motor.avaliarArea(
      { ...AREA, id: 'a2', regras: [{ tipo: 'chuva_24h', mm: 100 }] },
      { ...BUSCAR, chuva24h: () => Promise.resolve(5) }, { snaps: {} }
    );
    assert.equal(r3.eventos.length, 0);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('areas-monitoradas: CRUD com auth e validação', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    await seedGestor();
    const anon = await apiHandler(request('POST', 'areas-monitoradas', { body: { nome: 'X' } }));
    assert.equal(anon.status, 401);
    const token = adminToken();
    const semNome = await apiHandler(request('POST', 'areas-monitoradas', { token, body: {} }));
    assert.equal(semNome.status, 400);
    const regraRuim = await apiHandler(request('POST', 'areas-monitoradas', {
      token, body: { nome: 'X', bbox: AREA.bbox, regras: [{ tipo: 'raio' }] },
    }));
    assert.equal(regraRuim.status, 400);
    const cria = await apiHandler(request('POST', 'areas-monitoradas', {
      token, body: { nome: 'Rondonópolis', bbox: AREA.bbox, uf: 'MT', regras: [{ tipo: 'chuva_24h', mm: 50 }] },
    }));
    assert.equal(cria.status, 201);
    const id = (await cria.json()).area.id;
    const lista = await apiHandler(request('GET', 'areas-monitoradas'));
    assert.equal((await lista.json()).total, 1);
    const altera = await apiHandler(request('PUT', `areas-monitoradas?id=${id}`, {
      token, body: { nome: 'Rondonópolis 2', bbox: AREA.bbox },
    }));
    assert.equal((await altera.json()).area.nome, 'Rondonópolis 2');
    const apaga = await apiHandler(request('DELETE', `areas-monitoradas?id=${id}`, { token }));
    assert.equal(apaga.status, 200);
    const vazio = await apiHandler(request('GET', 'areas-monitoradas'));
    assert.equal((await vazio.json()).total, 0);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('avaliar exige cron secret ou gestor; fila e reconhecer funcionam', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.ALERTAS_CRON_SECRET = 'segredo-teste';
    await writeCollection('system_config', []);
    await seedGestor();
    const semAuth = await apiHandler(request('POST', 'alertas-motor/avaliar', { body: {} }));
    assert.equal(semAuth.status, 401);
    const errada = await apiHandler(request('POST', 'alertas-motor/avaliar', { token: 'errado', body: {} }));
    assert.equal(errada.status, 401);
    // sem áreas: 200 sem rede (nenhum fetcher chamado)
    const vazia = await apiHandler(request('POST', 'alertas-motor/avaliar', { token: 'segredo-teste', body: {} }));
    assert.equal(vazia.status, 200);
    assert.equal((await vazia.json()).criados, 0);
    // cria evento direto e testa fila + reconhecer
    const novos = await motor.registrarEventos(AREA, [{
      tipo: 'foco_novo', severidade: 'alto', titulo: 'T', detalhe: 'D', dados: {}, dedup: 'k1',
    }]);
    const fila = await apiHandler(request('GET', 'alertas-motor/eventos?tipo=foco_novo'));
    assert.equal((await fila.json()).total, 1);
    const semToken = await apiHandler(request('POST', 'alertas-motor/reconhecer', { body: { id: novos[0].id } }));
    assert.equal(semToken.status, 401);
    const rec = await apiHandler(request('POST', 'alertas-motor/reconhecer', {
      token: adminToken(), body: { id: novos[0].id },
    }));
    assert.equal((await rec.json()).evento.estado, 'reconhecido');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('push: config sem VAPID, inscrição válida/inválida; telegram sem token falha suave', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await writeCollection('system_config', []);
    const cfg = await apiHandler(request('GET', 'push/config'));
    assert.equal((await cfg.json()).ativo, false);
    const ruim = await apiHandler(request('POST', 'push/subscrever', { body: { subscription: {} } }));
    assert.equal(ruim.status, 400);
    const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } };
    const ok = await apiHandler(request('POST', 'push/subscrever', { body: { subscription: sub } }));
    assert.equal(ok.status, 201);
    const pushLib = require('../api/_lib/push');
    const envio = await pushLib.enviarPush([sub], { title: 't' });
    assert.equal(envio[0].ok, false); // sem VAPID: falha registrada, sem throw
    const telegram = require('../api/_lib/telegram');
    const t = await telegram.enviarMensagem('123', 'oi');
    assert.equal(t.ok, false); // sem token: falha suave
    assert.equal(t.canal, 'telegram');
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});

test('telegram webhook: /start registra, secret errada nega, /status responde', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.TELEGRAM_WEBHOOK_SECRET = 'whseg';
    await writeCollection('system_config', []);
    const mkReq = (text, secret = 'whseg') => new Request('http://localhost/api/telegram/webhook', {
      method: 'POST',
      headers: new Headers({ 'x-telegram-bot-api-secret-token': secret, 'content-type': 'application/json' }),
      body: JSON.stringify({ message: { chat: { id: 99, type: 'private' }, text } }),
    });
    const negado = await apiHandler(mkReq('/start', 'errado'));
    assert.equal(negado.status, 403);
    const start = await apiHandler(mkReq('/start'));
    assert.equal(start.status, 200);
    const col = await readCollection('system_config');
    assert.ok(col.find((d) => d.id === 'telegram-chats').lista.some((c) => String(c.id) === '99'));
    const status = await apiHandler(mkReq('/status'));
    assert.equal(status.status, 200);
  } finally {
    await restore(snap);
    restoreEnv(prev);
  }
});
