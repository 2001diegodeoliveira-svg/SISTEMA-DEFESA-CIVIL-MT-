/* ============================================================
   Google Authenticator (TOTP) — sub-rotas de /api/auth/totp/*
   - verify   : confirma o segundo fator e completa o login
   - setup    : gera segredo + QR para habilitar o autenticador
   - activate : valida o código e ativa o TOTP na conta
   - disable  : desativa o TOTP da conta (exige sessão completa)
   ============================================================ */
const { generateSecret, generateURI } = require('otplib');
const QRCode = require('qrcode');
const { jsonResponse, readJson, bearerToken } = require('../../_lib/http');
const {
  verifyToken, verifyTotpChallenge, verifyTotpCode, checkTotpToken,
  signToken, publicUser, isLoginEligible,
} = require('../../_lib/auth');
const { readCollection, writeCollection } = require('../../_lib/store');
const { serve } = require('../../_lib/serverless');

const SERVICE = 'Defesa Civil MT';

function subName(req) {
  const raw = String(req && req.url || '');
  const match = raw.match(/\/auth\/totp\/([^/?#]+)/);
  return match ? match[1] : '';
}

function originOf(req) {
  return req.headers && typeof req.headers.get === 'function' ? (req.headers.get('origin') || undefined) : undefined;
}

async function loadUsers() {
  return readCollection('users');
}

async function findUserById(users, id) {
  return users.find((item) => String(item.id) === String(id)) || null;
}

async function findUserByName(users, usuario) {
  return users.find((item) => String(item.usuario).toLowerCase() === String(usuario).toLowerCase()) || null;
}

/* Sessão válida para gerenciar o TOTP:
   token JWT completo (Bearer) ou desafio de 2FA (após senha confirmada).
   "preBody" evita reler o corpo da requisição (já consumido pela rota). */
async function resolveSession(req, preBody) {
  let payload = verifyToken(bearerToken(req) || '');
  let tokenIsTotp = false;
  if (!payload) {
    let desafio = '';
    try { desafio = String((preBody || await readJson(req)).desafio || ''); } catch { /* sem corpo */ }
    if (desafio) {
      payload = verifyTotpChallenge(desafio);
      tokenIsTotp = true;
    }
    if (!payload) return { user: null, allowed: false, totpScope: false, tokenIsTotp: false };
  } else if (payload.scope === 'totp') {
    tokenIsTotp = true;
  }
  const users = await loadUsers();
  const user = await findUserById(users, payload.sub);
  if (!user || !isLoginEligible(user)) return { user: null, allowed: false, totpScope: payload.scope === 'totp', tokenIsTotp };
  return { user, allowed: true, totpScope: payload.scope === 'totp', tokenIsTotp };
}

async function persistUserList(list) {
  await writeCollection('users', list);
}

module.exports = serve(async function handler(req) {
  const origin = originOf(req);
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  const action = subName(req);

  if (action === 'verify') {
    if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
    const body = await readJson(req);
    const desafio = String(body.desafio || '').trim();
    const codigo = String(body.codigo || '').trim();
    const payload = desafio ? verifyTotpChallenge(desafio) : null;
    if (!payload) return jsonResponse(401, { erro: 'Sessão de login expirada. Refaça o login.' }, origin);

    const users = await loadUsers();
    const user = await findUserById(users, payload.sub);
    if (!user || !verifyTotpCode(user, codigo)) {
      return jsonResponse(401, { erro: 'Código do Google Authenticator inválido ou expirado.' }, origin);
    }
    return jsonResponse(200, { token: signToken(user), user: publicUser(user) }, origin);
  }

  if (action === 'setup') {
    if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
    const { user, allowed } = await resolveSession(req);
    if (!allowed) return jsonResponse(401, { erro: 'Autenticação necessária para configurar o autenticador.' }, origin);
    if (user.otp && user.otp.ativo) {
      return jsonResponse(200, { ativo: true, mensagem: 'Autenticador já está ativo nesta conta.' }, origin);
    }
    const secret = generateSecret();
    const uri = generateURI({ strategy: 'totp', issuer: SERVICE, label: user.usuario, secret });
    const qr = await QRCode.toDataURL(uri, {
      margin: 1, scale: 6, width: 240,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    const users = await loadUsers();
    const index = users.findIndex((item) => String(item.id) === String(user.id));
    if (index < 0) return jsonResponse(404, { erro: 'Conta não encontrada.' }, origin);
    users[index].otp = { secret, ativo: false };
    await persistUserList(users);
    return jsonResponse(200, { ativo: false, segredo: secret, qr, uri, servico: SERVICE });
  }

  if (action === 'activate') {
    if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
    const body = await readJson(req);
    const codigo = String(body.codigo || '').trim();
    const { user, allowed } = await resolveSession(req, body);
    if (!allowed) return jsonResponse(401, { erro: 'Autenticação necessária para ativar o autenticador.' }, origin);
    if (!user.otp || !user.otp.secret) {
      return jsonResponse(400, { erro: 'Nenhum segredo pendente. Solicite a configuração primeiro.' }, origin);
    }
    if (user.otp.ativo) return jsonResponse(200, { ativo: true });
    if (!checkTotpToken(user.otp.secret, codigo)) {
      return jsonResponse(401, { erro: 'Código inválido. Confira o código exibido no Google Authenticator.' }, origin);
    }
    const users = await loadUsers();
    const index = users.findIndex((item) => String(item.id) === String(user.id));
    if (index < 0) return jsonResponse(404, { erro: 'Conta não encontrada.' }, origin);
    users[index].otp = { secret: user.otp.secret, ativo: true };
    await persistUserList(users);
    return jsonResponse(200, { ativo: true, user: publicUser(user) });
  }

  if (action === 'disable') {
    if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
    const body = await readJson(req);
    const codigo = String(body.codigo || '').trim();
    const { user, allowed, tokenIsTotp } = await resolveSession(req, body);
    if (!allowed || tokenIsTotp) {
      return jsonResponse(401, { erro: 'É necessário estar logado para desativar o autenticador.' }, origin);
    }
    if (!user.otp || !user.otp.ativo) return jsonResponse(400, { erro: 'Autenticador não está ativo nesta conta.' }, origin);
    if (!verifyTotpCode(user, codigo)) {
      return jsonResponse(401, { erro: 'Código inválido.' }, origin);
    }
    const users = await loadUsers();
    const index = users.findIndex((item) => String(item.id) === String(user.id));
    if (index < 0) return jsonResponse(404, { erro: 'Conta não encontrada.' }, origin);
    users[index].otp = null;
    await persistUserList(users);
    return jsonResponse(200, { ativo: false });
  }

  return jsonResponse(404, { erro: 'Ação TOTP desconhecida.' }, origin);
});