/* POST /api/auth/logout → { ok } (cliente descarta o token) */
const { jsonResponse } = require('../_lib/http');

module.exports = async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }
  return jsonResponse(200, { ok: true }, origin);
};
