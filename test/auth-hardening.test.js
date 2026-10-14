const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionConfig, isJwtExpValid } = require('../api/_lib/runtime-config');
const { ipDaRequisicao } = require('../api/_lib/rate-limit');
const { encryptSecret, decryptSecret, createSecret } = require('../api/_lib/mfa');

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

/* CRIPTO-01: AUTH off + seed em produção deve falhar fechado no CI. */
test('CRIPTO-01: AUTH_LOGIN_ENABLED=false com SEED_USERS em prod é recusado', () => {
  const problems = validateProductionConfig(prodEnv({ AUTH_LOGIN_ENABLED: 'false' }));
  assert.ok(problems.some((p) => p.includes('AUTH_LOGIN_ENABLED') && p.includes('SEED_USERS')));
});

test('CRIPTO-01: modo manutenção sem seed continua permitido (fluxo intencional)', () => {
  const problems = validateProductionConfig(prodEnv({ AUTH_LOGIN_ENABLED: 'false', SEED_USERS: '' }));
  assert.ok(!problems.some((p) => p.includes('SEED_USERS')));
});

/* CRIPTO-03: JWT_EXP allowlist com teto de 24h. */
test('CRIPTO-03: JWT_EXP inválido ou acima de 24h é recusado em prod', () => {
  assert.equal(isJwtExpValid('12h'), true);
  assert.equal(isJwtExpValid('15m'), true);
  assert.equal(isJwtExpValid('24h'), true);
  assert.equal(isJwtExpValid('never'), false);
  assert.equal(isJwtExpValid('48h'), false);
  assert.equal(isJwtExpValid(''), false);
  assert.ok(validateProductionConfig(prodEnv({ JWT_EXP: 'never' })).some((p) => p.includes('JWT_EXP')));
  assert.ok(validateProductionConfig(prodEnv({ JWT_EXP: '48h' })).some((p) => p.includes('JWT_EXP')));
  assert.deepEqual(validateProductionConfig(prodEnv({})), []);
});

test('CRIPTO-03: session token nunca carrega purpose; challenge só aceita mfa_*', () => {
  const { signToken, signChallengeToken } = require('../api/_lib/auth');
  const user = { id: 'U1', usuario: 'admin', perfil: 'admin' };
  assert.throws(() => signToken(user, { purpose: 'mfa_login' }), /purpose/);
  assert.throws(() => signChallengeToken(user, 'admin'), /purpose/);
  const setup = signChallengeToken(user, 'mfa_setup');
  const login = signChallengeToken(user, 'mfa_login');
  assert.ok(setup && login);
});

/* CRIPTO-02: senha gigante rejeitada antes do hash (400 no login). */
test('CRIPTO-02: login com senha de 1MB retorna 400 imediato', async () => {
  const keys = ['NODE_ENV', 'FILE_STORE', 'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'SEED_USERS', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.MFA_ENCRYPTION_KEY = 'c'.repeat(64);
    process.env.SEED_USERS = '';
    const apiHandler = require('../api/index');
    const big = 'a'.repeat(1024 * 1024);
    const res = await apiHandler({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ usuario: 'admin', senha: big }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).erro, /72 bytes/);
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('CRIPTO-02: usuário inválido responde 401 genérico igual ao válido', async () => {
  const keys = ['NODE_ENV', 'FILE_STORE', 'AUTH_LOGIN_ENABLED', 'DEMO_HORAS', 'JWT_SECRET', 'MFA_ENCRYPTION_KEY', 'SEED_USERS'];
  const previous = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';
    process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.MFA_ENCRYPTION_KEY = 'c'.repeat(64);
    process.env.SEED_USERS = JSON.stringify([{ usuario: 'real-admin', senha: 'senha-forte-com-12+', perfil: 'admin' }]);
    const apiHandler = require('../api/index');
    const call = (usuario) => apiHandler({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', get: () => null },
      text: async () => JSON.stringify({ usuario, senha: 'senha-errada-123' }),
    });
    const r1 = await call('usuario-inexistente-xyz');
    const r2 = await call('real-admin');
    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.deepEqual(await r1.json(), { erro: 'Credenciais inválidas.' });
    assert.deepEqual(await r2.json(), { erro: 'Credenciais inválidas.' });
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

/* CRIPTO-04: AES-256-GCM com nonce único; tag adulterada falha fechado. */
test('CRIPTO-04: encryptSecret nunca reutiliza nonce e tag adulterada falha', () => {
  const key = 'd'.repeat(64);
  const secret = createSecret();
  const a = encryptSecret(secret, key);
  const b = encryptSecret(secret, key);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(decryptSecret(a, key), secret);
  const tampered = { ...a, tag: Buffer.from('AAAAAAAAAAAAAAAAAAAAAA==', 'base64').toString('base64') };
  assert.throws(() => decryptSecret(tampered, key));
});

/* CRIPTO-05: header forjado sem proxy confiável não reseta o bucket. */
test('CRIPTO-05: x-forwarded-for forjado é ignorado sem TRUSTED_PROXIES', () => {
  const prev = process.env.TRUSTED_PROXIES;
  try {
    delete process.env.TRUSTED_PROXIES;
    const forged = { headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress: '10.0.0.5' } };
    const other = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.equal(ipDaRequisicao(forged), '10.0.0.5');
    assert.equal(ipDaRequisicao(other), '10.0.0.5');
    process.env.TRUSTED_PROXIES = '10.0.0.5';
    assert.equal(ipDaRequisicao(forged), '9.9.9.9');
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_PROXIES;
    else process.env.TRUSTED_PROXIES = prev;
  }
});
