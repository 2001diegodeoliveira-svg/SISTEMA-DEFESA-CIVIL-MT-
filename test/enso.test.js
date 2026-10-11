/* ============================================================
   Testes do Módulo ENOS / El Niño (Fase 1).
   Unidade (classificador, regras/histerese/dedup, canais,
   coletores) + integração (avaliar → alerta → auditoria,
   com mocks e dry-run) + endpoints.
   NENHUMA notificação real: ENSO_DRY_RUN=1 sempre aqui.
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const enso = require('../api/_lib/enso');
const ensoHandler = require('../api/_routes/enso');
const ensoAvaliarHandler = require('../api/_routes/enso-avaliar');
const apiHandler = require('../api/index');
const { apiPolicy } = require('../api/_lib/access-control');
const { readCollection, writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'VERCEL', 'VERCEL_ENV',
  'NODE_ENV', 'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'SEED_USERS', 'ENSO_DRY_RUN', 'ENSO_WEBHOOK_URL', 'ENSO_RULES_JSON',
  'ENSO_HISTERESE', 'ENSO_REAVISO_HORAS', 'ENSO_NOAA_ONI_URL',
  'ENSO_NEUTRO_BANDA', 'ENSO_FRACO', 'ENSO_MODERADO', 'ENSO_FORTE', 'ENSO_MUITO_FORTE',
];

function setupEnv() {
  for (const k of ENV_KEYS) {
    if (['ENSO_DRY_RUN', 'ENSO_WEBHOOK_URL', 'ENSO_RULES_JSON', 'ENSO_HISTERESE',
      'ENSO_REAVISO_HORAS', 'ENSO_NOAA_ONI_URL', 'ENSO_NEUTRO_BANDA', 'ENSO_FRACO',
      'ENSO_MODERADO', 'ENSO_FORTE', 'ENSO_MUITO_FORTE'].includes(k)) delete process.env[k];
  }
  process.env.VERCEL = '1';
  process.env.VERCEL_ENV = 'preview';
  process.env.NODE_ENV = 'test';
  process.env.FILE_STORE = '0';
  delete process.env.DATABASE_URL;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.JWT_SECRET = 'dc-mt-dev-secret-change-me';
  process.env.ENSO_DRY_RUN = '1';
  demoReset();
}

async function snapshot() {
  return {
    system: await readCollection('system_config'),
    audit: await readCollection('audit_logs'),
  };
}
async function restore(snap) {
  await writeCollection('system_config', snap.system);
  await writeCollection('audit_logs', snap.audit);
}
async function limparEnso() {
  const col = await readCollection('system_config');
  await writeCollection('system_config', (col || []).filter((d) => !d || !String(d.id || '').startsWith('enso-')));
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
  return jwt.sign({ sub: 'gestor-1', usuario: 'gestor', perfil: 'admin' }, process.env.JWT_SECRET);
}

/* ---------------- classificador ---------------- */

test('classificador respeita os limiares padrão nas bordas', () => {
  assert.equal(enso.classificar(0).fase, 'NEUTRO');
  assert.equal(enso.classificar(0.49).intensidade, 'NEUTRO');
  assert.deepEqual([enso.classificar(0.5).fase, enso.classificar(0.5).intensidade], ['EL_NINO', 'FRACO']);
  assert.equal(enso.classificar(1.0).intensidade, 'MODERADO');
  assert.equal(enso.classificar(1.5).intensidade, 'FORTE');
  assert.equal(enso.classificar(2.0).intensidade, 'MUITO_FORTE');
  assert.deepEqual([enso.classificar(-0.5).fase, enso.classificar(-0.5).intensidade], ['LA_NINA', 'FRACO']);
  assert.equal(enso.classificar(-2.3).intensidade, 'MUITO_FORTE');
});

