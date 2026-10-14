/* ============================================================
   Autenticação — JWT + senha com hash (bcryptjs).
  Bootstrap opcional de admin via SEED_USERS; usuários comuns exigem cadastro aprovado.
   ============================================================ */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { readCollection, writeCollection } = require('./store');
const { isLoginEnabled, isSeedOnlyLoginEnabled, isSuspended, resolveJwtExp } = require('./runtime-config');
const { demoAberto } = require('./demo');

function getJwtSecret() {
  return process.env.JWT_SECRET || 'dc-mt-dev-secret-change-me';
}

function getJwtExp() {
  return resolveJwtExp(process.env.JWT_EXP);
}

/* bcrypt trunca em 72 bytes; senhas maiores devem ser rejeitadas antes do
   compare para não travar o event loop (express.json aceita até 1 MB). */
const MAX_PASSWORD_BYTES = 72;

/* Hash dummy de custo equivalente (12) para equalizar o tempo quando o
   usuário não existe ou não é elegível — mitiga oráculo de tempo sem
   vazar se o usuário é válido. Gerado offline, nunca é um segredo. */
const DUMMY_HASH = '$2a$12$fhxUB9AYxOCBRDn7n9L9QuFlLSq4jy2OixrdqkjD6IlIzNFHY0882';
const DUMMY_PASSWORD = 'dummy-password-for-timing-mitigation';

function seedUsers() {
  try {
    const users = JSON.parse(process.env.SEED_USERS || '[]');
    return Array.isArray(users) ? users : [];
  } catch {}
  return [];
}

async function ensureSeededUsers() {
  const users = await readCollection('users');
  const configuredAdmins = seedUsers().filter((user) => user.perfil === 'admin' && user.usuario && user.senha);
  let changed = false;
  for (const configured of configuredAdmins) {
    const index = users.findIndex((user) => String(user.usuario).toLowerCase() === String(configured.usuario).toLowerCase());
    const existing = index >= 0 ? users[index] : null;
    if (existing && existing.ativo !== false && existing.perfil === 'admin' && existing.senhaHash) {
      try {
        if (await bcrypt.compare(configured.senha, existing.senhaHash)) continue;
      } catch { /* hash inválido: recria abaixo */ }
    }
    const account = {
      ...(existing || {}),
      id: existing ? existing.id : 'U' + (users.length + 1),
      usuario: configured.usuario,
      senhaHash: await bcrypt.hash(configured.senha, 12),
      nome: configured.nome || existing && existing.nome || '',
      perfil: 'admin',
      municipio: configured.municipio || '',
      ativo: true,
      cadastroId: null,
      criadoEm: existing && existing.criadoEm || new Date().toISOString(),
    };
    if (index >= 0) users[index] = account;
    else users.push(account);
    changed = true;
  }
  if (changed) await writeCollection('users', users);
  return users;
}

async function dummyCompare() {
  try {
    await bcrypt.compare(DUMMY_PASSWORD, DUMMY_HASH);
  } catch { /* nunca deve falhar; tempo equivalente é o que importa */ }
}

async function findByCredentials(usuario, senha) {
  const users = await ensureSeededUsers();
  const normalizedUsername = String(usuario || '').trim().toLowerCase();
  const u = users.find((user) => String(user.usuario || '').trim().toLowerCase() === normalizedUsername);
  /* Caminho quente assíncrono com tempo equivalente: usuário inexistente ou
     inelegível executa um compare dummy antes do 401 genérico. */
  if (!isLoginEligible(u)) {
    await dummyCompare();
    return null;
  }
  if (typeof senha !== 'string' || Buffer.byteLength(senha, 'utf8') > MAX_PASSWORD_BYTES) {
    await dummyCompare();
    return null;
  }
  let ok = false;
  try {
    ok = await bcrypt.compare(senha, u.senhaHash);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  return u;
}

function isLoginEligible(user) {
  if (!user || user.ativo === false) return false;
  if (isSeedOnlyLoginEnabled()) {
    return seedUsers().some((seed) =>
      seed && String(seed.usuario || '').trim().toLowerCase() === String(user.usuario || '').trim().toLowerCase() &&
      String(seed.perfil || '').toLowerCase() === String(user.perfil || '').toLowerCase()
    );
  }
  if (user.perfil === 'admin') {
    return user.bootstrapAdmin === true || seedUsers().some((seed) => seed.perfil === 'admin' &&
      String(seed.usuario).toLowerCase() === String(user.usuario).toLowerCase());
  }
  if (user.ativo === true) return true;
  if (user.cadastroId) return true;
  return Boolean(user.senhaHash || user.senha);
}

const findOrProvisionUser = findByCredentials;

function signToken(user, claims = {}) {
  /* CRIPTO-03: session token nunca carrega purpose (amarração exclusiva dos
     challenge tokens). Se um caller passar purpose, é erro de programação. */
  if (claims && Object.prototype.hasOwnProperty.call(claims, 'purpose')) {
    throw new Error('Session token must not carry a purpose.');
  }
  return jwt.sign(
    { sub: user.id, usuario: user.usuario, perfil: user.perfil, ...claims },
    getJwtSecret(),
    { expiresIn: getJwtExp() }
  );
}

function signChallengeToken(user, purpose) {
  if (!['mfa_setup', 'mfa_login'].includes(purpose)) {
    throw new Error('Unknown challenge purpose.');
  }
  return jwt.sign(
    { sub: user.id, usuario: user.usuario, perfil: user.perfil, purpose },
    getJwtSecret(),
    { expiresIn: '5m' }
  );
}

function verifyToken(token) {
  /* Suspensão (fail-closed) tem precedência sobre tudo: nem o modo
     "login desligado = liberado" nem a janela demo autorizam nada. */
  if (isSuspended()) return null;
  if (!isLoginEnabled()) {
    return { sub: 'anon', usuario: 'Acesso livre', perfil: 'admin', liberada: true };
  }
  if (token) {
    try {
      return jwt.verify(token, getJwtSecret());
    } catch { /* token ausente/inválido: verifica a janela de demonstração */ }
  }
  if (demoAberto()) {
    return { sub: 'demo', usuario: 'Acesso livre', perfil: 'admin', liberada: true };
  }
  return null;
}

/* Sessão sintética (login desabilitado ou janela de demonstração aberta):
   não existe usuário no banco e as rotas não devem procurá-lo. */
function isSessaoLiberada(payload) {
  return Boolean(payload && payload.liberada === true);
}

function publicUser(user, access) {
  return {
    id: user.id,
    usuario: user.usuario,
    nome: user.nome,
    perfil: user.perfil,
    municipio: user.municipio,
    papeis: access && Array.isArray(access.roles) ? access.roles : [],
    organizacoes: access && Array.isArray(access.organizationIds) ? access.organizationIds : [],
  };
}

module.exports = {
  getJwtSecret,
  getJwtExp,
  MAX_PASSWORD_BYTES,
  ensureSeededUsers,
  findByCredentials,
  findOrProvisionUser,
  isLoginEligible,
  signToken,
  signChallengeToken,
  verifyToken,
  isSessaoLiberada,
  publicUser,
  seedUsers,
  isLoginEnabled,
  isSuspended,
};
