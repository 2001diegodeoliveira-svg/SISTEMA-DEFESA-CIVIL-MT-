/* ============================================================
   GET  /api/pluv-alerta
     → { limiteMm, percentual, limiarMm, metrica, origem, estacoes, totalAcima }
     (estações opcionais: ?estacoes=<json url-encoded>)
     Sem ?estacoes devolve só a configuração.

   POST /api/pluv-alerta   (autenticado)
      → salva limiteMm, percentual e/ou ativo.
        Body: { limiteMm, percentual, ativo }

   DELETE /api/pluv-alerta  (autenticado)
     → apaga o override salvo e volta ao default de env.

   Este módulo é a fonte da verdade do limiar. O mapa.html só lê.
   ============================================================ */
const { jsonResponse, readJson, bearerToken, reqUrl } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');
const pluv = require('../_lib/pluvialerta');

function visaoConfig(cfg) {
  return {
    limiteMm: cfg.limiteMm,
    percentual: cfg.percentual,
    limiarMm: +(cfg.limiteMm * (cfg.percentual / 100)).toFixed(2),
    metrica: pluv.PADRAO.metrica,
    metricaRotulo: 'Acumulado 24h (mm)',
    ativo: cfg.ativo !== false,
    origem: cfg.origem,
    limites: pluv.LIMITES,
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  if (req.method === 'GET') {
    const cfg = await pluv.lerConfig();
    const base = visaoConfig(cfg);
    const ru = reqUrl(req);
    const raw = ru ? ru.searchParams.get('estacoes') : null;
    if (!raw) return jsonResponse(200, base, origin);
    let stations = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) stations = parsed;
    } catch {
      return jsonResponse(400, { erro: 'Parâmetro estacoes não é um JSON válido.' }, origin);
    }
    const r = pluv.avaliar(stations, cfg);
    return jsonResponse(200, { ...base, ...r }, origin);
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) {
      return jsonResponse(401, { erro: 'Autenticação necessária para alterar o alerta.' }, origin);
    }
    if (req.method === 'DELETE') {
      const cfg = await pluv.limparConfig();
      return jsonResponse(200, visaoConfig(cfg), origin);
    }
    const body = await readJson(req);
    if (body.limiteMm === undefined && body.percentual === undefined && typeof body.ativo !== 'boolean') {
      return jsonResponse(400, { erro: 'Informe limiteMm, percentual ou ativo.' }, origin);
    }
    const salvo = await pluv.gravarConfig({
      limiteMm: body.limiteMm,
      percentual: body.percentual,
      ativo: typeof body.ativo === 'boolean' ? body.ativo : undefined,
      updatedBy: payload.sub,
    });
    return jsonResponse(200, { ...visaoConfig({ ...salvo, origem: 'store' }), salvo }, origin);
  }

  return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
});
