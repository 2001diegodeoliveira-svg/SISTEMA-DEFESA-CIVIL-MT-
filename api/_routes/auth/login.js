/* POST /api/auth/login → valida as credenciais e emite a sessão. */
const { jsonResponse, readJson } = require('../../_lib/http');
const { findOrProvisionUser, signToken, signChallengeToken, publicUser, isLoginEnabled } = require('../../_lib/auth');
const { serve } = require('../../_lib/serverless');
const { loginBloqueado, registrarFalha, limparSucesso, segundosDeEspera } = require('../../_lib/rate-limit');
const { runWithDbContext } = require('../../_lib/db-context');
const { isCoordinator } = require('../../_lib/access-control');
const { loadUserAccess, getMfaRecord, writeAuditRecord } = require('../../_lib/store');
const { decryptSecret, verifyTotp } = require('../../_lib/mfa');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }
  if (!isLoginEnabled()) {
    return jsonResponse(503, { erro: 'Login temporariamente suspenso para manutenção.' }, origin);
  }

  const body = await readJson(req);
  const usuario = String(body.usuario || '').trim();
  const senha = String(body.senha || '');
  if (!usuario || !senha) {
    return jsonResponse(400, { erro: 'Informe usuário e senha.' }, origin);
  }

  const bloqueadoMs = loginBloqueado(req, usuario);
  if (bloqueadoMs > 0) {
    const segundos = segundosDeEspera(bloqueadoMs);
    return jsonResponse(429, {
      erro: 'Muitas tentativas de acesso. Tente novamente em ' + segundos + ' segundos.',
      retryAfter: segundos,
    }, origin);
  }

  const user = await findOrProvisionUser(usuario, senha);
  if (!user) {
    registrarFalha(req, usuario);
    return jsonResponse(401, { erro: 'Credenciais inválidas.' }, origin);
  }

  const accessContext = await runWithDbContext(
    { userId: user.id, operation: 'identity' },
    () => loadUserAccess(user.id)
  );
  const requiresMfa = isCoordinator(user, accessContext);
  if (requiresMfa) {
    const challengeToken = signChallengeToken(user, 'mfa_login');
    const mfa = await runWithDbContext(
      { userId: user.id, operation: 'mfa' },
      () => getMfaRecord(user.id)
    );
    if (!mfa || !mfa.enabledAt) {
      limparSucesso(req, usuario);
      return jsonResponse(200, {
        mfaSetupRequired: true,
        challengeToken: signChallengeToken(user, 'mfa_setup'),
        mensagem: 'Configure um aplicativo autenticador antes de entrar.',
      }, origin);
    }
    return jsonResponse(200, {
      mfaRequired: true,
      challengeToken,
      mensagem: 'Informe o código temporário do aplicativo autenticador.',
    }, origin);
  }

  limparSucesso(req, usuario);
  return jsonResponse(200, {
    token: signToken(user, { mfa: false }),
    user: publicUser(user, accessContext),
  }, origin);
});