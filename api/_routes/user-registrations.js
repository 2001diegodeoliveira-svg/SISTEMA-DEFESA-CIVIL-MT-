/* Solicitações públicas de acesso; consulta e análise restritas a administradores. */
const bcrypt = require('bcryptjs');
const { jsonResponse, readJson, bearerToken } = require('../_lib/http');
const { verifyToken, isLoginEligible, isLoginEnabled, isSessaoLiberada } = require('../_lib/auth');
const { readCollection, createUserRegistration, updateUserRegistration, editUserRegistration, deleteUserRegistration } = require('../_lib/store');
const { serve } = require('../_lib/serverless');

const LEVELS = new Set(['Consulta', 'Operacao', 'Gestao']);
const PROFILES = new Set(['Estadual', 'Municipal']);

function validCpf(value) {
  const cpf = String(value || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (let digit = 9; digit < 11; digit++) {
    let sum = 0;
    for (let index = 0; index < digit; index++) sum += Number(cpf[index]) * (digit + 1 - index);
    let check = (sum * 10) % 11;
    if (check === 10 || check === 11) check = 0;
    if (check !== Number(cpf[digit])) return false;
  }
  return true;
}

function publicRegistration(registration) {
  const { senhaHash, ...publicData } = registration;
  return publicData;
}

async function requireAdmin(req) {
  if (!isLoginEnabled()) {
    return { id: 'anon', usuario: 'Acesso livre', perfil: 'admin', ativo: true };
  }
  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) return null;
  /* Janela de demonstração: acesso administrativo sem conta no banco. */
  if (isSessaoLiberada(payload)) {
    return { id: payload.sub, usuario: payload.usuario, perfil: payload.perfil, ativo: true };
  }
  const users = await readCollection('users');
  const user = users.find((item) => String(item.id) === String(payload.sub));
  return user && user.perfil === 'admin' && isLoginEligible(user) ? user : null;
}

