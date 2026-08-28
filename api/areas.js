/* Áreas de interesse desenhadas no mapa:
   GET    /api/areas        → lista
   POST   /api/areas        → cria (autenticado)
   DELETE /api/areas/:id    → remove (autenticado, dono ou admin)
*/
const { jsonResponse, readJson, bearerToken } = require('./_lib/http');
const { verifyToken } = require('./_lib/auth');
const { readCollection, push, writeCollection } = require('./_lib/store');

module.exports = async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  const id = parts[parts.length - 1];
  const isCollection = id === 'areas';

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  if (req.method === 'GET') {
    const areas = await readCollection('areas');
    return jsonResponse(200, { areas }, origin);
  }

  if (req.method === 'POST' && isCollection) {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) {
      return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
    }
    const body = await readJson(req);
    const { nome, coords, areaKm2, estacoes } = body;
    if (!nome || !Array.isArray(coords) || coords.length < 3) {
      return jsonResponse(400, { erro: 'Campos obrigatórios: nome, coords (>=3 vértices).' }, origin);
    }
    const area = {
      id: String(Date.now()),
      nome: String(nome),
      coords,
      areaKm2: Math.round(Number(areaKm2) || 0),
      estacoes: Number(estacoes) || 0,
      createdAt: Date.now(),
      authoredBy: payload.sub,
    };
    await push('areas', area);
    return jsonResponse(201, { area }, origin);
  }

  if (req.method === 'DELETE' && !isCollection) {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) {
      return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
    }
    let areas = await readCollection('areas');
    const target = areas.find(a => String(a.id) === String(id));
    if (!target) return jsonResponse(404, { erro: 'Área não encontrada.' }, origin);
    if (payload.perfil !== 'admin' && String(target.authoredBy) !== String(payload.sub)) {
      return jsonResponse(403, { erro: 'Você só pode excluir suas próprias áreas.' }, origin);
    }
    areas = areas.filter(a => String(a.id) !== String(id));
    await writeCollection('areas', areas);
    return jsonResponse(200, { ok: true }, origin);
  }

  return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
};
