/* ============================================================
   Web Push — inscrição e chave pública (Fase 5).
   GET  /api/push/config       público: {vapidPublicKey|null, ativo}
   POST /api/push/subscrever   público: {subscription} -> salva
   POST /api/push/remover      público: {endpoint} -> remove
   Envio real acontece no motor (alertas-motor/avaliar).
   ============================================================ */
const { jsonResponse, readJson, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const pushLib = require('../_lib/push');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  const ru = reqUrl(req);
  const pathname = ru ? ru.pathname : '';

  if (req.method === 'GET') {
    const cfg = pushLib.vapidConfig();
    return jsonResponse(200, {
      ativo: !!cfg,
      vapidPublicKey: cfg ? cfg.pub : null,
    }, origin);
  }
  if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
  const body = await readJson(req);

  if (pathname.endsWith('/subscrever')) {
    try {
      const total = await pushLib.salvarInscricao(body && body.subscription);
      return jsonResponse(201, { inscritas: total }, origin);
    } catch (e) {
      return jsonResponse(400, { erro: e.message }, origin);
    }
  }
  if (pathname.endsWith('/remover')) {
    if (!body || !body.endpoint) return jsonResponse(400, { erro: 'Informe endpoint.' }, origin);
    const total = await pushLib.removerInscricao(String(body.endpoint));
    return jsonResponse(200, { inscritas: total }, origin);
  }
  return jsonResponse(404, { erro: 'Ação desconhecida (use /config, /subscrever ou /remover).' }, origin);
});
