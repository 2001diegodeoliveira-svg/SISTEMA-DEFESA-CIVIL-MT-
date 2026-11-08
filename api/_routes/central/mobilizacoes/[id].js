/* Central de Ocorrências — atualização de mobilização.

   PATCH /api/central/mobilizacoes/:id { status, atividades }
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../../_lib/http');
const { serve } = require('../../../_lib/serverless');
const central = require('../../../_lib/central');

function idDaUrl(url) {
  const partes = url ? url.pathname.split('/').filter(Boolean) : [];
  try {
    return partes.length ? decodeURIComponent(partes[partes.length - 1]) : '';
  } catch {
    return '';
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'PATCH') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  try {
    const escopo = await central.autenticar(req);
    const id = idDaUrl(reqUrl(req));
    if (!id) return jsonResponse(400, { erro: 'Identificador de mobilização obrigatório.' }, origin);
    const mobilizacao = await central.atualizarMobilizacao(id, await readJson(req), escopo);
    return jsonResponse(200, { mobilizacao }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