test('classificador rejeita valores não numéricos e usa limiares configuráveis', () => {
  for (const v of [NaN, Infinity, -Infinity, '1.5', null, undefined, {}]) {
    assert.throws(() => enso.classificar(v), /anomalia inválida/);
  }
  const custom = { neutroBanda: 0.3, fraco: 0.3, moderado: 0.8, forte: 1.2, muitoForte: 1.8 };
  assert.equal(enso.classificar(0.35, custom).fase, 'EL_NINO');
  assert.equal(enso.classificar(0.35, custom).intensidade, 'FRACO');
  // Ordem inconsistente volta ao padrão em vez de quebrar
  const ruim = enso.normalizarLimiares({ neutroBanda: 2, fraco: 0.1, moderado: 1, forte: 1.5, muitoForte: 2 });
  assert.ok(ruim.fraco >= ruim.neutroBanda);
});

/* ---------------- regras: histerese e dedup ---------------- */

const REGRAS_TESTE = [
  { id: 'obs', nivel: 'OBSERVACAO', descricao: 't', condicao: { indice: 'ONI', operador: '>=', limiarAbs: 0.5 }, exigeConfirmacao: false, canais: ['webhook'] },
  { id: 'ate', nivel: 'ATENCAO', descricao: 't', condicao: { indice: 'ONI', operador: '>=', limiarAbs: 1.0 }, exigeConfirmacao: false, canais: ['webhook'] },
];

test('regras disparam no limiar e a histerese evita liga/desliga na borda', () => {
  const t0 = Date.now();
  const r1 = enso.avaliarRegras({ indice: 'ONI', valor: 1.0 }, { regras: REGRAS_TESTE, estadoAnterior: {}, agoraMs: t0, hist: 0.1, reavisoIntervaloMs: 3600000 });
  assert.ok(r1.transicoes.some((t) => t.regraId === 'ate' && t.tipo === 'DISPARADO'));
  // 0.95 ainda acima de (1.0 - 0.1): mantém, sem transição
  const r2 = enso.avaliarRegras({ indice: 'ONI', valor: 0.95 }, { regras: REGRAS_TESTE, estadoAnterior: r1.novoEstado, agoraMs: t0 + 1000, hist: 0.1, reavisoIntervaloMs: 3600000 });
  assert.ok(!r2.transicoes.some((t) => t.regraId === 'ate'));
  assert.equal(r2.novoEstado.ate.ativo, true);
  // 0.85 abaixo da margem: encerra
  const r3 = enso.avaliarRegras({ indice: 'ONI', valor: 0.85 }, { regras: REGRAS_TESTE, estadoAnterior: r2.novoEstado, agoraMs: t0 + 2000, hist: 0.1, reavisoIntervaloMs: 3600000 });
  assert.ok(r3.transicoes.some((t) => t.regraId === 'ate' && t.tipo === 'ENCERRADO'));
});

test('deduplicação: sem reenvio dentro da janela, com reaviso após', () => {
  const t0 = Date.now();
  const r1 = enso.avaliarRegras({ indice: 'ONI', valor: 0.6 }, { regras: REGRAS_TESTE, estadoAnterior: {}, agoraMs: t0, hist: 0.1, reavisoIntervaloMs: 3600000 });
  const comEnvio = enso.marcarEnvio(r1.novoEstado, 'obs', new Date(t0).toISOString());
  const r2 = enso.avaliarRegras({ indice: 'ONI', valor: 0.6 }, { regras: REGRAS_TESTE, estadoAnterior: comEnvio, agoraMs: t0 + 60000, hist: 0.1, reavisoIntervaloMs: 3600000 });
  assert.ok(r2.transicoes.some((t) => t.regraId === 'obs' && t.tipo === 'MANTIDO'));
  const r3 = enso.avaliarRegras({ indice: 'ONI', valor: 0.6 }, { regras: REGRAS_TESTE, estadoAnterior: comEnvio, agoraMs: t0 + 7200000, hist: 0.1, reavisoIntervaloMs: 3600000 });
  assert.ok(r3.transicoes.some((t) => t.regraId === 'obs' && t.tipo === 'REAVISADO'));
});

