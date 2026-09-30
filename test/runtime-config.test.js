const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionConfig } = require('../api/_lib/runtime-config');
const { corsHeaders } = require('../api/_lib/http');
const apiHandler = require('../api/index');
const { readCollection } = require('../api/_lib/store');
const { writeCollection } = require('../api/_lib/store');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { signToken } = require('../api/_lib/auth');
/* O provider é carregado sob demanda (otplib v13 é ESM) — mesmo caminho da API. */
const gerarCodigoTotp = async (segredo) => {
  const lib = await import('otplib');
  return lib.generateSync({ secret: segredo });
};

function validProductionEnv(overrides = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    JWT_SECRET: 'a-secure-production-secret-with-more-than-32-bytes',
    CORS_ORIGIN: 'https://defesacivil.mt.gov.br',
    PROXY_HOSTS: 'apiprevmet3.inmet.gov.br,panorama.sipam.gov.br',
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

  assert.ok(problems.some((problem) => problem.includes('12 a 72 bytes UTF-8')));
});

test('desenvolvimento mantém os padrões locais', () => {
  assert.deepEqual(validateProductionConfig({ NODE_ENV: 'development' }), []);
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
      headers: { origin: 'https://defesacivil.mt.gov.br' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://defesacivil.mt.gov.br');
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
      headers: { origin: 'https://defesacivil.mt.gov.br' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://defesacivil.mt.gov.br');
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
  const keys = ['DATABASE_URL', 'FILE_STORE', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'JWT_SECRET', 'SEED_USERS'];
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
      id: 'legacy-defense', usuario: 'defesa', senhaHash: bcrypt.hashSync('defesa123', 4),
      nome: 'Conta demo', perfil: 'admin', ativo: false, cadastroId: null,
    }]);
    const demoLogin = await request('auth/login', 'POST', { usuario: 'defesa', senha: 'defesa123' });
    assert.equal(demoLogin.status, 401);
    const legacyToken = jwt.sign({ sub: 'legacy-defense', perfil: 'admin', usuario: 'defesa' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const revokedSession = await request('auth/me', 'GET', null, legacyToken);
    assert.equal(revokedSession.status, 401);

    process.env.SEED_USERS = JSON.stringify([{
      usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin', nome: 'Administrador de Testes', perfil: 'admin',
    }]);

    /* O 2FA é obrigatório: o login só devolve o desafio e a sessão só é
       emitida depois de confirmar o código do Google Authenticator. */
    const completeSecondFactor = async (loginRes) => {
      const payload = await loginRes.json();
      assert.equal(payload.token, undefined, 'o login não pode emitir token antes do 2FA');
      assert.equal(payload.exigeTotp, true);
      assert.ok(payload.desafio);
      assert.equal(payload.setup, true, 'conta nova deve começar no setup do QR');

      const setupRes = await request('auth/totp/setup', 'POST', { desafio: payload.desafio });
      const setup = await setupRes.json();
      assert.equal(setupRes.status, 200);
      assert.ok(setup.qr);
      assert.ok(setup.segredo);

      const codigo = await gerarCodigoTotp(setup.segredo);
      assert.match(codigo, /^\d{6}$/);
      const activateRes = await request('auth/totp/activate', 'POST', { desafio: payload.desafio, codigo });
      const activate = await activateRes.json();
      assert.equal(activateRes.status, 200);
      assert.ok(activate.token, 'a ativação válida deve concluir o primeiro login');
      return { ...activate, segredo: setup.segredo };
    };

    const loginAdmin = await request('auth/login', 'POST', { usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin' });
    assert.equal(loginAdmin.status, 200);
    const adminPayload = await completeSecondFactor(loginAdmin);

    // Segundo login da mesma conta já exige apenas o código (sem novo QR).
    const relogin = await request('auth/login', 'POST', { usuario: 'bootstrap-admin', senha: 'senha-forte-para-admin' });
    const reloginPayload = await relogin.json();
    assert.equal(relogin.status, 200);
    assert.equal(reloginPayload.setup, false, 'conta já vinculada não deve pedir setup');
    const wrongCode = await request('auth/totp/verify', 'POST', { desafio: reloginPayload.desafio, codigo: '000000' });
    assert.equal(wrongCode.status, 401);
    const verified = await request('auth/totp/verify', 'POST', {
      desafio: reloginPayload.desafio,
      codigo: await gerarCodigoTotp(adminPayload.segredo),
    });
    const verifiedPayload = await verified.json();
    assert.equal(verified.status, 200);
    assert.ok(verifiedPayload.token);

    const invalidLongPassword = await request('user-registrations', 'POST', {
      usuario: pendingUsername,
      senha: 'é'.repeat(37),
      nome: 'Solicitante Teste',
      email: `${pendingUsername}@example.test`,
      cpf: '529.982.247-25',
      perfil: 'Estadual',
      estado: 'MT',
      nivel: 'Gestao',
      orgao: 'Defesa Civil Teste',
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
      orgao: 'Defesa Civil Teste',
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
      perfil: 'Estadual', estado: 'MT', nivel: 'Gestao', orgao: 'Defesa Civil Teste', declaracao: true,
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
    assert.notEqual(approvedPayload.user.perfil, 'admin');

    const commonToken = signToken(approvedPayload.user);
    const commonConfigChange = await request('pluv-alerta', 'POST', { ativo: false }, commonToken);
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