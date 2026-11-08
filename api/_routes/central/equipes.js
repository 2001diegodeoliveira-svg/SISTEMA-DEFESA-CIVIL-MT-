/* Central de Ocorrências — equipes operacionais.

   GET  /api/central/equipes[?incluirInativas=1]
   POST /api/central/equipes { nome, tipo, responsavel, contato }
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
      const equipes = await central.listarEquipes({
        incluirInativas: Boolean(url && url.searchParams.get('incluirInativas')),
      });
      return jsonResponse(200, { equipes }, origin);
    }

    const body = await readJson(req);
    const dados = {
      nome: body.nome,
      tipo: body.tipo,
      responsavel: body.responsavel,
      contato: body.contato,
      territorioId: body.territorioId || null,
      organizacaoId: await central.resolverOrganizacao(escopo),
    };
    const equipe = await central.criarEquipe(dados, escopo);
    return jsonResponse(201, { equipe }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
