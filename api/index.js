/* ============================================================
   Roteador central (single serverless function — Hobby max 12).
   Todas as rotas /api/* são atendidas por ESTA função, que
   despacha para os handlers em ./_routes conforme o caminho.
   ============================================================ */
const { serve } = require('./_lib/serverless');
const { corsHeaders, bearerToken } = require('./_lib/http');
const { isLoginEnabled, validateProductionConfig } = require('./_lib/runtime-config');
const { verifyToken, isLoginEligible, isSessaoLiberada } = require('./_lib/auth');
const { demoAtualizar, demoAberto } = require('./_lib/demo');
const { readCollection, loadUserAccess, driver } = require('./_lib/store');
const { runWithDbContext } = require('./_lib/db-context');
const { apiPolicy, canAccessPolicy, databaseRolesForUser, isCoordinator } = require('./_lib/access-control');

function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    if (value != null) return value;
  }
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value.join(', ') : (value == null ? undefined : String(value));
}

const handlers = {
  'demo': require('./_routes/demo'),
  'auth/login': require('./_routes/auth/login'),
  'auth/logout': require('./_routes/auth/logout'),
  'auth/me': require('./_routes/auth/me'),
  'user-registrations': require('./_routes/user-registrations'),
  'alertas': require('./_routes/alertas'),
  'areas': require('./_routes/areas'),
  'occurrences': require('./_routes/occurrences'),
  'reports': require('./_routes/reports'),
  'proxy': require('./_routes/proxy'),
  'waze': require('./_routes/waze'),
  'tomtom': require('./_routes/tomtom'),
  'gestao': require('./_routes/gestao'),
  'noticias': require('./_routes/noticias'),
  'inmet-chuva': require('./_routes/inmet-chuva'),
  'ana-hidrologia': require('./_routes/ana-hidrologia'),
  'pluv-alerta': require('./_routes/pluv-alerta'),
  'pluv-alerta/avaliar': require('./_routes/pluv-alerta-avaliar'),
  'enso': require('./_routes/enso'),
  'enso/avaliar': require('./_routes/enso-avaliar'),
};

const areasIdHandler = require('./_routes/areas/[id]');
const occurrencesIdHandler = require('./_routes/occurrences/[id]');

/* Extrai { route, query } a partir do req.url.
   A Vercel preserva o URL original E adiciona "?path=" com a rota;
   o Express (server.js) passa URLs absolutas; o runtime clássico
   usa "/api/<rota>?queries". Devolve a rota normalizada e a query
   string original limpa (sem o param "path" injetado pela Vercel). */
