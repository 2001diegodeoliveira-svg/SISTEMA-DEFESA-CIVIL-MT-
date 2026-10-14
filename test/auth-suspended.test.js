const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { validateProductionConfig } = require('../api/_lib/runtime-config');

const FUTURO = '2099-06-01T12:00:00.000Z';
const PASSADO = '2000-01-01T00:00:00.000Z';

function prodEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    JWT_SECRET: 'a-secure-production-secret-with-more-than-32-bytes',
    MFA_ENCRYPTION_KEY: 'b'.repeat(64),
    CORS_ORIGIN: 'https://sgi-protege.example',
    PROXY_HOSTS: 'apiprevmet3.inmet.gov.br',
    AUTH_LOGIN_ENABLED: 'true',
    DEMO_HORAS: '0',
    SEED_USERS: JSON.stringify([{ usuario: 'admin', senha: 'uma-senha-segura-com-12-caracteres', perfil: 'admin' }]),
    DATABASE_URL: 'postgresql://user:password@db.example.test/app',
    FILE_STORE: '0',
    ...overrides,
  };
}

test('suspenso bloqueia login e escrita; token antigo não autoriza', async () => {
  const keys = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'FILE_STORE',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'JWT_SECRET', 'MFA_ENCRYPTION_KEY',
    'SEED_USERS', 'AUTH_LOGIN_ENABLED', 'AUTH_SEED_ONLY', 'AUTH_SUSPENDED',
    'MAINTENANCE_UNTIL', 'DEMO_HORAS'];
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.MFA_ENCRYPTION_KEY = 'c'.repeat(64);
    process.env.SEED_USERS = '';
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.AUTH_SEED_ONLY = 'false';
    process.env.AUTH_SUSPENDED = 'true';
    process.env.MAINTENANCE_UNTIL = FUTURO;
    process.env.DEMO_HORAS = '0';

    const apiHandler = require('../api/index');
    const call = (method, path, body, token) => {
      const headers = {
        origin: 'https://example.test',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      return apiHandler({
        method,
        url: `https://example.test/api/${path}`,
        headers: { ...headers, get: (name) => headers[name.toLowerCase()] || null },
        text: async () => (body ? JSON.stringify(body) : ''),
      });
    };

    const login = await call('POST', 'auth/login', { usuario: 'admin', senha: 'qualquer' });
    assert.equal(login.status, 503);
    assert.match((await login.json()).erro, /suspenso para manutenção/i);

    const leitura = await call('GET', 'gestao?municipio=cuiaba');
    assert.equal(leitura.status, 503);

    const antigo = jwt.sign({ sub: 'U1', usuario: 'admin', perfil: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const comToken = await call('GET', 'gestao?municipio=cuiaba', null, antigo);
    assert.equal(comToken.status, 401);

    const escrita = await call('POST', 'gestao?municipio=cuiaba', { secoes: {} }, antigo);
    assert.equal(escrita.status, 401);

    const me = await call('GET', 'auth/me', null, antigo);
    assert.equal(me.status, 401);

    const demo = await call('GET', 'demo');
    assert.equal(demo.status, 200);
    const estado = await demo.json();
    assert.equal(estado.suspenso, true);
    assert.equal(estado.aberto, false);
    assert.ok(estado.manutencaoAte);
    assert.ok(estado.mensagem);
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('suspensão sem data futura recusa boot em produção', async () => {
  assert.ok(validateProductionConfig(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: '' }))
    .some((p) => p.includes('MAINTENANCE_UNTIL')));
  assert.ok(validateProductionConfig(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: PASSADO }))
    .some((p) => p.includes('MAINTENANCE_UNTIL')));
  assert.ok(validateProductionConfig(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: 'não-é-data' }))
    .some((p) => p.includes('MAINTENANCE_UNTIL')));
  assert.deepEqual(validateProductionConfig(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: FUTURO })), []);
  assert.deepEqual(validateProductionConfig(prodEnv({ AUTH_SUSPENDED: 'false' })), []);

  const keys = Object.keys(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: '' }));
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(prodEnv({ AUTH_SUSPENDED: 'true', MAINTENANCE_UNTIL: '' }))) {
      process.env[k] = v;
    }
    const apiHandler = require('../api/index');
    const res = await apiHandler({ method: 'GET', url: '/api/demo', headers: {} });
    assert.equal(res.status, 503);
    assert.ok((await res.json()).detalhes.some((d) => d.includes('MAINTENANCE_UNTIL')));
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
