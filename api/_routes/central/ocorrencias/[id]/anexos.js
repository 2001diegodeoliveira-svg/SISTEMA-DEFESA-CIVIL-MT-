/* Central de Ocorrências — anexos (metadados) da ocorrência.

   GET  /api/central/ocorrencias/:id/anexos
   POST /api/central/ocorrencias/:id/anexos { nome, mimeType, url, tamanhoBytes, hashSha256 }
   O binário não é recebido aqui: a API registra a referência ao arquivo.
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../../../_lib/http');
const { serve } = require('../../../../_lib/serverless');
const central = require('../../../../_lib/central');

function idDaUrl(url) {
  const partes = url ? url.pathname.split('/').filter(Boolean) : [];
  /* .../ocorrencias/<id>/anexos */
  const bruto = partes[partes.length - 2];
  try {
    return bruto ? decodeURIComponent(bruto) : '';
  } catch {
    return '';
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  try {
    const escopo = await central.autenticar(req);
    const ocorrenciaId = idDaUrl(reqUrl(req));
    if (!ocorrenciaId) return jsonResponse(400, { erro: 'Identificador de ocorrência obrigatório.' }, origin);

    if (req.method === 'GET') {
      const anexos = await central.listarAnexos(ocorrenciaId);
      return jsonResponse(200, { anexos }, origin);
    }
    const anexo = await central.criarAnexo(ocorrenciaId, await readJson(req), escopo);
    return jsonResponse(201, { anexo }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
