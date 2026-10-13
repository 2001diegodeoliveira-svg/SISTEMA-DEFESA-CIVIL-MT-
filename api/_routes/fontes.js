/* ============================================================
   Saúde das fontes externas (Fase 2).
   GET /api/fontes/saude (público) -> estado de cada fonte do
   registro (api/_lib/origens.js) cruzado com o doc "fonte-saude"
   (atualizado pelo proxy a cada chamada, com throttle).
   Estados: ok | lento | fora (ver regra em estadoFonte).
   ============================================================ */
const { jsonResponse } = require('../_lib/http');
const { FONTES } = require('../_lib/origens');
const { readCollection } = require('../_lib/store');
const { serve } = require('../_lib/serverless');

function estadoFonte(cfg, saude) {
  const agora = Date.now();
  if (!saude || !saude.ultimoSucesso) return 'fora';
  const idadeSucesso = agora - Date.parse(saude.ultimoSucesso);
  const falhaDepois = saude.ultimaFalha && Date.parse(saude.ultimaFalha) > Date.parse(saude.ultimoSucesso);
  if (falhaDepois && idadeSucesso > cfg.ttlSeg * 1000 * 2) return 'fora';
  if (idadeSucesso <= cfg.ttlSeg * 1000 * 2) {
    if (saude.latenciaMs != null && saude.latenciaMs > cfg.timeoutMs * 0.8) return 'lento';
    return 'ok';
  }
  if (idadeSucesso <= cfg.ttlSeg * 1000 * 8) return 'lento';
  return 'fora';
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
  }
  let doc = null;
  try {
    const col = await readCollection('system_config');
    doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'fonte-saude');
  } catch {
    doc = null;
  }
  const mapa = (doc && doc.fontes && typeof doc.fontes === 'object') ? doc.fontes : {};
  return jsonResponse(200, {
    fontes: FONTES.map((f) => {
      const s = mapa[f.id] || {};
      return {
        id: f.id,
        hosts: f.hosts,
        ttlSeg: f.ttlSeg,
        estado: estadoFonte({ ttlSeg: f.ttlSeg, timeoutMs: f.timeoutMs }, s),
        ultimoSucesso: s.ultimoSucesso || null,
        ultimaFalha: s.ultimaFalha || null,
        latenciaMs: s.latenciaMs != null ? s.latenciaMs : null,
      };
    }),
    atualizadoEm: new Date().toISOString(),
  }, origin);
});

module.exports.estadoFonte = estadoFonte;
