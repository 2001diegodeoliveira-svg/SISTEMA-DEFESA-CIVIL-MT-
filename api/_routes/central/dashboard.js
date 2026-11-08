/* Central de Ocorrências — indicadores operacionais do dashboard.

   GET /api/central/dashboard?tipo=&prioridade=&status=&de=&ate=&q=
*/
'use strict';

const { jsonResponse, reqUrl } = require('../../_lib/http');
const { serve } = require('../../_lib/serverless');
const central = require('../../_lib/central');

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  try {
    const escopo = await central.autenticar(req);
    const url = reqUrl(req);
    const q = (nome) => (url ? (url.searchParams.get(nome) || '') : '');
    const filtros = {
      tipo: q('tipo').toUpperCase(),
      prioridade: q('prioridade').toUpperCase(),
      status: q('status').toUpperCase(),
      verificacao: q('verificacao').toUpperCase(),
      de: q('de'),
      ate: q('ate'),
      q: q('q'),
    };
    if (escopo.municipioRestrito) {
      const municipio = await central.resolverMunicipio({ municipio: escopo.municipioRestrito });
      if (!municipio) {
        return jsonResponse(200, { indicadores: null, vazio: true }, origin);
      }
      filtros.municipioId = municipio.id;
      filtros.municipioNome = municipio.nome;
    }
    const indicadores = await central.estatisticas(filtros);
    return jsonResponse(200, { indicadores }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
