/* ============================================================
   GET/POST /api/enso/cron  (agendador automático do ENOS)
     Protegido por segredo: Authorization: Bearer <ENSO_CRON_SECRET
     ou CRON_SECRET>. Na Vercel, o Cron envia automaticamente quando
     CRON_SECRET está definido.

     Dispara a coleta (executarColeta, usarMock=false) e avalia a
     última medição contra as regras, registrando alertas + auditoria.
   ============================================================ */
const { jsonResponse } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const enso = require('../_lib/enso');

function segredo() {
  return (process.env.ENSO_CRON_SECRET || process.env.CRON_SECRET || '').trim();
}

function autorizado(req) {
  const s = segredo();
  if (!s) {
    // Sem segredo configurado: só permite fora de produção.
    const prod = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
    return !prod;
  }
  const h = (req.headers && typeof req.headers.get === 'function')
    ? req.headers.get('authorization')
    : (req.headers && req.headers.authorization);
  const m = String(h || '').match(/^Bearer\s+(.+)$/i);
  return !!m && m[1].trim() === s;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && typeof req.headers.get === 'function' ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (!autorizado(req)) return jsonResponse(401, { erro: 'Segredo de cron inválido ou ausente.' }, origin);
  if (req.method !== 'GET' && req.method !== 'POST') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const prod = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  if (prod && !segredo()) {
    return jsonResponse(503, { erro: 'ENSO_CRON_SECRET/CRON_SECRET não configurado em produção.' }, origin);
  }

  let coleta;
  try {
    coleta = await enso.executarColeta({ usarMock: false, timeoutMs: 15000 });
  } catch (e) {
    await enso.auditar('coleta_cron', { por: 'cron', horario: new Date().toISOString(), resultado: `FALHA: ${e.message}` });
    return jsonResponse(502, { erro: 'Falha na coleta automática.', detalhes: e.message }, origin);
  }

  await enso.auditar('coleta_cron', {
    por: 'cron', horario: new Date().toISOString(),
    resultado: `OK (${coleta.amostras.length} amostra(s))`,
    fontes: Object.keys(coleta.fontes || {}),
  });

  // Avalia a última medição contra as regras (dispara alertas se aplicável).
  let avaliacao = null;
  try {
    const amostra = await enso.ultimaAmostra('ONI');
    if (amostra && typeof amostra.valor === 'number' && Number.isFinite(amostra.valor)) {
      const limiares = await enso.lerLimiares();
      const regrasInfo = await enso.lerRegras();
      const estadoAnterior = await enso.lerEstadoRegras();
      const classificacao = enso.classificar(amostra.valor, limiares);
      const medicao = {
        indice: amostra.indice || 'ONI',
        valor: amostra.valor,
        fonte: amostra.fonte || 'cron',
        observadoEm: amostra.observadoEm,
      };
      const { transicoes, novoEstado } = enso.avaliarRegras(medicao, { regras: regrasInfo.regras, estadoAnterior });
      await enso.gravarEstadoRegras(novoEstado);
      const { criados } = await enso.registrarAlertas(transicoes, medicao, { por: 'cron' });
      const agoraIso = new Date().toISOString();
      for (const c of criados || []) {
        if (c.estado === 'AGUARDANDO_ENVIO') enso.marcarEnvio(novoEstado, c.regraId, agoraIso);
      }
      await enso.gravarEstadoRegras(novoEstado);
      await enso.auditar('avaliacao_cron', {
        gatilho: { valor: amostra.valor, indice: medicao.indice, fonte: medicao.fonte },
        classificacao: { fase: classificacao.fase, intensidade: classificacao.intensidade },
        transicoes: (transicoes || []).map((t) => `${t.regraId}:${t.tipo}`),
        por: 'cron', horario: agoraIso, resultado: 'OK',
      });
      avaliacao = { classificacao, transicoes, alertas: (criados || []).length };
    }
  } catch (e) {
    loggerWarn(e);
  }

  return jsonResponse(200, {
    coletado: true,
    amostras: coleta.amostras.length,
    fontes: coleta.fontes,
    avaliacao,
  }, origin);
});

function loggerWarn(e) {
  try { console.warn('[enso-cron] avaliação falhou:', e && e.message); } catch {}
}