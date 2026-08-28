/* POST /api/auth/login → { token, user } */
const { jsonResponse, readJson } = require('../_lib/http');
const { findByCredentials, signToken, publicUser } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

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
});
