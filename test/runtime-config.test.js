const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLoginEnabled, isSeedOnlyLoginEnabled, validateProductionConfig } = require('../api/_lib/runtime-config');
const { isLoginEligible } = require('../api/_lib/auth');
const { corsHeaders } = require('../api/_lib/http');
const apiHandler = require('../api/index');
const { readCollection } = require('../api/_lib/store');
const { writeCollection } = require('../api/_lib/store');
const { demoReset } = require('../api/_lib/demo');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function validProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    JWT_SECRET: 'a-secure-production-secret-with-more-than-32-bytes',
    CORS_ORIGIN: 'https://sgi-protege.example',
    PROXY_HOSTS: 'apiprevmet3.inmet.gov.br,panorama.sipam.gov.br',
    AUTH_LOGIN_ENABLED: 'true',
    DEMO_HORAS: '0',
    SEED_USERS: JSON.stringify([{ usuario: 'admin', senha: 'uma-senha-segura-com-12-caracteres', perfil: 'admin' }]),
    DATABASE_URL: 'postgresql://user:password@db.example.test/app',
    FILE_STORE: '0',
    WAZE_MOCK_ENABLED: '0',
    TOMTOM_MOCK_ENABLED: '0',
    ...overrides,
  };
}

test('produção aceita ambiente com segredo, origens, proxy, seed e banco explícitos', () => {
  assert.deepEqual(validateProductionConfig(validProductionEnv()), []);
});

test('Vercel em produção recusa padrões demo e sem persistência', () => {
  const problems = validateProductionConfig(validProductionEnv({
    JWT_SECRET: 'dc-mt-dev-secret-change-me',
    CORS_ORIGIN: '*',
    PROXY_HOSTS: '',
    SEED_USERS: '',
    DATABASE_URL: '',
  }));

  assert.ok(problems.some((problem) => problem.includes('JWT_SECRET')));
  assert.ok(problems.some((problem) => problem.includes('CORS_ORIGIN')));
  assert.ok(problems.some((problem) => problem.includes('PROXY_HOSTS')));
  assert.ok(problems.some((problem) => problem.includes('SEED_USERS')));
  assert.ok(problems.some((problem) => problem.includes('DATABASE_URL')));
});

test('produção recusa mocks ativos e integração sem credencial', () => {
  const problems = validateProductionConfig(validProductionEnv({
    TOMTOM_MOCK_ENABLED: 'true',
    WAZE_ENABLED: 'true',
    WAZE_FEED_URL: '',
  }));

  assert.ok(problems.some((problem) => problem.includes('TOMTOM_MOCK_ENABLED')));
  assert.ok(problems.some((problem) => problem.includes('WAZE_FEED_URL')));
});

test('produção recusa senha de bootstrap acima do limite do bcrypt', () => {
  const problems = validateProductionConfig(validProductionEnv({
    SEED_USERS: JSON.stringify([{ usuario: 'admin', senha: 'a'.repeat(73), perfil: 'admin' }]),
  }));

  assert.ok(problems.some((problem) => problem.includes('10 a 72 bytes UTF-8')));
});

test('produção aceita senha de bootstrap com 10 bytes e recusa senhas menores', () => {
  const seed = (senha) => JSON.stringify([{ usuario: 'admin', senha, perfil: 'admin' }]);
  assert.deepEqual(validateProductionConfig(validProductionEnv({
    SEED_USERS: seed('a'.repeat(10)),
  })), []);
  assert.ok(validateProductionConfig(validProductionEnv({
    SEED_USERS: seed('a'.repeat(9)),
  })).some((problem) => problem.includes('10 a 72 bytes UTF-8')));
});

test('desenvolvimento mantém os padrões locais', () => {
  assert.deepEqual(validateProductionConfig({ NODE_ENV: 'development' }), []);
});

test('login só é habilitado por configuração explícita', () => {
  assert.equal(isLoginEnabled({}), false);
  assert.equal(isLoginEnabled({ AUTH_LOGIN_ENABLED: 'false' }), false);
  assert.equal(isLoginEnabled({ AUTH_LOGIN_ENABLED: 'true' }), true);
});