function parseRoute(req) {
  let raw = String(req && req.url ? req.url : '');
  const abs = raw.match(/^https?:\/\//i);
  let pathQuery = '';
  if (abs) {
    try {
      const u = new URL(raw);
      raw = u.pathname;
      pathQuery = u.searchParams.get('path') || '';
    } catch { /* mantém raw */ }
  } else {
    const qi = raw.indexOf('?');
    if (qi >= 0) {
      const pm = raw.slice(qi + 1).match(/path=([^&]*)/);
      if (pm) pathQuery = decodeURIComponent(pm[1]);
      raw = raw.slice(0, qi);
    }
  }

  let route;
  if (pathQuery) route = pathQuery.split('/').filter(Boolean).join('/');
  else {
    const clean = raw.split('#')[0].replace(/^\/+/, '').replace(/\/+$/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts[0] === 'api') parts.shift();
    if (parts[0] === 'index') parts.shift();
    route = parts.join('/');
  }

  /* Query original (ex: visao=geral, ano=2026, municipio=, action=).
     Na Vercel está anexada ao mesmo req.url original; no Express vem
     de req.url absoluto. Remove o param "path" antes de repassar. */
  let query = '';
  try {
    const u = new URL(req.url, 'http://localhost');
    u.searchParams.delete('path');
    query = u.searchParams.toString();
  } catch { /* sem query */ }

  return { route, query };
}

module.exports = serve(async function handler(req) {
  const origin = readHeader(req.headers, 'origin');

  const configProblems = validateProductionConfig();
  if (configProblems.length) {
    return new Response(JSON.stringify({ erro: 'Backend não configurado para produção.', detalhes: configProblems }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const { route, query } = parseRoute(req);
  const routeKey = route.startsWith('user-registrations/') ? 'user-registrations' :
    route.replace(/\/(enroll|confirm|verify)$/, '');
  const production = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  const loginEnabled = isLoginEnabled();
  /* Registra/consulta o marco do primeiro acesso e mantém a janela de
     demonstração em cache para os handlers que autorizam por token. */
  await demoAtualizar();
  const acessoAberto = demoAberto();
  let configuredAdmin = false;
  try {
    const seeds = JSON.parse(process.env.SEED_USERS || '[]');
    configuredAdmin = Array.isArray(seeds) && seeds.some((user) => user && user.perfil === 'admin');
  } catch {}
  if (production && loginEnabled && !configuredAdmin) {
    try {
      const users = await runWithDbContext(
        { operation: 'authentication' },
        () => readCollection('users')
      );
      if (!users.some((user) => user.perfil === 'admin' && isLoginEligible(user))) {
        return new Response(JSON.stringify({
          erro: 'Backend não configurado para produção.',
          detalhes: ['Configure um administrador ativo via SEED_USERS ou promova um bootstrap admin persistido.'],
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    } catch (error) {
      // Registra o motivo real (sem credenciais) para diagnóstico nos logs.
      console.error('[bootstrap-admin] falha ao consultar o banco:', error && error.message);
      return new Response(JSON.stringify({
        erro: 'Backend não configurado para produção.',
        detalhes: ['Banco persistente indisponível para validar o administrador bootstrap.'],
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  let user = null;
  let access = null;
  let requestContext = loginEnabled
    ? { operation: 'public', isPublic: true }
    : { operation: 'service' };
  let routeAccess = null;

  const isMfaRoute = route.startsWith('auth/mfa/');
  if (route === 'auth/login') {
    requestContext = { operation: 'authentication' };
  } else if (route === 'user-registrations' && req.method === 'POST' && !payload) {
    requestContext = { operation: 'public_registration', isPublic: true };
  } else if (payload && loginEnabled && !isSessaoLiberada(payload)) {
    const isChallenge = payload.purpose === 'mfa_login' || payload.purpose === 'mfa_setup';
    if (isChallenge && !isMfaRoute) {
      return new Response(JSON.stringify({ erro: 'Conclua a verificação multifator antes de continuar.', mfaRequired: true }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
    const identityContext = { userId: payload.sub, operation: isMfaRoute ? 'mfa' : 'identity' };
    if (!isChallenge) {
      user = await runWithDbContext(identityContext, async () => {
        const users = await readCollection('users');
        return users.find(item => String(item.id) === String(payload.sub)) || null;
      });
      if (!isLoginEligible(user)) {
        return new Response(JSON.stringify({ erro: 'Conta suspensa ou sem cadastro aprovado.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    } else if (!isMfaRoute) {
      return new Response(JSON.stringify({ erro: 'Desafio multifator inválido.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    } else {
      user = await runWithDbContext(identityContext, async () => {
        const users = await readCollection('users');
        return users.find(item => String(item.id) === String(payload.sub)) || null;
      });
      if (!isLoginEligible(user)) {
        return new Response(JSON.stringify({ erro: 'Conta suspensa ou sem cadastro aprovado.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    if (driver() === 'pg') {
      try {
        access = await runWithDbContext(identityContext, () => loadUserAccess(payload.sub));
      } catch (error) {
        console.error('[rbac] não foi possível carregar escopo organizacional:', error.message);
        return new Response(JSON.stringify({
          erro: 'Controle de acesso indisponível. Verifique a migração da Fase 3.',
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }

    const roles = databaseRolesForUser(user, access);
    const requiresMfa = isCoordinator(user, access);
    if (requiresMfa && payload.mfa !== true && !isMfaRoute) {
      return new Response(JSON.stringify({
        erro: 'Autenticação multifator obrigatória.',
        mfaRequired: true,
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    requestContext = {
      userId: payload.sub,
      organizationIds: access && access.organizationIds,
      directOrganizationIds: access && access.directOrganizationIds,
      writableOrganizationIds: access && access.writableOrganizationIds,
      operation: isMfaRoute ? 'mfa' : (route.startsWith('user-registrations') ? 'registration_approval' : 'request'),
    };
    routeAccess = {
      authenticated: true,
      roles,
      access: access || { organizationIds: [], directOrganizationIds: [], writableOrganizationIds: [], roles },
      requiresMfa,
      user,
      mfaVerified: payload.mfa === true,
    };
  } else if (loginEnabled && !acessoAberto && !payload && route !== 'auth/login' &&
      route !== 'auth/me' && route !== 'auth/logout' && route !== 'demo' &&
      !(route === 'user-registrations' && req.method === 'POST')) {
    const policy = apiPolicy(routeKey, req.method);
    if (!policy.public) {
      return new Response(JSON.stringify({ erro: 'Autenticação necessária.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }
  }

  if (route === '') {
    return new Response(JSON.stringify({ erro: 'API SGI PROTEGE.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }

  /* Request clonado com URL canônica "/api/<rota>?<query original>".
     Garante que os sub-handlers leiam id do pathname e queries corretos
     tanto no Express quanto na Vercel. */
  const clone = { method: req.method };
  clone.url = '/api/' + route + (query ? '?' + query : '');
  const authorization = readHeader(req.headers, 'authorization') ||
    (loginEnabled && !acessoAberto ? undefined : 'Bearer access-without-login');
  clone.headers = {
    get: (name) => name.toLowerCase() === 'authorization'
      ? authorization || null
      : readHeader(req.headers, name) || null,
  };
  clone.accessContext = routeAccess;
  if (typeof req.text === 'function') clone.text = req.text.bind(req);
  if (typeof req.json === 'function') clone.json = req.json.bind(req);

  let target = null;
  if (handlers[route]) target = handlers[route];
  else if (route.startsWith('auth/mfa/')) target = require('./_routes/auth/mfa');
  else if (route.startsWith('user-registrations/')) target = handlers['user-registrations'];
  else {
    const m = route.match(/^areas\/([^/]+)$/);
    if (m) target = areasIdHandler;
    else if (/^occurrences\/[^/]+$/.test(route)) target = occurrencesIdHandler;
  }

  if (target) {
    if (loginEnabled && !acessoAberto && !isSessaoLiberada(payload)) {
      const policy = apiPolicy(routeKey, req.method);
      if (!canAccessPolicy(policy, routeAccess)) {
        return new Response(JSON.stringify({ erro: 'Seu papel não permite executar esta operação.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        });
      }
    }
    const operation = route === 'auth/login'
      ? 'authentication'
      : route.startsWith('user-registrations') && routeAccess
        ? 'registration_approval'
        : route.startsWith('auth/mfa/')
          ? 'mfa'
        : routeContextOperation(route, req.method, requestContext.operation);
    requestContext.operation = operation;
    return runWithDbContext(requestContext, () => target(clone));
  }

  return new Response(JSON.stringify({ erro: 'Rota não encontrada: /api/' + route }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });

  function routeContextOperation(route, method, fallback) {
    if (route.startsWith('auth/mfa/')) return 'mfa';
    if (route === 'user-registrations' && method === 'POST') return 'public_registration';
    return fallback;
  }
});