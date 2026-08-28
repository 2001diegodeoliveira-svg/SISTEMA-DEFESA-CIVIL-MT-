/* GET /api/auth/me → { user } (valida token) */
const { jsonResponse, bearerToken } = require('../_lib/http');
const { verifyToken, ensureSeededUsers, publicUser } = require('../_lib/auth');

module.exports = async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) {
    return jsonResponse(401, { erro: 'Não autenticado.' }, origin);
  }
  const users = await ensureSeededUsers();
  const user = users.find(x => x.id === payload.sub);
  if (!user) return jsonResponse(401, { erro: 'Usuário não encontrado.' }, origin);
  return jsonResponse(200, { user: publicUser(user) }, origin);
};
