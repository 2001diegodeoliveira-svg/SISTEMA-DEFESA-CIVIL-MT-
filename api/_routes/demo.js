/* GET /api/demo → estado da janela de demonstração.
   Também registra o primeiro acesso quando ainda não existe. */
const { jsonResponse } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { demoAtualizar, demoEstado } = require('../_lib/demo');
const { isLoginEnabled } = require('../_lib/runtime-config');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  await demoAtualizar();
  return jsonResponse(200, { ...demoEstado(), loginHabilitado: isLoginEnabled() }, origin);
});
