/* ============================================================
   POST /api/enso/avaliar   (admin/avancado)
     Avalia uma medição contra as regras declarativas, com
     histerese e deduplicação, e registra alertas + auditoria.

     <- { valor, indice?, fonte?, confirmado? }
        valor: anomalia em °C (número finito; ex.: ONI 1.6).
        confirmado: true libera envio de nível alto PENDENTE
        recém-criado nesta mesma chamada (confirmação humana).
     <- { acao: 'confirmar', alertaId, aprovar?: true|false }
        Confirma (envia) ou dispensa um alerta PENDENTE.

     Regra de segurança: nível que exige confirmação NUNCA gera
     envio externo sem humano. Em dry-run (padrão), nenhum canal
     real é acionado — tudo é registrado em auditoria.
   ============================================================ */
const { jsonResponse, readJson, bearerToken } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');
const enso = require('../_lib/enso');

function perfilPode(payload) {
  return payload && ['admin', 'avancado'].includes(payload.perfil);
}

/** Envia os alertas AGUARDANDO_ENVIO e atualiza estado/auditoria. */
async function enviarPendentes(lista, regras, por) {
  const mapa = new Map((regras || []).map((r) => [r.id, r]));
  const resultados = [];
  for (const alerta of lista) {
    if (alerta.estado !== 'AGUARDANDO_ENVIO') continue;
    const regra = mapa.get(alerta.regraId) || { id: alerta.regraId, canais: ['webhook'] };
    const mensagem = `[SGI PROTEGE/ENOS] ${alerta.nivel} — regra ${alerta.regraId}: anomalia ${alerta.valor}°C (${alerta.indice || 'ONI'}). ${enso.DISCLAIMER}`;
    const envios = await enso.despachar(alerta, regra, mensagem);
    await enso.marcarAlertaEnviado(alerta.id, envios);
    resultados.push({ alertaId: alerta.id, envios });
  }
  return resultados;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!perfilPode(payload)) {
    return jsonResponse(403, { erro: 'Somente gestores (admin/avancado) podem avaliar o módulo ENOS.' }, origin);
  }
  const body = await readJson(req);

  // ---- confirmar / dispensar alerta pendente ----
  if (body && body.acao === 'confirmar') {
    if (!body.alertaId) return jsonResponse(400, { erro: 'Informe alertaId.' }, origin);
    let alerta;
    try {
      alerta = await enso.confirmarAlerta(String(body.alertaId), { por: payload.sub, aprovar: body.aprovar !== false });
    } catch (e) {
      return jsonResponse(400, { erro: e.message }, origin);
    }
    await enso.auditar('alerta_confirmado', {
      regra: alerta.regraId, nivel: alerta.nivel,
      gatilho: { valor: alerta.valor, indice: alerta.indice },
      por: payload.sub, horario: new Date().toISOString(),
      resultado: alerta.estado === 'DISPENSADO' ? 'DISPENSADO por humano' : 'CONFIRMADO por humano',
      alertaId: alerta.id,
    });
    let envios = [];
    if (alerta.estado === 'AGUARDANDO_ENVIO') {
      const { regras } = await enso.lerRegras();
      envios = await enviarPendentes([alerta], regras, payload.sub);
    }
    return jsonResponse(200, { alerta, envios }, origin);
  }

  // ---- avaliar medição ----
  const valor = body && body.valor;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    return jsonResponse(400, { erro: 'Informe valor numérico finito (anomalia em °C).' }, origin);
  }
  const medicao = {
    indice: (body && body.indice) || 'ONI',
    valor,
    fonte: (body && body.fonte) || 'manual',
    observadoEm: new Date().toISOString(),
  };

  const [limiares, regrasInfo, estadoAnterior] = await Promise.all([
    enso.lerLimiares(), enso.lerRegras(), enso.lerEstadoRegras(),
  ]);
  let classificacao;
  try {
    classificacao = enso.classificar(valor, limiares);
  } catch (e) {
    return jsonResponse(400, { erro: e.message }, origin);
  }
  const { transicoes, novoEstado } = enso.avaliarRegras(medicao, { regras: regrasInfo.regras, estadoAnterior });
  await enso.gravarEstadoRegras(novoEstado);

  const { lista, criados } = await enso.registrarAlertas(transicoes, medicao, { por: payload.sub, confirmado: body && body.confirmado === true });
  await enso.auditar('avaliacao', {
    gatilho: { valor, indice: medicao.indice, fonte: medicao.fonte },
    classificacao: { fase: classificacao.fase, intensidade: classificacao.intensidade },
    transicoes: transicoes.map((t) => `${t.regraId}:${t.tipo}`),
    por: payload.sub, horario: new Date().toISOString(), resultado: 'OK',
  });

  // Marca envio (dedup) para o que foi criado e envia o liberado.
  const agoraIso = new Date().toISOString();
  for (const c of criados) {
    if (c.estado === 'AGUARDANDO_ENVIO') enso.marcarEnvio(novoEstado, c.regraId, agoraIso);
  }
  await enso.gravarEstadoRegras(novoEstado);
  const paraEnvio = criados.filter((c) => c.estado === 'AGUARDANDO_ENVIO' && !c.reaproveitado);
  const envios = await enviarPendentes(paraEnvio, regrasInfo.regras, payload.sub);

  const pendentes = criados.filter((c) => c.estado === 'PENDENTE');
  return jsonResponse(200, {
    classificacao, transicoes, alertas: criados, envios,
    exigeConfirmacao: pendentes.map((p) => p.id),
    dryRun: enso.dryRunAtivo(),
  }, origin);
});
