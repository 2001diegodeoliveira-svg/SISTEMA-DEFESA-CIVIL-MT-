'use strict';

const { jsonResponse, bearerToken, readJson, reqUrl } = require('../../_lib/http');
const { verifyToken, signToken, publicUser, isLoginEligible } = require('../../_lib/auth');
const { serve } = require('../../_lib/serverless');
const { runWithDbContext } = require('../../_lib/db-context');
const { isCoordinator } = require('../../_lib/access-control');
const { readCollection, loadUserAccess, getMfaRecord, savePendingMfa, enableMfa, consumeMfaStep, writeAuditRecord } = require('../../_lib/store');
const { createSecret, decryptSecret, encryptSecret, otpauthUri, verifyTotpStep } = require('../../_lib/mfa');
const { loginBloqueado, registrarFalha, limparSucesso, segundosDeEspera } = require('../../_lib/rate-limit');

function accessDenied(origin) {
  return jsonResponse(403, { erro: 'A configuração de MFA está disponível apenas para papéis de coordenação.' }, origin);
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const action = reqUrl(req)?.pathname.split('/').filter(Boolean).pop();
  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload || !['mfa_setup', 'mfa_login'].includes(payload.purpose)) {
    return jsonResponse(401, { erro: 'Desafio MFA inválido ou expirado. Faça login novamente.' }, origin);
  }
  if ((action === 'enroll' || action === 'confirm') && payload.purpose !== 'mfa_setup') {
    return jsonResponse(403, { erro: 'Este desafio não permite cadastrar um autenticador.' }, origin);
  }
  if (action === 'verify' && payload.purpose !== 'mfa_login') {
    return jsonResponse(403, { erro: 'Este desafio não permite validar o acesso.' }, origin);
  }

  const access = req.accessContext && req.accessContext.access ? req.accessContext.access : {
    organizationIds: [],
    directOrganizationIds: [],
    writableOrganizationIds: [],
    roles: [],
  };

  return runWithDbContext({
    userId: payload.sub,
    organizationIds: access.organizationIds,
    directOrganizationIds: access.directOrganizationIds,
    writableOrganizationIds: access.writableOrganizationIds,
    operation: 'mfa',
  }, async () => {
    const users = await readCollection('users');
    const user = users.find(item => String(item.id) === String(payload.sub));
    if (!user || !isLoginEligible(user)) {
      return jsonResponse(401, { erro: 'Conta suspensa ou inexistente.' }, origin);
    }
    const access = await loadUserAccess(user.id);
    if (!isCoordinator(user, access)) return accessDenied(origin);

    if (action === 'enroll') {
      const current = await getMfaRecord(user.id);
      if (current && current.enabledAt) {
        return jsonResponse(409, { erro: 'MFA já está habilitado. Solicite redefinição ao administrador do órgão.' }, origin);
      }
      let secret;
      let encrypted;
      try {
        secret = createSecret();
        encrypted = encryptSecret(secret);
      } catch (error) {
        return jsonResponse(503, { erro: error.message }, origin);
      }
      await savePendingMfa(user.id, encrypted);
      await writeAuditRecord({
        userId: user.id,
        organizationId: access.directOrganizationIds[0],
        action: 'mfa_cadastro_iniciado',
        details: { method: 'totp' },
      });
      return jsonResponse(200, {
        secret,
        otpauthUri: otpauthUri(secret, user.usuario),
        instrucoes: 'Adicione a chave ao aplicativo autenticador e confirme com o código de seis dígitos.',
      }, origin);
    }

    if (action === 'confirm' || action === 'verify') {
      const bucket = `mfa:${payload.sub}`;
      const wait = loginBloqueado(req, bucket);
      if (wait > 0) {
        const seconds = segundosDeEspera(wait);
        return jsonResponse(429, { erro: `Muitas tentativas de MFA. Tente novamente em ${seconds} segundos.`, retryAfter: seconds }, origin);
      }
      const body = await readJson(req);
      const mfa = await getMfaRecord(user.id);
      const isPending = action === 'confirm' && mfa && !mfa.enabledAt;
      if (!mfa || (action === 'confirm' && !isPending) || (action === 'verify' && !mfa.enabledAt)) {
        return jsonResponse(409, { erro: 'Não há configuração MFA válida para esta operação.' }, origin);
      }
      let secret;
      try {
        secret = decryptSecret(mfa);
      } catch (error) {
        console.error('[mfa] não foi possível decifrar o segredo TOTP:', error.message);
        return jsonResponse(503, { erro: 'Configuração MFA indisponível. Contate o administrador do sistema.' }, origin);
      }
      const verifiedStep = verifyTotpStep(secret, body.codigo, Date.now(), Number(mfa.lastVerifiedStep || 0));
      if (verifiedStep === null || !await consumeMfaStep(user.id, verifiedStep)) {
        registrarFalha(req, bucket);
        await writeAuditRecord({
          userId: user.id,
          organizationId: access.directOrganizationIds[0],
          action: 'mfa_codigo_invalido',
          details: { method: 'totp' },
        });
        return jsonResponse(401, { erro: 'Código inválido ou expirado.' }, origin);
      }
      limparSucesso(req, bucket);

      if (action === 'confirm') {
        await enableMfa(user.id);
        await writeAuditRecord({
          userId: user.id,
          organizationId: access.directOrganizationIds[0],
          action: 'mfa_habilitado',
          details: { method: 'totp' },
        });
      } else {
        await writeAuditRecord({
          userId: user.id,
          organizationId: access.directOrganizationIds[0],
          action: 'login_mfa_concluido',
          details: { method: 'totp' },
        });
      }

      return jsonResponse(200, {
        token: signToken(user, { mfa: true, amr: ['pwd', 'otp'] }),
        user: publicUser(user, access),
      }, origin);
    }

    return jsonResponse(404, { erro: 'Operação MFA não encontrada.' }, origin);
  });
});
