/* DELETE /api/areas/:id → remove (autenticado, dono ou admin) */
const { jsonResponse, bearerToken, reqUrl } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { readCollection, writeCollection } = require('../_lib/store');
const { serve } = require('../_lib/serverless');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'DELETE') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) {
    return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
  }

  const url = reqUrl(req);
  const parts = (url ? url.pathname : '').replace(/\/+$/, '').split('/');
  const id = parts[parts.length - 1];

  let areas = await readCollection('areas');
  const target = areas.find(a => String(a.id) === String(id));
  if (!target) return jsonResponse(404, { erro: 'Área não encontrada.' }, origin);
  if (payload.perfil !== 'admin' && String(target.authoredBy) !== String(payload.sub)) {
    return jsonResponse(403, { erro: 'Você só pode excluir suas próprias áreas.' }, origin);
  }
  areas = areas.filter(a => String(a.id) !== String(id));
  await writeCollection('areas', areas);
  return jsonResponse(200, { ok: true }, origin);
});
