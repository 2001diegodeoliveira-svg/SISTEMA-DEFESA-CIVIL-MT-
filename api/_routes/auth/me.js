/* GET /api/auth/me → { user } (valida token) */
const { jsonResponse, bearerToken } = require('../../_lib/http');
const { verifyToken, publicUser, isLoginEligible, isLoginEnabled, isSessaoLiberada } = require('../../_lib/auth');
const { serve } = require('../../_lib/serverless');
const { readCollection } = require('../../_lib/store');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }
  if (!isLoginEnabled()) {
    return jsonResponse(200, { user: {
      id: 'anon', usuario: 'Acesso livre', nome: 'Acesso livre', perfil: 'admin', municipio: '',
    } }, origin);
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) {
    return jsonResponse(401, { erro: 'Não autenticado.' }, origin);
  }
  if (isSessaoLiberada(payload)) {
    return jsonResponse(200, { user: {
      id: payload.sub, usuario: payload.usuario, nome: 'Acesso livre',
      perfil: payload.perfil, municipio: '',
    } }, origin);
  }
  const users = await readCollection('users');
  const user = users.find(x => x.id === payload.sub);
  if (!isLoginEligible(user)) {
    return jsonResponse(401, { erro: 'Conta suspensa ou sem cadastro aprovado.' }, origin);
  }
  if (req.accessContext && req.accessContext.requiresMfa && payload.mfa !== true) {
    return jsonResponse(401, { erro: 'Autenticação multifator obrigatória.', mfaRequired: true }, origin);
  }
  return jsonResponse(200, { user: publicUser(user, req.accessContext && req.accessContext.access) }, origin);
});
