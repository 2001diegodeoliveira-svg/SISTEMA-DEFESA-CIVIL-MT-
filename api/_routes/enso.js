/* ============================================================
   GET  /api/enso            (público)
     -> { estado, classificacao|null, limiares, regras, fontes,
          fonteStatus, disclaimer, dryRun, atualizadoEm }
        Sem amostra armazenada: estado 'SEM_DADOS' (sem inventar
        dados; a página exibe aguardo de coleta).
   POST /api/enso            (admin/avancado)
     <- { limiares?, regras?, acao?: 'coletar', usarMock? }
        Salva overrides de limiares/regras OU dispara coleta
        manual (coletores isolados; falha de fonte não derruba).
   DELETE /api/enso          (admin/avancado)
     -> apaga overrides (volta a env/padrão).
   ============================================================ */
const { jsonResponse, readJson, bearerToken, reqUrl } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');
const enso = require('../_lib/enso');

function perfilPode(payload) {
  return payload && ['admin', 'avancado'].includes(payload.perfil);
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);

  if (req.method === 'GET') {
    const [limiares, regrasInfo, fontesInfo, amostra, fonteStatus, alertas] = await Promise.all([
      enso.lerLimiares(),
      enso.lerRegras(),
      Promise.resolve(enso.lerFontes()),
      enso.ultimaAmostra(),
      enso.lerFonteStatus(),
      enso.lerAlertas(),
    ]);
    let classificacao = null;
    let estado = 'SEM_DADOS';
    if (amostra && typeof amostra.valor === 'number' && Number.isFinite(amostra.valor)) {
      try {
        classificacao = enso.classificar(amostra.valor, limiares);
        estado = classificacao.fase === 'NEUTRO' ? 'NEUTRO' : classificacao.fase;
      } catch {
        classificacao = null;
      }
    }
    const pendentes = alertas.filter((a) => a.estado === 'PENDENTE').length;
    return jsonResponse(200, {
      estado,
      classificacao,
      amostra,
      limiares: { valores: { neutroBanda: limiares.neutroBanda, fraco: limiares.fraco, moderado: limiares.moderado, forte: limiares.forte, muitoForte: limiares.muitoForte }, origem: limiares.origem },
      regras: { lista: regrasInfo.regras, origem: regrasInfo.origem },
      fontes: fontesInfo,
      fonteStatus,
      alertasPendentes: pendentes,
      disclaimer: enso.DISCLAIMER,
      dryRun: enso.dryRunAtivo(),
      atualizadoEm: amostra ? (amostra.registradoEm || amostra.observadoEm) : null,
    }, origin);
  }

  if (req.method === 'POST' || req.method === 'DELETE') {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!perfilPode(payload)) {
      return jsonResponse(403, { erro: 'Somente gestores (admin/avancado) podem alterar o módulo ENOS.' }, origin);
    }
    if (req.method === 'DELETE') {
      const [limiares, regrasInfo] = await Promise.all([enso.limparLimiares(), enso.limparRegras()]);
      await enso.auditar('config_limpa', { por: payload.sub, horario: new Date().toISOString(), resultado: 'OK' });
      return jsonResponse(200, { limiares, regras: regrasInfo }, origin);
    }
    const body = await readJson(req);
    if (body && body.acao === 'coletar') {
      const r = await enso.executarColeta({ usarMock: body.usarMock !== false });
      await enso.auditar('coleta_manual', {
        por: payload.sub, horario: new Date().toISOString(),
        resultado: `OK (${r.amostras.length} amostra(s))`, usarMock: body.usarMock !== false,
      });
      return jsonResponse(200, { amostras: r.amostras, fontes: r.fontes }, origin);
    }
    if (!body || (body.limiares === undefined && body.regras === undefined)) {
      return jsonResponse(400, { erro: 'Informe limiares, regras ou {acao:"coletar"}.' }, origin);
    }
    const out = {};
    if (body.limiares !== undefined) out.limiares = await enso.gravarLimiares(body.limiares, payload.sub);
    if (body.regras !== undefined) {
      const regras = Array.isArray(body.regras) ? body.regras : body.regras.regras;
      out.regras = await enso.gravarRegras(regras, payload.sub);
    }
    await enso.auditar('config_salva', { por: payload.sub, horario: new Date().toISOString(), resultado: 'OK', chaves: Object.keys(out) });
    return jsonResponse(200, out, origin);
  }

  return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
});
