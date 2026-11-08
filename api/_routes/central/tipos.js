/* Central de Ocorrências — catálogo de tipos.

   GET  /api/central/tipos[?incluirInativos=1]
   POST /api/central/tipos  { codigo, nome, grupo, descricao, ordem }
   Escrita restrita a perfis de gestão (admin/avancado) e coordenação.
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../_lib/http');
const { serve } = require('../../_lib/serverless');
const central = require('../../_lib/central');

const PERFIS_CATALOGO = new Set(['admin', 'avancado']);

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
      const incluirInativos = Boolean(url && url.searchParams.get('incluirInativos'));
      const tipos = await central.listarTipos({ incluirInativos });
      return jsonResponse(200, { tipos, grupos: central.GRUPOS_TIPO }, origin);
    }

    const tipo = await central.criarTipo(await readJson(req));
    return jsonResponse(201, { tipo }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
