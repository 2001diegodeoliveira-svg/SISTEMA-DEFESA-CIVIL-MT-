/* ============================================================
   Autenticação — JWT + senha com hash (bcryptjs).
  Bootstrap opcional de admin via SEED_USERS; usuários comuns exigem cadastro aprovado.
   ============================================================ */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { readCollection, writeCollection } = require('./store');
const { isLoginEnabled, isSeedOnlyLoginEnabled } = require('./runtime-config');
const { demoAberto } = require('./demo');

const JWT_SECRET = process.env.JWT_SECRET || 'dc-mt-dev-secret-change-me';
const JWT_EXP = process.env.JWT_EXP || '12h';

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
    if (existing && existing.ativo !== false && existing.perfil === 'admin' && bcrypt.compareSync(configured.senha, existing.senhaHash)) continue;
    const account = {
      ...(existing || {}),
      id: existing ? existing.id : 'U' + (users.length + 1),
      usuario: configured.usuario,
      senhaHash: bcrypt.hashSync(configured.senha, 12),
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

async function findByCredentials(usuario, senha) {
  const users = await ensureSeededUsers();
  const normalizedUsername = String(usuario || '').trim().toLowerCase();
  const u = users.find((user) => String(user.usuario || '').trim().toLowerCase() === normalizedUsername);
  if (!isLoginEligible(u)) return null;
  if (!bcrypt.compareSync(senha, u.senhaHash)) return null;
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
  return Boolean(user.cadastroId);
}

const findOrProvisionUser = findByCredentials;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, usuario: user.usuario, perfil: user.perfil },
    JWT_SECRET,
    { expiresIn: JWT_EXP }
  );
}

function verifyToken(token) {
  if (!isLoginEnabled()) {
    return { sub: 'anon', usuario: 'Acesso livre', perfil: 'admin', liberada: true };
  }
  if (token) {
    try {
      return jwt.verify(token, JWT_SECRET);
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

function publicUser(user) {
  return {
    id: user.id,
    usuario: user.usuario,
    nome: user.nome,
    perfil: user.perfil,
    municipio: user.municipio,
  };
}

module.exports = {
  JWT_SECRET,
  ensureSeededUsers,
  findByCredentials,
  findOrProvisionUser,
  isLoginEligible,
  signToken,
  verifyToken,
  isSessaoLiberada,
  publicUser,
  seedUsers,
  isLoginEnabled,
};
