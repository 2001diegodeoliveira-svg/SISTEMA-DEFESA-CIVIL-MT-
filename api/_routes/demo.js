/* GET /api/demo → estado da janela de demonstração.
   Também registra o primeiro acesso quando ainda não existe.
   Com AUTH_SUSPENDED ativo: não registra nada (sem escrita) e informa
   a suspensão para o frontend exibir o banner. */
const { jsonResponse } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { demoAtualizar, demoEstado } = require('../_lib/demo');
const { isLoginEnabled, isSuspended, maintenanceUntilMs } = require('../_lib/runtime-config');

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  const suspenso = isSuspended();
  const ateMs = maintenanceUntilMs();
  const manutencaoAte = ateMs === null ? null : new Date(ateMs).toISOString();
  /* Suspenso: nenhuma escrita (não registra marco de demo). */
  if (!suspenso) {
    await demoAtualizar();
  }
  const estado = demoEstado();
  return jsonResponse(200, {
    ...estado,
    aberto: suspenso ? false : estado.aberto,
    loginHabilitado: isLoginEnabled(),
    suspenso,
    manutencaoAte,
    mensagem: suspenso ? 'Login suspenso para manutenção.' : null,
  }, origin);
});
