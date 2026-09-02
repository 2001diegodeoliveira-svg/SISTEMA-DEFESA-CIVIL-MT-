/* Monitoramento e controle da Integração Waze.
   GET  /api/waze?action=status -> status da integração, métricas
   POST /api/waze?action=sync   -> força ciclo de sincronização (autenticado)
   GET  /api/waze?action=health -> healthcheck simples
*/
const { jsonResponse, reqUrl, bearerToken } = require('./_lib/http');
const { verifyToken } = require('./_lib/auth');
const { serve } = require('./_lib/serverless');
const waze = require('./_lib/waze');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  const url = reqUrl(req);
  const action = url ? (url.searchParams.get('action') || 'status') : 'status';

  if (req.method === 'GET' && action === 'status') {
    const status = waze.getStatus();
    let mensagem = 'Integração Waze conectada.';
    if (status.status === 'AGUARDANDO_CONFIGURACAO') mensagem = 'Integração Waze aguardando configuração oficial.';
    else if (status.mockEnabled) mensagem = 'Modo demonstração — dados simulados.';
    else if (status.status === 'ERRO') mensagem = 'Erro na integração Waze — consulte lastError.';
    return jsonResponse(200, { ...status, mensagem, logs: waze.logger.history(20) }, origin);
  }

  if (req.method === 'GET' && action === 'health') {
    const status = waze.getStatus();
    return jsonResponse(200, { ok: true, status: status.status, lastSyncAt: status.lastSyncAt }, origin);
  }

  if (req.method === 'POST' && action === 'sync') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
    const result = await waze.runSyncCycle();
    return jsonResponse(result.ok ? 200 : 502, result, origin);
  }

  return jsonResponse(405, { erro: 'Método/ação não suportados.' }, origin);
});
