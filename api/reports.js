/* Ocorrências (reportes do Waze):
   GET  /api/reports            → lista todas (público, leitura)
   POST /api/reports            → cria nova (requer autenticação)
*/
const { jsonResponse, readJson, bearerToken } = require('./_lib/http');
const { verifyToken } = require('./_lib/auth');
const { readCollection, push } = require('./_lib/store');

module.exports = async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  if (req.method === 'GET') {
    const reports = await readCollection('reports');
    return jsonResponse(200, {
      reports: reports.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      total: reports.length,
    }, origin);
  }

  if (req.method === 'POST') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) {
      return jsonResponse(401, { erro: 'Autenticação necessária para reportar ocorrência.' }, origin);
    }

    const body = await readJson(req);
    const { type, severity, location, description, reporter, lat, lng } = body;
    if (!type || !location || !description || typeof lat !== 'number' || typeof lng !== 'number') {
      return jsonResponse(400, { erro: 'Campos obrigatórios: type, location, description, lat, lng.' }, origin);
    }

    const report = {
      id: String(Date.now()),
      type, severity: severity || 'info',
      location: String(location),
      description: String(description),
      reporter: String(reporter || 'Anônimo'),
      lat, lng,
      ts: Date.now(),
      createdAt: Date.now(),
      authoredBy: payload.sub,
    };
    await push('reports', report);
    return jsonResponse(201, { report }, origin);
  }

  return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
};