function routeId(req) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const match = pathname.match(/^\/api\/user-registrations\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function validateData(body, { editing = false } = {}) {
  const nome = String(body.nome || '').trim();
  const usuario = String(body.usuario || '').trim();
  const senha = String(body.senha || '');
  const email = String(body.email || '').trim().toLowerCase();
  const cpf = String(body.cpf || '').replace(/\D/g, '');
  const perfil = String(body.perfil || '');
  const nivel = String(body.nivel || '');

  if (nome.length < 5 || nome.length > 160) return { erro: 'Informe o nome completo (5 a 160 caracteres).' };
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(usuario)) return { erro: 'Usuário deve ter de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado.' };
  if (!editing && (senha.length < 12 || Buffer.byteLength(senha, 'utf8') > 72)) {
    return { erro: 'A senha deve ter ao menos 12 caracteres e no máximo 72 bytes UTF-8.' };
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { erro: 'E-mail inválido.' };
  if (!validCpf(cpf)) return { erro: 'CPF inválido.' };
  if (!PROFILES.has(perfil)) return { erro: 'Esfera de acesso inválida.' };
  if (!LEVELS.has(nivel)) return { erro: 'Nível de permissão inválido.' };
  if (perfil === 'Municipal' && String(body.municipio || '').trim().length < 3) return { erro: 'Informe um município válido.' };
  if (String(body.orgao || '').trim().length < 3) return { erro: 'Informe o órgão ou entidade.' };
  if (body.declaracao !== true) return { erro: 'Confirme a declaração para enviar a solicitação.' };

  const data = { ...body };
  delete data.senha;
  delete data.senhaHash;
  delete data.id;
  delete data.status;
  delete data.situacao;
  delete data.perfilSistema;
  delete data.role;
  delete data.parecer;
  delete data.avaliadoEm;
  delete data.avaliadoPor;
  delete data.historico;
  delete data.origem;
  data.nome = nome;
  data.email = email;
  data.cpf = cpf;
  data.usuario = usuario;
  data.perfil = perfil;
  data.nivel = nivel;
  return { usuario, senha, email, cpf, dados: data };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  const id = routeId(req);
  if (req.method === 'POST' && !id) {
    const body = await readJson(req);
    const validated = validateData(body);
    if (validated.erro) return jsonResponse(400, { erro: validated.erro }, origin);

    const users = await readCollection('users');
    if (users.some((user) => String(user.usuario).toLowerCase() === validated.usuario.toLowerCase())) {
      return jsonResponse(409, { erro: 'Este usuário já está cadastrado.' }, origin);
    }
    const registrations = await readCollection('user_registrations');
    if (registrations.some((item) => item.status !== 'Recusado' && (
      String(item.usuario).toLowerCase() === validated.usuario.toLowerCase() ||
      String(item.email).toLowerCase() === validated.email ||
      String(item.cpf).replace(/\D/g, '') === validated.cpf
    ))) return jsonResponse(409, { erro: 'Já existe uma solicitação ativa com esse usuário, e-mail ou CPF.' }, origin);

    try {
      const now = new Date().toISOString();
      const registration = await createUserRegistration({
        id: `REG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        usuario: validated.usuario,
        senhaHash: await bcrypt.hash(validated.senha, 12),
        email: validated.email,
        cpf: validated.cpf,
        dados: {
          ...validated.dados,
          origem: 'Solicitante',
          historico: [{ data: now, autor: 'Solicitante', acao: 'Cadastro recebido' }],
        },
        status: 'Pendente',
        situacao: 'Ativo',
        parecer: '',
        criadoEm: now,
        atualizadoEm: now,
      });
      return jsonResponse(201, { ok: true, registration: publicRegistration(registration) }, origin);
    } catch (error) {
      if (error.code === '23505') return jsonResponse(409, { erro: 'Já existe uma solicitação ativa com esse usuário, e-mail ou CPF.' }, origin);
      throw error;
    }
  }

  const admin = await requireAdmin(req);
  if (!admin) return jsonResponse(401, { erro: 'Acesso exclusivo de administrador.' }, origin);

  if (req.method === 'GET' && !id) {
    const registrations = await readCollection('user_registrations');
    return jsonResponse(200, { registrations: registrations.map(publicRegistration) }, origin);
  }

  if (req.method === 'PUT' && id) {
    const body = await readJson(req);
    const registrations = await readCollection('user_registrations');
    const current = registrations.find((item) => String(item.id) === id);
    if (!current) return jsonResponse(404, { erro: 'Solicitação não encontrada.' }, origin);
    const validated = validateData({ ...body, usuario: current.usuario }, { editing: true });
    if (validated.erro) return jsonResponse(400, { erro: validated.erro }, origin);
    try {
      const updated = await editUserRegistration(id, validated.dados);
      return jsonResponse(200, { ok: true, registration: publicRegistration(updated) }, origin);
    } catch (error) {
      if (error.code === 'REGISTRATION_NOT_PENDING') return jsonResponse(409, { erro: error.message }, origin);
      if (error.code === '23505') return jsonResponse(409, { erro: 'E-mail ou CPF já está vinculado a outra solicitação.' }, origin);
      throw error;
    }
  }

  if (req.method === 'PATCH' && id) {
    const body = await readJson(req);
    if (!['Aprovado', 'Recusado'].includes(body.status)) return jsonResponse(400, { erro: 'Status deve ser Aprovado ou Recusado.' }, origin);
    const parecer = String(body.parecer || '').trim();
    if (parecer.length < 5 || parecer.length > 2000) return jsonResponse(400, { erro: 'Informe um parecer de 5 a 2000 caracteres.' }, origin);
    try {
      const updated = await updateUserRegistration(id, {
        status: body.status,
        parecer,
        nivel: LEVELS.has(body.nivel) ? body.nivel : undefined,
        avaliadoPor: admin.usuario,
      });
      if (!updated) return jsonResponse(404, { erro: 'Solicitação não encontrada.' }, origin);
      return jsonResponse(200, { ok: true, registration: publicRegistration(updated) }, origin);
    } catch (error) {
      if (error.code === 'REGISTRATION_NOT_PENDING') return jsonResponse(409, { erro: error.message }, origin);
      if (error.code === 'INVALID_MUNICIPALITY') return jsonResponse(400, { erro: error.message }, origin);
      if (error.code === '23505') return jsonResponse(409, { erro: 'O usuário já existe ou os dados já estão vinculados a outra conta.' }, origin);
      throw error;
    }
  }

  if (req.method === 'DELETE' && id) {
    const deleted = await deleteUserRegistration(id);
    if (!deleted) return jsonResponse(409, { erro: 'Solicitação inexistente ou já aprovada; contas aprovadas não podem ser apagadas por esta ação.' }, origin);
    return jsonResponse(200, { ok: true }, origin);
  }

  return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
});