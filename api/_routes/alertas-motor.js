/* ============================================================
   Motor de alertas — endpoints (Fase 5).
   GET  /api/alertas-motor/eventos?uf=&tipo=&desde=&limit=
        público: fila de eventos (novos primeiro).
   POST /api/alertas-motor/avaliar
        cron/agendador: Authorization: Bearer <ALERTAS_CRON_SECRET>
        ou JWT admin/avancado. Avalia todas as áreas, cria eventos,
        dispara push+telegram e audita. Nunca expõe segredos.
   POST /api/alertas-motor/reconhecer  {id}
        autenticado: marca evento como reconhecido/tratado.
   ============================================================ */
const { jsonResponse, readJson, bearerToken, reqUrl } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');
const motor = require('../_lib/motor');
const { lerAreas } = require('./areas-monitoradas');
const pushLib = require('../_lib/push');
const telegram = require('../_lib/telegram');

function mapaUrl() {
  const base = (process.env.PUBLIC_MAP_URL || '').trim().replace(/\/+$/, '');
  return (base || '') + '/mapa.html';
}

function podeAvaliar(req) {
  const segredo = (process.env.ALERTAS_CRON_SECRET || '').trim();
  const token = bearerToken(req);
  if (segredo && token === segredo) return { ok: true, por: 'cron' };
  const p = token && verifyToken(token);
  if (p && ['admin', 'avancado'].includes(p.perfil)) return { ok: true, por: p.sub };
  return { ok: false };
}

function textoEvento(ev) {
  return `SGI PROTEGE — ${ev.severidade.toUpperCase()}\n${ev.titulo}\n${ev.detalhe || ''}\nMapa: ${mapaUrl()}`;
}

