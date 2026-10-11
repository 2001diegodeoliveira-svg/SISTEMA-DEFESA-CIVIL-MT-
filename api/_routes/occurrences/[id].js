/* GET /api/occurrences/:id → detalhe
   PATCH /api/occurrences/:id → atualização do andamento (autenticado) */
const { jsonResponse, readJson, bearerToken, reqUrl } = require('../../_lib/http');
const { verifyToken } = require('../../_lib/auth');
const { readCollection, writeCollection, push } = require('../../_lib/store');
const { serve } = require('../../_lib/serverless');

const STATUSES = ['NOVA', 'EM_ANALISE', 'EM_ATENDIMENTO', 'ENCAMINHADA', 'RESOLVIDA', 'ENCERRADA'];
const PUBLIC_FIELDS = [
  'id', 'type', 'priority', 'status', 'source', 'city', 'reportedAt', 'receivedAt', 'updatedAt',
];

function publicOccurrence(occurrence) {
  const safe = Object.fromEntries(PUBLIC_FIELDS
    .filter(field => occurrence[field] !== undefined)
    .map(field => [field, occurrence[field]]));
  if (Number.isFinite(occurrence.latitude) && Number.isFinite(occurrence.longitude)) {
    safe.latitude = Math.round(occurrence.latitude * 100) / 100;
    safe.longitude = Math.round(occurrence.longitude * 100) / 100;
  }
  return safe;
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  const url = reqUrl(req);
  const rawId = url && url.pathname.split('/').filter(Boolean).pop();
  let id;
  try {
    id = rawId ? decodeURIComponent(rawId) : '';
  } catch {
    return jsonResponse(400, { erro: 'Identificador de ocorrência inválido.' }, origin);
  }
  if (!id) return jsonResponse(400, { erro: 'Identificador de ocorrência obrigatório.' }, origin);

  const occurrences = await readCollection('occurrences');
  const index = occurrences.findIndex((item) => String(item.id) === id);
  if (index < 0) return jsonResponse(404, { erro: 'Ocorrência não encontrada.' }, origin);
  if (req.method === 'GET') {
    const occurrence = req.accessContext && req.accessContext.authenticated
      ? occurrences[index]
      : publicOccurrence(occurrences[index]);
    return jsonResponse(200, { occurrence }, origin);
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
  if (!['admin', 'avancado', 'municipal'].includes(payload.perfil)) {
    return jsonResponse(403, { erro: 'Seu perfil não pode atualizar ocorrências.' }, origin);
  }

  if (payload.perfil === 'municipal') {
    const users = await readCollection('users');
    const user = users.find((item) => String(item.id) === String(payload.sub));
    if (!user || !user.municipio || normalize(user.municipio) !== normalize(occurrences[index].city)) {
      return jsonResponse(403, { erro: 'Acesso limitado às ocorrências do seu município.' }, origin);
    }
  }

  const body = await readJson(req);
  if (!body || typeof body.status !== 'string' || !STATUSES.includes(body.status)) {
    return jsonResponse(400, { erro: 'Informe um status válido para a ocorrência.' }, origin);
  }

  const previousStatus = occurrences[index].status;
  const updated = {
    ...occurrences[index],
    status: body.status,
    updatedAt: Date.now(),
  };
  occurrences[index] = updated;
  await writeCollection('occurrences', occurrences);
  await push('audit_logs', {
    id: `occurrence-status-${updated.id}-${updated.updatedAt}`,
    action: 'ocorrencia_status_atualizado',
    metadata: {
      occurrenceId: updated.id,
      previousStatus,
      status: updated.status,
      updatedBy: payload.usuario,
    },
    createdAt: updated.updatedAt,
  });

  return jsonResponse(200, { ok: true, occurrence: updated }, origin);
});
