/* ============================================================
   Telegram webhook (Fase 5, mínimo viável).
   POST /api/telegram/webhook <- Bot API (configure o webhook do
   bot para esta URL + TELEGRAM_WEBHOOK_SECRET como secret_token).
   Comandos:
     /start    — registra o chat e responde com instruções
     /status   — áreas monitoradas + eventos de hoje
     /assinar, /cancelar — direcionam para a UI web (fluxo
       interativo por conversa fica para fase futura)
   Chats registrados em system_config doc "telegram-chats".
   ============================================================ */
const { jsonResponse, readJson } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { readCollection, writeCollection } = require('../_lib/store');
const telegram = require('../_lib/telegram');
const { lerAreas } = require('./areas-monitoradas');
const motor = require('../_lib/motor');

const AJUDA = [
  'SGI PROTEGE — alertas no Telegram.',
  'Comandos: /start, /status.',
  'Para assinar uma área (município ou desenho no mapa) ou cancelar, use o Mapa Integrado: seção Áreas monitoradas.',
  'Alertas de nível alto exigem confirmação humana antes do envio externo.',
].join('\n');

async function lerChats() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'telegram-chats');
    return Array.isArray(doc && doc.lista) ? doc.lista : [];
  } catch {
    return [];
  }
}

async function registrarChat(chat) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'telegram-chats');
  const lista = await lerChats();
  if (!lista.some((c) => String(c.id) === String(chat.id))) {
    lista.push({ ...chat, registradoEm: new Date().toISOString() });
  }
  resto.push({ id: 'telegram-chats', lista: lista.slice(-5000), updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return lista;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'POST') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const segredo = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const recebido = req.headers.get
    ? req.headers.get('x-telegram-bot-api-secret-token')
    : (req.headers['x-telegram-bot-api-secret-token'] || '');
  if (segredo && recebido !== segredo) {
    return jsonResponse(403, { erro: 'Assinatura inválida.' }, origin);
  }

  const body = await readJson(req);
  const msg = (body && body.message) || {};
  const chat = msg.chat || {};
  const texto = String(msg.text || '').trim().split(/\s+/)[0].toLowerCase();
  if (!chat.id || !texto.startsWith('/')) return jsonResponse(200, { ok: true }, origin);

  if (texto === '/start') {
    await registrarChat({ id: chat.id, tipo: chat.type || null, nome: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null });
    await telegram.enviarMensagem(chat.id, AJUDA);
    await motor.auditar('telegram_start', { chatId: String(chat.id), horario: new Date().toISOString(), resultado: 'OK' });
    return jsonResponse(200, { ok: true }, origin);
  }
  if (texto === '/status') {
    const areas = await lerAreas();
    const eventos = await motor.lerEventos();
    const hoje = new Date().toISOString().slice(0, 10);
    const deHoje = eventos.filter((e) => (e.criadoEm || '').slice(0, 10) === hoje);
    const abertos = eventos.filter((e) => e.estado === 'aberto').length;
    await telegram.enviarMensagem(chat.id,
      `SGI PROTEGE — status\nÁreas monitoradas: ${areas.length}\nEventos hoje: ${deHoje.length} (abertos: ${abertos})`);
    return jsonResponse(200, { ok: true }, origin);
  }
  if (texto === '/assinar' || texto === '/cancelar') {
    await telegram.enviarMensagem(chat.id,
      'Assinaturas são gerenciadas no Mapa Integrado (seção Áreas monitoradas). Abra o mapa e desenhe ou escolha a área.');
    return jsonResponse(200, { ok: true }, origin);
  }
  await telegram.enviarMensagem(chat.id, AJUDA);
  return jsonResponse(200, { ok: true }, origin);
});

module.exports.lerChats = lerChats;
