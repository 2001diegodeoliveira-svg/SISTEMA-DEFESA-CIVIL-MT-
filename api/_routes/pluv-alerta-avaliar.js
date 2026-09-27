/* ============================================================
   POST /api/pluv-alerta/avaliar   (somente leitura, sem JWT)

   O mapa envia as estações que já coletou do INMET e o SERVIDOR
   devolve o limiar efetivo e quais estações cruzaram. Assim o
   cliente não tem como inventar um critério diferente do
   configurado — ele só exibe o que o servidordecided.

   Não grava nada, por isso não exige autenticação. Body:
   { estacoes: [{ codigo, nome, lat, lon, c24 }] }

   → { limiteMm, percentual, limiarMm, metrica, origem,
       totalAvaliadas, totalAcima,
       estacoes: [{ codigo, nome, lat, lon, c24, percentual, acima }] }

   A rota GET /api/pluv-alerta aceita ?estacoes=<json> com o mesmo
   cálculo, mas em query string. Isso quebra com a lista inteira de
   estações do INMET MT (URL longa demais), então o mapa usa o POST.
   ============================================================ */
const { jsonResponse, readJson } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const pluv = require('../_lib/pluvialerta');

/* Teto de segurança: a lista do INMET MT tem ~150 estações. */
const MAX_ESTACOES = 500;

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Use POST para avaliar estações.' }, origin);
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return jsonResponse(400, { erro: 'Corpo JSON inválido.' }, origin);
  }

  const estacoes = Array.isArray(body && body.estacoes) ? body.estacoes : [];
  if (!estacoes.length) {
    return jsonResponse(400, { erro: 'Informe ao menos uma estação em "estacoes".' }, origin);
  }
  if (estacoes.length > MAX_ESTACOES) {
    return jsonResponse(413, { erro: `Máximo de ${MAX_ESTACOES} estações por requisição.` }, origin);
  }

  const cfg = await pluv.lerConfig();
  const r = pluv.avaliar(estacoes, cfg);

  return jsonResponse(200, {
    limiteMm: cfg.limiteMm,
    percentual: cfg.percentual,
    limiarMm: +(cfg.limiteMm * (cfg.percentual / 100)).toFixed(2),
    metrica: pluv.PADRAO.metrica,
    /* O mapa respeita isto: com ativo=false ele não abre popup algum. */
    ativo: cfg.ativo !== false,
    origem: cfg.origem,
    totalAvaliadas: r.totalAvaliadas,
    totalAcima: r.totalAcima,
    /* Só o que cruzou o limiar: o mapa abre o popup para estes. */
    acima: cfg.ativo === false ? [] : r.estacoes.filter((e) => e.acima),
    /* Todos os valores, para a tabela do mapa pintar a linha. */
    estacoes: r.estacoes,
  }, origin);
});
