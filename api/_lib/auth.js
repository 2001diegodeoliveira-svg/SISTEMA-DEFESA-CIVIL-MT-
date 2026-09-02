/* ============================================================
   Autenticação — JWT + senha com hash (bcryptjs).
   Usuários semeados via SEED_USERS (env JSON) ou padrão de demo.
   ============================================================ */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { readCollection, writeCollection } = require('./store');

const JWT_SECRET = process.env.JWT_SECRET || 'dc-mt-dev-secret-change-me';
const JWT_EXP = process.env.JWT_EXP || '12h';

/* Usuários padrão de demonstração (credenciais abaixo — só para dev).
   Em produção, defina SEED_USERS e JWT_SECRET no ambiente. */
const DEFAULT_SEED = [
  { usuario: 'admin',  senha: 'admin123',  nome: 'Coordenador', perfil: 'admin',     municipio: 'Cuiabá' },
  { usuario: 'operador', senha: 'mt199',   nome: 'Operador',    perfil: 'avancado',  municipio: 'Cuiabá' },
  { usuario: 'comum',  senha: 'comum123',  nome: 'Cidadão',     perfil: 'comum',     municipio: '' },
  { usuario: 'gestor', senha: 'mt199',     nome: 'Gestor',      perfil: 'municipal', municipio: 'Sinop' },
  { usuario: 'Dev@2026', senha: 'Dev@2026', nome: 'Usuário Geral', perfil: 'comum', municipio: '' },
];

function seedUsers() {
  try {
    if (process.env.SEED_USERS) return JSON.parse(process.env.SEED_USERS);
  } catch {}
  return DEFAULT_SEED;
}

async function ensureSeededUsers() {
  let users = await readCollection('users');
  if (users && users.length) return users;

  const seed = seedUsers();
  users = [];
  for (const u of seed) {
    users.push({
      id: 'U' + (users.length + 1),
      usuario: u.usuario,
      senhaHash: bcrypt.hashSync(u.senha, 10),
      nome: u.nome,
      perfil: u.perfil,
      municipio: u.municipio || '',
      criadoEm: new Date().toISOString(),
    });
  }
  await writeCollection('users', users);
  return users;
}

async function findByCredentials(usuario, senha) {
  const users = await ensureSeededUsers();
  const u = users.find(x => x.usuario === usuario);
  if (!u) return null;
  if (!bcrypt.compareSync(senha, u.senhaHash)) return null;
  return u;
}

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
  signToken,
  verifyToken,
  publicUser,
  seedUsers,
};
