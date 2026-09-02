/* Ocorrências (modelo interno alimentado pela Integração Waze).
   GET /api/occurrences?source=&type=&priority=&status=&period=
   GET /api/occurrences?view=map    -> só campos necessários pro mapa
   GET /api/occurrences?view=stats  -> indicadores para o dashboard
   GET /api/occurrences?view=waze   -> só ocorrências source=WAZE
   Rota única (Vercel/serverless não tem sub-rotas dinâmicas fáceis
   sem arquivos extra) — usamos ?view= para as variações, e
   frontend/api/occurrences/[id].js para o detalhe/patch por id.
*/
const { jsonResponse, reqUrl } = require('./_lib/http');
const { readCollection } = require('./_lib/store');
const { serve } = require('./_lib/serverless');

const STATUSES = ['NOVA', 'EM_ANALISE', 'EM_ATENDIMENTO', 'ENCAMINHADA', 'RESOLVIDA', 'ENCERRADA'];

function withinPeriod(o, period) {
  if (!period || period === 'all') return true;
  const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 }[period];
  if (!hours) return true;
  return Date.now() - (o.reportedAt || o.receivedAt || 0) <= hours * 3600 * 1000;
}

function applyFilters(list, q) {
  return list.filter((o) => {
    if (q.get('source') && o.source !== q.get('source').toUpperCase()) return false;
    if (q.get('type') && o.type !== q.get('type').toUpperCase()) return false;
    if (q.get('priority') && o.priority !== q.get('priority').toUpperCase()) return false;
    if (q.get('status') && o.status !== q.get('status').toUpperCase()) return false;
    if (!withinPeriod(o, q.get('period'))) return false;
    return true;
  });
}

function countBy(list, field) {
  const out = {};
  for (const item of list) {
    const key = item[field] || 'N/A';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  const url = reqUrl(req);
  const view = url ? url.searchParams.get('view') : null;
  const all = await readCollection('occurrences');

  if (view === 'stats') {
    const last24h = all.filter((o) => Date.now() - (o.reportedAt || 0) <= 24 * 3600 * 1000);
    const active = all.filter((o) => !['RESOLVIDA', 'ENCERRADA'].includes(o.status));
    return jsonResponse(200, {
      total: all.length,
      criticas: all.filter((o) => o.priority === 'CRITICA').length,
      altas: all.filter((o) => o.priority === 'ALTA').length,
      ativas: active.length,
      ultimas24h: last24h.length,
      waze: all.filter((o) => o.source === 'WAZE').length,
      porTipo: countBy(all, 'type'),
      porPrioridade: countBy(all, 'priority'),
      porMunicipio: countBy(all, 'city'),
    }, origin);
  }

  const filtered = applyFilters(view === 'waze' ? all.filter((o) => o.source === 'WAZE') : all, url.searchParams)
    .sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0));

  if (view === 'map') {
    const points = filtered
      .filter((o) => o.latitude != null && o.longitude != null)
      .map((o) => ({ id: o.id, type: o.type, priority: o.priority, status: o.status, source: o.source, latitude: o.latitude, longitude: o.longitude, street: o.street, city: o.city, reportedAt: o.reportedAt }));
    return jsonResponse(200, { points, total: points.length }, origin);
  }

  return jsonResponse(200, { occurrences: filtered, total: filtered.length, statusesDisponiveis: STATUSES }, origin);
});
