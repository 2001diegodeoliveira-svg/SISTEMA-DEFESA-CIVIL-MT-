/* POST /api/auth/login → valida as credenciais e devolve o DESAFIO de 2FA.
   A sessão (token) NUNCA é emitida aqui: só depois da confirmação do código
   do Google Authenticator (auth/totp/verify ou auth/totp/activate). */
const { jsonResponse, readJson } = require('../../_lib/http');
const { findOrProvisionUser, signTotpChallenge, publicUser } = require('../../_lib/auth');
const { serve } = require('../../_lib/serverless');

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
  const user = await findOrProvisionUser(usuario, senha);
  if (!user) {
    return jsonResponse(401, { erro: 'Credenciais inválidas.' }, origin);
  }

  /* setup:true  → conta ainda não tem autenticador: o painel deve mostrar o QR.
     setup:false → já configurado: o painel pede apenas o código de 6 dígitos. */
  const jaAtivo = Boolean(user.otp && user.otp.ativo);
  return jsonResponse(200, {
    exigeTotp: true,
    setup: !jaAtivo,
    desafio: signTotpChallenge(user),
    user: publicUser(user),
  }, origin);
});