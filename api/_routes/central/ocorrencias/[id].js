/* Central de Ocorrências — detalhe e atualização.

   GET   /api/central/ocorrencias/:id → detalhe + histórico + danos + equipes + anexos
   PATCH /api/central/ocorrencias/:id → atualiza campos, prioridade, status (com justificativa)
   DELETE → não suportado (arquivamento é um status, preserva histórico)
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../../_lib/http');
const { serve } = require('../../../_lib/serverless');
const central = require('../../../_lib/central');

function idDaUrl(url) {
  const partes = url ? url.pathname.split('/').filter(Boolean) : [];
  const bruto = partes[partes.length - 1];
  try {
    return bruto ? decodeURIComponent(bruto) : '';
  } catch {
    return '';
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  try {
    const escopo = await central.autenticar(req);
    const id = idDaUrl(reqUrl(req));
    if (!id) return jsonResponse(400, { erro: 'Identificador de ocorrência obrigatório.' }, origin);

    if (req.method === 'GET') {
      const ocorrencia = await central.obterOcorrencia(id, {
        historico: true,
        dadosRestritos: central.podeVerDadosRestritos(escopo),
      });
      if (!ocorrencia) return jsonResponse(404, { erro: 'Ocorrência não encontrada.' }, origin);
      if (escopo.municipioRestrito &&
          central.normalizar(ocorrencia.municipio) !== escopo.municipioRestrito) {
        return jsonResponse(403, { erro: 'Acesso limitado às ocorrências do seu município.' }, origin);
      }
      return jsonResponse(200, { ocorrencia }, origin);
    }

    const body = await readJson(req);
    const ocorrencia = await central.atualizarOcorrencia(id, body, escopo);
    return jsonResponse(200, { ocorrencia }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
