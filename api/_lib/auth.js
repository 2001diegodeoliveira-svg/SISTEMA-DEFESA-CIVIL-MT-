/* ============================================================
   Autenticação — JWT + senha com hash (bcryptjs).
  Bootstrap opcional de admin via SEED_USERS; usuários comuns exigem cadastro aprovado.
   ============================================================ */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { readCollection, writeCollection } = require('./store');
/* O TOTP é carregado sob demanda (ver ./totp-provider): o otplib v13 é ESM
   e quebraria a API inteira se fosse requerido no topo deste arquivo. */
const totp = require('./totp-provider');

const JWT_SECRET = process.env.JWT_SECRET || 'dc-mt-dev-secret-change-me';
const JWT_EXP = process.env.JWT_EXP || '12h';
const JWT_TOTP_EXP = process.env.JWT_TOTP_EXP || '5m';

function totpSecretFor(user) {
  return user && user.otp && user.otp.ativo ? user.otp.secret : null;
}

/* Assíncronas de propósito: a biblioteca TOTP é carregada sob demanda. */
async function checkTotpToken(secret, code) {
  return totp.verifyCode(secret, code);
}

function signTotpChallenge(user, extra) {
  return jwt.sign(
    { scope: 'totp', sub: user.id, usuario: user.usuario, ...(extra || {}) },
    JWT_SECRET,
    { expiresIn: JWT_TOTP_EXP }
  );
}

function verifyTotpChallenge(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.scope === 'totp' ? payload : null;
  } catch {
    return null;
  }
}

async function verifyTotpCode(user, code) {
  return checkTotpToken(totpSecretFor(user), code);
}

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
  const u = users.find(x => x.usuario === usuario);
  if (!isLoginEligible(u)) return null;
  if (!bcrypt.compareSync(senha, u.senhaHash)) return null;
  return u;
}

function isLoginEligible(user) {
  if (!user || user.ativo === false) return false;
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
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
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
  publicUser,
  seedUsers,
  signTotpChallenge,
  verifyTotpChallenge,
  verifyTotpCode,
  checkTotpToken,
};
