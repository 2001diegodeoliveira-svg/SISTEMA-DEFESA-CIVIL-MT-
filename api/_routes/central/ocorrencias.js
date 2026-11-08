/* Central de Ocorrências — lista e cadastro.

   GET  /api/central/ocorrencias?protocolo=&tipo=&prioridade=&status=&verificacao=
                                &municipioId=&responsavelId=&de=&ate=&q=&limite=&deslocamento=
   POST /api/central/ocorrencias  → cria ocorrência com protocolo automático
*/
'use strict';

const { jsonResponse, readJson, reqUrl } = require('../../_lib/http');
const { serve } = require('../../_lib/serverless');
const central = require('../../_lib/central');

function filtrosDaUrl(url) {
  const q = (nome) => (url ? (url.searchParams.get(nome) || '') : '');
  return {
    protocolo: q('protocolo'),
    tipo: q('tipo').toUpperCase(),
    prioridade: q('prioridade').toUpperCase(),
    status: q('status').toUpperCase(),
    verificacao: q('verificacao').toUpperCase(),
    municipioId: q('municipioId'),
    responsavelId: q('responsavelId'),
    de: q('de'),
    ate: q('ate'),
    q: q('q'),
    limite: q('limite'),
    deslocamento: q('deslocamento'),
  };
}

/* Converte a restrição municipal (perfil municipal) em filtro efetivo. */
async function aplicarRestricaoMunicipal(filtros, escopo) {
  if (!escopo.municipioRestrito) return filtros;
  const municipio = await central.resolverMunicipio({ municipio: escopo.municipioRestrito });
  if (!municipio) return { ...filtros, semResultados: true };
  return {
    ...filtros,
    municipioRestritoId: municipio.id,
    municipioId: municipio.id || filtros.municipioId,
    municipioNome: municipio.nome || escopo.municipioRestrito,
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  try {
    const escopo = await central.autenticar(req);

    if (req.method === 'GET') {
      let filtros = filtrosDaUrl(reqUrl(req));
      filtros = await aplicarRestricaoMunicipal(filtros, escopo);
      if (filtros.semResultados) {
        return jsonResponse(200, {
          ocorrencias: [], total: 0,
          statuses: central.STATUS_VALIDOS,
          prioridades: central.PRIORIDADES,
          verificacoes: central.VERIFICACOES,
        }, origin);
      }
      const ocorrencias = await central.listarOcorrencias(filtros, {
        limite: filtros.limite,
        deslocamento: filtros.deslocamento,
      });
      return jsonResponse(200, {
        ocorrencias,
        total: ocorrencias.length,
        statuses: central.STATUS_VALIDOS,
        prioridades: central.PRIORIDADES,
        verificacoes: central.VERIFICACOES,
      }, origin);
    }

    const body = await readJson(req);
    const dados = central.normalizarNovaOcorrencia(body);
    dados.organizacaoId = await central.resolverOrganizacao(escopo);
    dados.territorioId = body.territorioId && typeof body.territorioId === 'string' ? body.territorioId : null;
    const ocorrencia = await central.criarOcorrencia(dados, escopo);
    return jsonResponse(201, { ocorrencia }, origin);
  } catch (e) {
    return central.responderErro(e, origin);
  }
});