test('modo seed-only permite apenas a conta configurada e preserva cadastros existentes', () => {
  const keys = ['AUTH_SEED_ONLY', 'SEED_USERS'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const existingAccount = {
    id: 'existing-user', usuario: 'usuario-aprovado', perfil: 'municipal',
    ativo: true, cadastroId: 'REG-1',
  };
  try {
    process.env.AUTH_SEED_ONLY = 'true';
    process.env.SEED_USERS = JSON.stringify([{ usuario: 'dev', perfil: 'admin' }]);
    assert.equal(isSeedOnlyLoginEnabled(), true);
    assert.equal(isLoginEligible({ id: 'seed-admin', usuario: 'DEV', perfil: 'admin', ativo: true }), true);
    assert.equal(isLoginEligible({ id: 'old-admin', usuario: 'outro-admin', perfil: 'admin', ativo: true, bootstrapAdmin: true }), false);
    assert.equal(isLoginEligible(existingAccount), false);
    assert.equal(existingAccount.ativo, true);
    assert.equal(existingAccount.cadastroId, 'REG-1');
    process.env.AUTH_SEED_ONLY = 'false';
    assert.equal(isSeedOnlyLoginEnabled(), false);
    assert.equal(isLoginEligible(existingAccount), true);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('handler da API falha fechado com HTTP 503 se produção está incompleta', async () => {
  const keys = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'JWT_SECRET', 'CORS_ORIGIN', 'PROXY_HOSTS', 'SEED_USERS', 'DATABASE_URL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL = '1';
    process.env.VERCEL_ENV = 'production';
    for (const key of keys.slice(3)) delete process.env[key];

    const response = await apiHandler(new Request('https://example.test/api/alertas'));
    assert.equal(response.status, 503);
    assert.match((await response.json()).erro, /não configurado para produção/i);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('handler Vercel aceita headers do Node e aplica a origem CORS permitida', async () => {
  const env = validProductionEnv();
  const keys = new Set([...Object.keys(env), 'NODE_ENV', 'VERCEL', 'VERCEL_ENV']);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const response = await apiHandler({
      method: 'OPTIONS',
      url: '/api/alertas',
      headers: { origin: 'https://sgi-protege.example' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sgi-protege.example');
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('produção retorna manutenção para login suspenso mesmo sem admin seedado', async () => {
  const env = validProductionEnv({ SEED_USERS: '' });
  const keys = new Set([...Object.keys(env), 'NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'AUTH_LOGIN_ENABLED']);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    process.env.AUTH_LOGIN_ENABLED = 'false';
    const response = await apiHandler({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://sgi-protege.example', 'content-type': 'application/json' },
      text: async () => JSON.stringify({ usuario: 'admin', senha: 'nao-usada' }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { erro: 'Login temporariamente suspenso para manutenção.' });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rota protegida permite operações sem token durante a suspensão do login', async () => {
  const keys = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'AUTH_LOGIN_ENABLED', 'DEMO_HORAS'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    process.env.AUTH_LOGIN_ENABLED = 'false';
    process.env.DEMO_HORAS = '0';
    const response = await apiHandler({ method: 'GET', url: '/api/user-registrations', headers: {} });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray((await response.json()).registrations));
    const protectedWrite = await apiHandler({
      method: 'POST',
      url: '/api/pluv-alerta',
      headers: { 'content-type': 'application/json' },
      text: async () => JSON.stringify({}),
    });
    assert.equal(protectedWrite.status, 400);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rota serverless propaga CORS com headers Node e serve alertas sem fetch externo', async () => {
  const env = validProductionEnv();
  const keys = new Set([...Object.keys(env), 'NODE_ENV', 'VERCEL', 'VERCEL_ENV']);
  const previous = new Map([...keys].map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const response = await apiHandler({
      method: 'GET',
      url: '/api/alertas?inmet=0',
      headers: { origin: 'https://sgi-protege.example' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://sgi-protege.example');
    assert.ok(Array.isArray((await response.json()).alertas));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('CORS reflete apenas origens explicitamente autorizadas', () => {
  const previous = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://dc.example,https://admin.example';
  try {
    assert.equal(corsHeaders('https://dc.example')['Access-Control-Allow-Origin'], 'https://dc.example');
    assert.equal(corsHeaders('https://outside.example')['Access-Control-Allow-Origin'], undefined);
  } finally {
    if (previous === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = previous;
  }
});

test('proxy não segue redirecionamentos nem aceita respostas maiores que o limite', async () => {
  const previousFetch = global.fetch;
  let fetchOptions;
  try {
    global.fetch = async (_url, options) => {
      fetchOptions = options;
      return new Response('redirect', {
        status: 302,
        headers: { location: 'http://127.0.0.1/private' },
      });
    };
    const redirectResponse = await apiHandler({
      method: 'GET',
      url: 'https://example.test/api/proxy?url=https%3A%2F%2Ftrusted.example%2Fdata',
      headers: { origin: undefined },
    });
    assert.equal(fetchOptions.redirect, 'manual');
    assert.equal(redirectResponse.status, 502);

    global.fetch = async () => new Response('large', {
      headers: { 'content-length': String(10 * 1024 * 1024 + 1) },
    });
    const oversizedResponse = await apiHandler({
      method: 'GET',
      url: 'https://example.test/api/proxy?url=https%3A%2F%2Ftrusted.example%2Fdata',
      headers: { origin: undefined },
    });
    assert.equal(oversizedResponse.status, 502);
    assert.deepEqual(await oversizedResponse.json(), { erro: 'Falha ao buscar a origem.' });
  } finally {
    global.fetch = previousFetch;
  }
});

test('store não transforma indisponibilidade do KV em coleção vazia', async () => {
  const keys = ['DATABASE_URL', 'FILE_STORE', 'VERCEL', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;
  try {
    delete process.env.DATABASE_URL;
    delete process.env.FILE_STORE;
    delete process.env.VERCEL;
    process.env.KV_REST_API_URL = 'https://kv.example.test';
    process.env.KV_REST_API_TOKEN = 'test-token';
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(readCollection('runtime-config-test'), /kv get:503/);
  } finally {
    global.fetch = previousFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('solicitação pública fica pendente e só cria conta após aprovação administrativa', async () => {
  const keys = ['DATABASE_URL', 'FILE_STORE', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'JWT_SECRET', 'SEED_USERS', 'AUTH_LOGIN_ENABLED', 'DEMO_HORAS'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.DATABASE_URL;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
    process.env.SEED_USERS = '';
    process.env.AUTH_LOGIN_ENABLED = 'true';
    process.env.DEMO_HORAS = '0';

    const pendingUsername = `solicitante${Date.now()}`;
    const request = (path, method, body, token) => {
      const headers = {
        origin: 'https://example.test',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      };
      return apiHandler({
        method,
        url: `https://example.test/api/${path}`,
        headers: { ...headers, get: (name) => headers[name.toLowerCase()] || null },
        text: async () => body ? JSON.stringify(body) : '',
      });
    };
    await writeCollection('users', [{
      id: 'legacy-user', usuario: 'old-user', senhaHash: bcrypt.hashSync('old-user-pass', 4),
      nome: 'Conta demo', perfil: 'admin', ativo: false, cadastroId: null,
    }]);
    const demoLogin = await request('auth/login', 'POST', { usuario: 'old-user', senha: 'old-user-pass' });
    assert.equal(demoLogin.status, 401);
    const legacyToken = jwt.sign({ sub: 'legacy-user', perfil: 'admin', usuario: 'old-user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const revokedSession = await request('auth/me', 'GET', null, legacyToken);
    assert.equal(revokedSession.status, 401);

    process.env.SEED_USERS = JSON.stringify([{
      usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin', nome: 'Administrador de Testes', perfil: 'admin',
    }]);

    const loginAdmin = await request('auth/login', 'POST', { usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin' });
    const adminPayload = await loginAdmin.json();
    assert.equal(loginAdmin.status, 200);
    assert.ok(adminPayload.token, 'login válido deve emitir o token de sessão');
    assert.equal(adminPayload.desafio, undefined);
    assert.equal(adminPayload.exigeTotp, undefined);
    assert.equal(adminPayload.user.perfil, 'admin');

    const adminSession = await request('auth/me', 'GET', null, adminPayload.token);
    assert.equal(adminSession.status, 200);

    const seededUsers = await readCollection('users');
    const seededAdmin = seededUsers.find((user) => user.usuario === 'bootstrap-admin');
    seededAdmin.otp = { secret: 'LEGACY_TOTP_SECRET', ativo: true };
    await writeCollection('users', seededUsers);
    const legacyTotpLogin = await request('auth/login', 'POST', { usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin' });
    const legacyTotpPayload = await legacyTotpLogin.json();
    assert.equal(legacyTotpLogin.status, 200);
    assert.ok(legacyTotpPayload.token, 'dados TOTP legados não devem bloquear o login');

    const removedTotpRoute = await request('auth/totp/verify', 'POST', { codigo: '000000' });
    assert.equal(removedTotpRoute.status, 404);

    const invalidLongPassword = await request('user-registrations', 'POST', {
      usuario: pendingUsername,
      senha: 'é'.repeat(37),
      nome: 'Solicitante Teste',
      email: `${pendingUsername}@example.test`,
      cpf: '529.982.247-25',
      perfil: 'Estadual',
      estado: 'MT',
      nivel: 'Gestao',
      orgao: 'SGI PROTEGE Teste',
      declaracao: true,
    });
    assert.equal(invalidLongPassword.status, 400);
    assert.match((await invalidLongPassword.json()).erro, /72 bytes UTF-8/);

    const registrationResponse = await request('user-registrations', 'POST', {
      usuario: pendingUsername,
      senha: 'senha-segura-com-12',
      nome: 'Solicitante Teste',
      email: `${pendingUsername}@example.test`,
      cpf: '529.982.247-25',
      perfil: 'Estadual',
      estado: 'MT',
      nivel: 'Gestao',
      orgao: 'SGI PROTEGE Teste',
      declaracao: true,
      role: 'admin',
      perfilSistema: 'admin',
      status: 'Aprovado',
      senhaHash: 'hash-forjado-pelo-cliente',
      parecer: 'Aprovado sem análise',
    });
    const registrationPayload = await registrationResponse.json();
    assert.equal(registrationResponse.status, 201);
    assert.equal(registrationPayload.registration.status, 'Pendente');
    assert.equal(registrationPayload.registration.perfilSistema, undefined);
    assert.equal(registrationPayload.registration.parecer, '');
    assert.equal('senhaHash' in registrationPayload.registration, false);

    const edited = await request(`user-registrations/${encodeURIComponent(registrationPayload.registration.id)}`, 'PUT', {
      nome: 'Solicitante Atualizado', email: `${pendingUsername}@example.test`, cpf: '529.982.247-25',
      perfil: 'Estadual', estado: 'MT', nivel: 'Gestao', orgao: 'SGI PROTEGE Teste', declaracao: true,
    }, adminPayload.token);
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).registration.nome, 'Solicitante Atualizado');

    const pendingLogin = await request('auth/login', 'POST', { usuario: pendingUsername, senha: 'senha-segura-com-12' });
    assert.equal(pendingLogin.status, 401);

    const listDenied = await request('user-registrations', 'GET');
    assert.equal(listDenied.status, 401);
    const approval = await request(`user-registrations/${encodeURIComponent(registrationPayload.registration.id)}`, 'PATCH', {
      status: 'Aprovado', nivel: 'Consulta', parecer: 'Acesso aprovado para o teste.',
    }, adminPayload.token);
    assert.equal(approval.status, 200);

    const approvedLogin = await request('auth/login', 'POST', { usuario: pendingUsername.toUpperCase(), senha: 'senha-segura-com-12' });
    const approvedPayload = await approvedLogin.json();
    assert.equal(approvedLogin.status, 200);
    assert.equal(approvedPayload.user.perfil, 'comum');
    assert.ok(approvedPayload.token);
    assert.notEqual(approvedPayload.user.perfil, 'admin');

    const commonConfigChange = await request('pluv-alerta', 'POST', { ativo: false }, approvedPayload.token);
    assert.equal(commonConfigChange.status, 403);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('produção recusa DATABASE_URL apontando para localhost', () => {
  const problems = validateProductionConfig(validProductionEnv({
    DATABASE_URL: 'postgresql://user:password@127.0.0.1:5432/app',
  }));

  assert.ok(problems.some((problem) => problem.includes('PostgreSQL remoto')));
});

async function comAmbienteDemo(rodar) {
  const keys = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'FILE_STORE',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'AUTH_LOGIN_ENABLED', 'DEMO_HORAS'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.NODE_ENV = 'test';
    process.env.FILE_STORE = '0';
    process.env.AUTH_LOGIN_ENABLED = 'true';
    await rodar();
  } finally {
    demoReset();
    /* Limpa no driver em memória antes de restaurar o ambiente real. */
    delete process.env.DATABASE_URL;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.FILE_STORE = '0';
    try { await writeCollection('system_config', []); } catch { /* sem armazenamento */ }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('janela de demonstração libera a API sem token e expira exigindo login', async () => {
  await comAmbienteDemo(async () => {
    process.env.DEMO_HORAS = '24';
    demoReset();
    await writeCollection('system_config', []);

    const aberta = await apiHandler({ method: 'GET', url: '/api/demo', headers: {} });
    assert.equal(aberta.status, 200);
    const estado = await aberta.json();
    assert.equal(estado.habilitado, true);
    assert.equal(estado.aberto, true);
    assert.equal(estado.loginHabilitado, true);
    assert.ok(estado.inicio > 0);

    const liberada = await apiHandler({ method: 'GET', url: '/api/user-registrations', headers: {} });
    assert.equal(liberada.status, 200);
    assert.ok(Array.isArray((await liberada.json()).registrations));

    /* Primeiro acesso registrado a 25h atrás: janela vencida. */
    const config = await readCollection('system_config');
    await writeCollection('system_config', config.map((item) => item.id === 'demo'
      ? { ...item, inicio: Date.now() - 25 * 3600000 }
      : item));
    demoReset();

    const expirada = await apiHandler({ method: 'GET', url: '/api/demo', headers: {} });
    const estadoExpirado = await expirada.json();
    assert.equal(estadoExpirado.aberto, false);
    assert.equal(estadoExpirado.restanteMs, 0);

    const bloqueada = await apiHandler({ method: 'GET', url: '/api/user-registrations', headers: {} });
    assert.equal(bloqueada.status, 401);

    const sessao = await apiHandler({ method: 'GET', url: '/api/auth/me', headers: {} });
    assert.equal(sessao.status, 401);
  });
});

test('DEMO_HORAS=0 desliga a janela e as rotas protegidas exigem token desde o início', async () => {
  await comAmbienteDemo(async () => {
    process.env.DEMO_HORAS = '0';
    demoReset();
    await writeCollection('system_config', []);

    const consulta = await apiHandler({ method: 'GET', url: '/api/demo', headers: {} });
    const estado = await consulta.json();
    assert.equal(estado.habilitado, false);
    assert.equal(estado.aberto, false);

    const bloqueada = await apiHandler({ method: 'GET', url: '/api/user-registrations', headers: {} });
    assert.equal(bloqueada.status, 401);
  });
});

test('sessão liberada da janela de demonstração não exige usuário no banco', async () => {
  await comAmbienteDemo(async () => {
    process.env.DEMO_HORAS = '1';
    demoReset();
    await writeCollection('system_config', []);

    const me = await apiHandler({ method: 'GET', url: '/api/auth/me', headers: {} });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.perfil, 'admin');

    const { verifyToken, isSessaoLiberada } = require('../api/_lib/auth');
    const payload = verifyToken('token-invalido');
    assert.equal(isSessaoLiberada(payload), true);
    assert.equal(payload.perfil, 'admin');
  });
});