/* ============================================================
   Web Push (VAPID). Requer no servidor:
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
   (mailto: ou https://). Sem elas, o envio retorna {ok:false}
   e o motor registra em auditoria em vez de falhar.
   Inscrições em system_config doc "push-subscriptions".
   ============================================================ */
const webpush = require('web-push');
const { readCollection, writeCollection } = require('./store');

function vapidConfig() {
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || 'mailto:defesacivil@example.com').trim();
  if (!pub || !priv) return null;
  return { pub, priv, subject };
}

function inscricaoValida(s) {
  return s && typeof s === 'object'
    && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://')
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
}

async function lerInscricoes() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'push-subscriptions');
    const lista = Array.isArray(doc && doc.lista) ? doc.lista : [];
    return lista.filter(inscricaoValida);
  } catch {
    return [];
  }
}

async function salvarInscricao(sub) {
  if (!inscricaoValida(sub)) throw new Error('Inscrição push inválida.');
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'push-subscriptions');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'push-subscriptions');
  const lista = Array.isArray(doc && doc.lista) ? doc.lista.filter(inscricaoValida) : [];
  if (!lista.some((s) => s.endpoint === sub.endpoint)) {
    lista.push({ endpoint: sub.endpoint, keys: sub.keys, criadoEm: new Date().toISOString() });
  }
  resto.push({ id: 'push-subscriptions', lista: lista.slice(-5000), updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return lista.length;
}

async function removerInscricao(endpoint) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'push-subscriptions');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'push-subscriptions');
  const lista = Array.isArray(doc && doc.lista) ? doc.lista.filter((s) => s.endpoint !== endpoint) : [];
  resto.push({ id: 'push-subscriptions', lista, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return lista.length;
}

/** Envia payload a uma lista de inscrições. Nunca lança. */
async function enviarPush(inscricoes, payload) {
  const cfg = vapidConfig();
  if (!cfg) {
    return (inscricoes || []).map(() => ({ ok: false, canal: 'push', erro: 'VAPID não configurado.' }));
  }
  try {
    webpush.setVapidDetails(cfg.subject, cfg.pub, cfg.priv);
  } catch (e) {
    return (inscricoes || []).map(() => ({ ok: false, canal: 'push', erro: 'VAPID inválido: ' + e.message }));
  }
  const corpo = JSON.stringify(payload || {});
  const resultados = [];
  for (const sub of inscricoes || []) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, corpo);
      resultados.push({ ok: true, canal: 'push', destino: sub.endpoint.slice(0, 60) });
    } catch (e) {
      const gone = e && (e.statusCode === 404 || e.statusCode === 410);
      if (gone) {
        try { await removerInscricao(sub.endpoint); } catch {}
      }
      resultados.push({ ok: false, canal: 'push', erro: (e && e.message) || 'falha', expirada: !!gone });
    }
  }
  return resultados;
}

module.exports = { vapidConfig, inscricaoValida, lerInscricoes, salvarInscricao, removerInscricao, enviarPush };
