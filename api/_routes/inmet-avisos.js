/* ============================================================
   GET /api/inmet-avisos  (proxy + cache curto)
     -> { avisos: [...], atualizadoEm, fonte }
     Params: ?uf=XX (opcional) filtra avisos que cobrem o UF.
   Fonte oficial: INMET (apiprevmet3.inmet.gov.br/avisos/ativos).
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const INMET_AVISOS_URL = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = { ts: 0, data: null };

async function fetchAvisos() {
    const now = Date.now();
    if (cache.data && now - cache.ts < CACHE_TTL_MS) return cache.data;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const res = await fetch(INMET_AVISOS_URL, {
            headers: { 'User-Agent': 'SGIProtege/1.0 (+painel-operacional)', 'Accept': 'application/json' },
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const avisos = [];
        const buckets = (j && typeof j === 'object') ? Object.values(j) : [];
        for (const b of buckets) {
            if (!Array.isArray(b)) continue;
            for (const a of b) avisos.push(a);
        }
        const data = { avisos, atualizadoEm: new Date().toISOString(), fonte: 'INMET (avisos ativos)' };
        cache = { ts: now, data };
        return data;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = serve(async function handler(req) {
    const origin = req.headers.get ? req.headers.get('origin') : undefined;
    if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (req.method !== 'GET') return jsonResponse(405, { erro: 'Metodo nao suportado.' }, origin);

    const ru = reqUrl(req);
    const uf = (ru && ru.searchParams.get('uf')) ? String(ru.searchParams.get('uf')).trim().toUpperCase() : null;

    try {
        const data = await fetchAvisos();
        let avisos = data.avisos || [];
        if (uf) {
            avisos = avisos.filter(a => {
                const munis = Array.isArray(a.municipios) ? a.municipios : [];
                return munis.some(m => String(m.uf || m.UF || '').toUpperCase() === uf) ||
                    String(a.uf || a.UF || '').toUpperCase() === uf;
            });
        }
        const res = jsonResponse(200, { avisos, atualizadoEm: data.atualizadoEm, fonte: data.fonte, total: avisos.length }, origin);
        Object.entries(cacheHeaders(600, 600)).forEach(([k, v]) => res.headers.set(k, v));
        return res;
    } catch (e) {
        return jsonResponse(502, { erro: 'Falha ao consultar avisos INMET.', detalhes: e.message }, origin);
    }
});
