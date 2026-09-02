/* Monitoramento e controle da Integração TomTom Traffic.
   GET  /api/tomtom?action=status
   POST /api/tomtom?action=sync (autenticado)
   GET  /api/tomtom?action=health
*/
const { jsonResponse, reqUrl, bearerToken } = require('./_lib/http');
const { verifyToken } = require('./_lib/auth');
const { serve } = require('./_lib/serverless');
const tomtom = require('./_lib/tomtom');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  const url = reqUrl(req);
  const action = url ? (url.searchParams.get('action') || 'status') : 'status';

  if (req.method === 'GET' && action === 'status') {
    const status = tomtom.getStatus();
    let mensagem = 'Integração TomTom conectada.';
    if (status.status === 'AGUARDANDO_CONFIGURACAO') mensagem = 'Integração TomTom aguardando configuração (TOMTOM_API_KEY).';
    else if (status.mockEnabled) mensagem = 'Modo demonstração — dados simulados.';
    else if (status.status === 'ERRO') mensagem = 'Erro na integração TomTom — consulte lastError.';
    return jsonResponse(200, { ...status, mensagem }, origin);
  }

  if (req.method === 'GET' && action === 'health') {
    const status = tomtom.getStatus();
    return jsonResponse(200, { ok: true, status: status.status, lastSyncAt: status.lastSyncAt }, origin);
  }

  if (req.method === 'POST' && action === 'sync') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
    const result = await tomtom.runSyncCycle();
    return jsonResponse(result.ok ? 200 : 502, result, origin);
  }

  return jsonResponse(405, { erro: 'Método/ação não suportados.' }, origin);
});