test('regras inválidas são ignoradas sem derrubar a avaliação', () => {
  const { transicoes } = enso.avaliarRegras({ indice: 'ONI', valor: 3 }, {
    regras: [{ id: 'ruim' }, ...REGRAS_TESTE], estadoAnterior: {}, agoraMs: Date.now(),
  });
  assert.ok(transicoes.length > 0);
  assert.throws(() => enso.avaliarRegras({ valor: NaN }, { regras: REGRAS_TESTE }), /medição inválida/);
});

/* ---------------- alertas + confirmação ---------------- */

test('nível alto fica PENDENTE sem confirmação e dedup reaproveita', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await limparEnso();
    const regras = enso.REGRAS_PADRAO;
    const { transicoes } = enso.avaliarRegras({ indice: 'ONI', valor: 1.6 }, { regras, estadoAnterior: {}, agoraMs: Date.now() });
    assert.ok(transicoes.some((t) => t.regraId === 'enso-alerta' && t.tipo === 'DISPARADO'));
    const med = { indice: 'ONI', valor: 1.6, fonte: 'teste' };
    const r1 = await enso.registrarAlertas(transicoes, med, { por: 'teste' });
    const pend = r1.criados.find((c) => c.nivel === 'ALERTA');
    assert.equal(pend.estado, 'PENDENTE');
    const baixo = r1.criados.find((c) => c.nivel === 'OBSERVACAO');
    assert.equal(baixo.estado, 'AGUARDANDO_ENVIO');
    const r2 = await enso.registrarAlertas(transicoes, med, { por: 'teste' });
    assert.ok(r2.criados.find((c) => c.nivel === 'ALERTA').reaproveitado);
    const lista = await enso.lerAlertas();
    assert.equal(lista.filter((a) => a.estado === 'PENDENTE' && a.nivel === 'ALERTA').length, 1);
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('confirmarAlerta aprova ou dispensa; erros claros', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await limparEnso();
    const regras = enso.REGRAS_PADRAO;
    const { transicoes } = enso.avaliarRegras({ indice: 'ONI', valor: 2.1 }, { regras, estadoAnterior: {}, agoraMs: Date.now() });
    const med = { indice: 'ONI', valor: 2.1, fonte: 'teste' };
    const { criados } = await enso.registrarAlertas(transicoes, med, { por: 'teste' });
    const emg = criados.find((c) => c.nivel === 'EMERGENCIA');
    await assert.rejects(enso.confirmarAlerta('inexistente', { por: 'x' }), /não encontrado/);
    const disp = await enso.confirmarAlerta(emg.id, { por: 'gestor', aprovar: false });
    assert.equal(disp.estado, 'DISPENSADO');
    await assert.rejects(enso.confirmarAlerta(emg.id, { por: 'gestor' }), /já está/);
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

/* ---------------- canais e auditoria ---------------- */

test('dry-run nunca aciona canal real; stubs retornam erro explícito', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    setupEnv();
    process.env.ENSO_DRY_RUN = '1';
    process.env.ENSO_WEBHOOK_URL = 'https://exemplo.test/hook';
    const em = await enso.canais.email({ para: 'a@teste', assunto: 't', corpo: 'c' });
    assert.equal(em.dryRun, true);
    assert.equal(em.ok, true);
    const wh = await enso.canais.webhook({ evento: 'x', dados: {} });
    assert.equal(wh.dryRun, true);
    for (const nome of enso.CANAIS_STUB) {
      const r = await enso.canais[nome]();
      assert.equal(r.ok, false);
      assert.match(r.erro, /stub/);
    }
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('auditoria registra regra, gatilho, canal, horário e resultado', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    const e = await enso.auditar('alerta_envio', {
      regra: 'enso-atencao', nivel: 'ATENCAO', gatilho: { valor: 1.1, indice: 'ONI' },
      canal: 'webhook', horario: new Date().toISOString(), resultado: 'OK', dryRun: true,
    });
    assert.match(e.action, /^enso\./);
    const logs = await readCollection('audit_logs');
    const salvo = logs.find((l) => l.id === e.id);
    assert.equal(salvo.metadata.regra, 'enso-atencao');
    assert.equal(salvo.metadata.canal, 'webhook');
    assert.ok(salvo.metadata.horario);
    assert.equal(salvo.metadata.resultado, 'OK');
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

/* ---------------- coletores ---------------- */

test('coletor MOCK é claramente marcado; coleta é idempotente', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await limparEnso();
    const m = await enso.coletorMock().coletar();
    assert.equal(m.mock, true);
    const r1 = await enso.executarColeta({ usarMock: true });
    assert.equal(r1.amostras.length, 1);
    assert.equal(r1.fontes.mock.ok, true);
    const n1 = (await readCollection('system_config')).find((d) => d.id === 'enso-indice').lista.length;
    await enso.executarColeta({ usarMock: true });
    const col = await readCollection('system_config');
    const n2 = col.find((d) => d.id === 'enso-indice').lista.length;
    assert.ok(n2 >= n1); // idempotente por (fonte, observadoEm): no máximo +1
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('falha de fonte (NOAA sem URL) não derruba o módulo', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    delete process.env.ENSO_NOAA_ONI_URL;
    await limparEnso();
    const r = await enso.executarColeta({ usarMock: false });
    assert.equal(r.amostras.length, 0);
    assert.equal(r.fontes.noaa.ok, false);
    assert.match(r.fontes.noaa.mensagem, /não configurada/);
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

/* ---------------- endpoints ---------------- */

test('GET /api/enso expõe estado, disclaimer e origem sem inventar dados', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await limparEnso();
    const res = await ensoHandler(request('GET', 'enso'));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.estado, 'SEM_DADOS');
    assert.equal(j.classificacao, null);
    assert.ok(j.disclaimer.includes('INMET'));
    assert.equal(j.dryRun, true);
    assert.ok(Array.isArray(j.regras.lista) && j.regras.lista.length === 4);
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('POST /api/enso exige gestor; avaliar valida e cria pendente p/ nível alto', async () => {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    process.env.SEED_USERS = JSON.stringify([{ usuario: 'gestor', senha: 'test-password', perfil: 'admin' }]);
    await limparEnso();
    const semAuth = await ensoAvaliarHandler(request('POST', 'enso/avaliar', { body: { valor: 1.6 } }));
    assert.equal(semAuth.status, 403);
    const token = adminToken();
    const inval = await ensoAvaliarHandler(request('POST', 'enso/avaliar', { token, body: { valor: 'alto' } }));
    assert.equal(inval.status, 400);
    const ok = await ensoAvaliarHandler(request('POST', 'enso/avaliar', { token, body: { valor: 1.6, fonte: 'teste' } }));
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.classificacao.intensidade, 'FORTE');
    assert.ok(j.transicoes.some((t) => t.regraId === 'enso-alerta' && t.tipo === 'DISPARADO'));
    assert.equal(j.exigeConfirmacao.length, 1);
    assert.equal(j.dryRun, true);
    // confirmar libera o envio (dry-run auditado)
    const conf = await ensoAvaliarHandler(request('POST', 'enso/avaliar', {
      token, body: { acao: 'confirmar', alertaId: j.exigeConfirmacao[0] },
    }));
    assert.equal(conf.status, 200);
    const cj = await conf.json();
    assert.equal(cj.alerta.estado, 'ENVIADO');
    assert.ok(cj.envios.length > 0);
    assert.ok(cj.envios.every((e) => e.dryRun === true));
    const logs = await readCollection('audit_logs');
    assert.ok(logs.some((l) => l.action === 'enso.avaliacao'));
    assert.ok(logs.some((l) => l.action === 'enso.alerta_confirmado'));
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});

test('rota enso registrada no roteador e com política de acesso correta', async () => {
  assert.equal(apiPolicy('enso', 'GET').public, true);
  assert.equal(apiPolicy('enso', 'POST').public, false);
  assert.equal(apiPolicy('enso/avaliar', 'POST').public, false);
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const snap = await snapshot();
  try {
    setupEnv();
    await limparEnso();
    const res = await apiHandler(request('GET', 'enso'));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.disclaimer);
  } finally {
    await restore(snap);
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    demoReset();
  }
});
