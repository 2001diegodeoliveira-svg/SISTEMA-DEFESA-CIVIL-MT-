/* POST /api/auth/login  →  { token, user }
   POST /api/auth/logout →  { ok }   (client descarta o token)
   GET  /api/auth/me     →  { user } (valida token) */
const { jsonResponse, readJson, bearerToken } = require('./_lib/http');
const { findByCredentials, signToken, verifyToken, publicUser, ensureSeededUsers } = require('./_lib/auth');

module.exports = async function handler(req) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '').split('/').pop();
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') {
    return jsonResponse(204, {}, origin);
  }

  if (req.method === 'POST' && p === 'login') {
    const body = await readJson(req);
    const usuario = String(body.usuario || '').trim();
    const senha = String(body.senha || '');
    if (!usuario || !senha) {
      return jsonResponse(400, { erro: 'Informe usuário e senha.' }, origin);
    }
    const user = await findByCredentials(usuario, senha);
    if (!user) {
      return jsonResponse(401, { erro: 'Credenciais inválidas.' }, origin);
    }
    const token = signToken(user);
    return jsonResponse(200, { token, user: publicUser(user) }, origin);
  }

  if (req.method === 'POST' && p === 'logout') {
    return jsonResponse(200, { ok: true }, origin);
  }

  if (req.method === 'GET' && p === 'me') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) {
      return jsonResponse(401, { erro: 'Não autenticado.' }, origin);
    }
    const users = await ensureSeededUsers();
    const user = users.find(x => x.id === payload.sub);
    if (!user) return jsonResponse(401, { erro: 'Usuário não encontrado.' }, origin);
    return jsonResponse(200, { user: publicUser(user) }, origin);
  }

  return jsonResponse(404, { erro: 'Não encontrado.' }, origin);
};
