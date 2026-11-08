/* Central de Ocorrências — mobilizações de equipes.

   GET  /api/central/mobilizacoes?ocorrenciaId=&equipeId=&status=
   POST /api/central/mobilizacoes { equipeId, ocorrenciaId, atividades, recursos }
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../_lib/http');
const { serve } = require('../../_lib/serverless');
const central = require('../../_lib/central');

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  try {
    const escopo = await central.autenticar(req);

    if (req.method === 'GET') {
      const url = reqUrl(req);
      const q = (nome) => (url ? (url.searchParams.get(nome) || '') : '');
      const mobilizacoes = await central.listarMobilizacoes({
        ocorrenciaId: q('ocorrenciaId'),
        equipeId: q('equipeId'),
        status: q('status').toLowerCase(),
      });
      return jsonResponse(200, { mobilizacoes }, origin);
    }

    const body = await readJson(req);
    const organizacaoId = await central.resolverOrganizacao(escopo);
    const mobilizacao = await central.criarMobilizacao({
      equipeId: body.equipeId,
      ocorrenciaId: body.ocorrenciaId,
      atividades: body.atividades,
      recursos: body.recursos,
      status: body.status,
      organizacaoId,
    }, escopo);
    return jsonResponse(201, { mobilizacao }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
