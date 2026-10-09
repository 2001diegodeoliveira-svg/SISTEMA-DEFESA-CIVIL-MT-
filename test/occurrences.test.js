const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { readCollection, writeCollection } = require('../api/_lib/store');
const occurrenceHandler = require('../api/_routes/occurrences/[id]');
const apiHandler = require('../api/index');
const { demoReset } = require('../api/_lib/demo');

const ENV_KEYS = [
  'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'VERCEL', 'VERCEL_ENV',
  'NODE_ENV', 'FILE_STORE', 'DATABASE_URL', 'KV_REST_API_URL',
  'KV_REST_API_TOKEN', 'SEED_USERS',
];

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

test('ocorrências podem ser consultadas e atualizadas com trilha de auditoria', async () => {
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  let originalOccurrences = [];
  let originalLogs = [];
  let originalUsers = [];
  let storeReady = false;
  const id = `test-occurrence-${Date.now()}`;
  try {
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    process.env.JWT_SECRET = 'dc-mt-dev-secret-change-me';
    process.env.SEED_USERS = JSON.stringify([{ usuario: 'operador', senha: 'test-password', perfil: 'admin' }]);
    demoReset();
    originalOccurrences = await readCollection('occurrences');
    originalLogs = await readCollection('audit_logs');
    originalUsers = await readCollection('users');
    storeReady = true;
    await writeCollection('occurrences', [{
      id,
      source: 'WAZE',
      city: 'Cuiabá',
      status: 'NOVA',
      updatedAt: 1,
    }]);
    await writeCollection('audit_logs', []);
    await writeCollection('users', [{
      id: 'operator-1',
      usuario: 'operador',
      perfil: 'admin',
      ativo: true,
    }]);

    const detailResponse = await apiHandler(request('GET', `occurrences/${id}`));
    assert.equal(detailResponse.status, 200);
    assert.equal((await detailResponse.json()).occurrence.id, id);

    const anonymousResponse = await apiHandler(request('PATCH', `occurrences/${id}`, {
      body: { status: 'EM_ANALISE' },
    }));
    assert.equal(anonymousResponse.status, 401);

    const token = jwt.sign({ sub: 'operator-1', usuario: 'operador', perfil: 'admin' }, process.env.JWT_SECRET);
    const updateResponse = await apiHandler(request('PATCH', `occurrences/${id}`, {
      token,
      body: { status: 'EM_ATENDIMENTO' },
    }));
    assert.equal(updateResponse.status, 200);
    const updated = (await updateResponse.json()).occurrence;
    assert.equal(updated.status, 'EM_ATENDIMENTO');
    assert.ok(updated.updatedAt > 1);

    const saved = await readCollection('occurrences');
    assert.equal(saved.find((item) => item.id === id).status, 'EM_ATENDIMENTO');
    const logs = await readCollection('audit_logs');
    assert.equal(logs[0].metadata.occurrenceId, id);
    assert.equal(logs[0].metadata.previousStatus, 'NOVA');
    assert.equal(logs[0].metadata.status, 'EM_ATENDIMENTO');

    const optionsResponse = await apiHandler(request('OPTIONS', `occurrences/${id}`));
    assert.match(optionsResponse.headers.get('access-control-allow-methods'), /PATCH/);
  } finally {
    if (storeReady) {
      await writeCollection('occurrences', originalOccurrences);
      await writeCollection('audit_logs', originalLogs);
      await writeCollection('users', originalUsers);
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    demoReset();
  }
});

test('atualização recusa status inválido, perfil sem permissão e ocorrência inexistente', async () => {
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  let originalOccurrences = [];
  let originalUsers = [];
  let storeReady = false;
  try {
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'preview';
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    process.env.JWT_SECRET = 'dc-mt-dev-secret-change-me';
    demoReset();
    originalOccurrences = await readCollection('occurrences');
    originalUsers = await readCollection('users');
    storeReady = true;
    await writeCollection('occurrences', [{ id: 'test-invalid-status', status: 'NOVA', city: 'Sinop' }]);

    const commonToken = jwt.sign({ sub: 'common-1', usuario: 'consulta', perfil: 'comum' }, process.env.JWT_SECRET);
    const forbidden = await occurrenceHandler(request('PATCH', 'occurrences/test-invalid-status', {
      token: commonToken,
      body: { status: 'EM_ANALISE' },
    }));
    assert.equal(forbidden.status, 403);

    const adminToken = jwt.sign({ sub: 'operator-1', usuario: 'operador', perfil: 'admin' }, process.env.JWT_SECRET);
    const invalid = await occurrenceHandler(request('PATCH', 'occurrences/test-invalid-status', {
      token: adminToken,
      body: { status: 'INVALIDO' },
    }));
    assert.equal(invalid.status, 400);

    const missing = await occurrenceHandler(request('GET', 'occurrences/not-found'));
    assert.equal(missing.status, 404);

    const municipalToken = jwt.sign({ sub: 'municipal-1', usuario: 'gestor', perfil: 'municipal' }, process.env.JWT_SECRET);
    await writeCollection('users', [{
      id: 'municipal-1',
      usuario: 'gestor',
      perfil: 'municipal',
      municipio: 'Cuiaba',
      ativo: true,
    }]);
    await writeCollection('occurrences', [
      { id: 'municipal-own', status: 'NOVA', city: 'Cuiabá' },
      { id: 'municipal-other', status: 'NOVA', city: 'Sinop' },
    ]);
    const ownUpdate = await occurrenceHandler(request('PATCH', 'occurrences/municipal-own', {
      token: municipalToken,
      body: { status: 'EM_ANALISE' },
    }));
    assert.equal(ownUpdate.status, 200);
    const otherUpdate = await occurrenceHandler(request('PATCH', 'occurrences/municipal-other', {
      token: municipalToken,
      body: { status: 'EM_ANALISE' },
    }));
    assert.equal(otherUpdate.status, 403);
  } finally {
    if (storeReady) {
      await writeCollection('occurrences', originalOccurrences);
      await writeCollection('users', originalUsers);
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    demoReset();
  }
});