async function disparar(novos, area) {
  const resultados = [];
  const payload = (ev) => ({
    title: `SGI PROTEGE — ${ev.severidade}`,
    body: ev.titulo,
    url: mapaUrl(),
    tag: ev.id,
  });
  // Web Push (broadcast p/ inscritos, quando configurado).
  if (area.canais.push !== false) {
    const subs = await pushLib.lerInscricoes();
    for (const ev of novos) {
      const r = await pushLib.enviarPush(subs, payload(ev));
      resultados.push(...r.map((x) => ({ ...x, alertaId: ev.id })));
      await motor.auditar('alerta_envio', {
        regra: ev.tipo, nivel: ev.severidade, gatilho: ev.dados || {},
        canal: 'push', horario: new Date().toISOString(),
        resultado: r.some((x) => x.ok) ? `OK (${r.filter((x) => x.ok).length})` : `FALHA: ${(r[0] && r[0].erro) || 'sem inscritos'}`,
        alertaId: ev.id, areaId: area.id,
      });
    }
  }
  // Telegram (chats da área, quando configurado).
  const chats = (area.canais.telegramChats || []).filter(Boolean);
  if (area.canais.telegram && chats.length) {
    for (const ev of novos) {
      for (const chat of chats) {
        const r = await telegram.enviarMensagem(chat, textoEvento(ev));
        resultados.push({ ...r, alertaId: ev.id });
        await motor.auditar('alerta_envio', {
          regra: ev.tipo, nivel: ev.severidade, gatilho: ev.dados || {},
          canal: 'telegram', horario: new Date().toISOString(),
          resultado: r.ok ? 'OK' : `FALHA: ${r.erro}`,
          alertaId: ev.id, areaId: area.id,
        });
      }
    }
  }
  return resultados;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  const ru = reqUrl(req);
  const pathname = ru ? ru.pathname : '';

  // ---- fila de eventos (pública) ----
  if (req.method === 'GET') {
    const q = ru ? ru.searchParams : new URLSearchParams();
    const lista = await motor.lerEventos();
    const uf = (q.get('uf') || '').toUpperCase();
    const tipo = q.get('tipo') || '';
    const desdeNum = q.get('desde') ? Date.parse(q.get('desde')) : 0;
    const desde = Number.isFinite(desdeNum) ? desdeNum : 0;
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50));
    const out = lista
      .filter((e) => (!uf || (e.uf || '').toUpperCase() === uf)
        && (!tipo || e.tipo === tipo)
        && Date.parse(e.criadoEm) >= desde)
      .slice(-limit)
      .reverse();
    return jsonResponse(200, {
      total: out.length,
      eventos: out,
      atualizadoEm: new Date().toISOString(),
    }, origin);
  }

  if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
  const body = await readJson(req);

  // ---- reconhecer (autenticado) ----
  if (pathname.endsWith('/reconhecer')) {
    const token = bearerToken(req);
    const payload = token && verifyToken(token);
    if (!payload) return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);
    if (!body || !body.id) return jsonResponse(400, { erro: 'Informe id.' }, origin);
    const lista = await motor.lerEventos();
    const ev = lista.find((e) => String(e.id) === String(body.id));
    if (!ev) return jsonResponse(404, { erro: 'Evento não encontrado.' }, origin);
    ev.estado = 'reconhecido';
    ev.reconhecidoPor = payload.sub || null;
    ev.reconhecidoEm = new Date().toISOString();
    await motor.gravarEventos(lista);
    await motor.auditar('alerta_reconhecido', {
      alertaId: ev.id, areaId: ev.areaId, por: payload.sub,
      horario: ev.reconhecidoEm, resultado: 'OK',
    });
    return jsonResponse(200, { evento: ev }, origin);
  }

  // ---- avaliar (cron ou gestor) ----
  if (pathname.endsWith('/avaliar')) {
    const auth = podeAvaliar(req);
    if (!auth.ok) return jsonResponse(401, { erro: 'Autenticação necessária (cron secret ou gestor).' }, origin);
    const todas = await lerAreas();
    const ids = body && Array.isArray(body.areas) ? new Set(body.areas.map(String)) : null;
    const areas = ids ? todas.filter((a) => ids.has(String(a.id))) : todas;
    const snaps = await motor.lerSnapshots();
    const ctx = { snaps };
    let criados = 0;
    const erros = [];
    const envios = [];
    for (const area of areas) {
      let r;
      try {
        r = await motor.avaliarArea(area, undefined, ctx);
      } catch (e) {
        erros.push(`${area.id}: ${e.message}`);
        continue;
      }
      for (const e of r.erros || []) erros.push(`${area.id}: ${e}`);
      if (!r.eventos.length) continue;
      const novos = await motor.registrarEventos(area, r.eventos);
      criados += novos.length;
      if (novos.length) {
        await motor.auditar('alerta_disparado', {
          areaId: area.id, areaNome: area.nome, por: auth.por,
          horario: new Date().toISOString(),
          resultado: `OK (${novos.length} novo(s))`,
          tipos: [...new Set(novos.map((n) => n.tipo))],
        });
        const envio = await disparar(novos, area).catch((e) => [{ ok: false, canal: 'dispatch', erro: e.message }]);
        envios.push(...envio);
        for (const n of novos) {
          n.envios = envio.filter((x) => x.alertaId === n.id);
        }
        await motor.gravarEventos(await motor.lerEventos().then((l) => l.map((e) => {
          const n = novos.find((x) => x.id === e.id);
          return n || e;
        })));
      }
    }
    await motor.gravarSnapshots(ctx.snaps);
    return jsonResponse(200, {
      areas: areas.length, criados, erros,
      canais: {
        push: envios.filter((e) => e.canal === 'push' && e.ok).length,
        telegram: envios.filter((e) => e.canal === 'telegram' && e.ok).length,
        falhas: envios.filter((e) => !e.ok).length,
      },
      avaliadoEm: new Date().toISOString(),
    }, origin);
  }

  return jsonResponse(404, { erro: 'Ação desconhecida (use /eventos, /avaliar ou /reconhecer).' }, origin);
});
