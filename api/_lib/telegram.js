/* ============================================================
   Telegram outbound (Bot API via fetch puro, sem dependência).
   Requer TELEGRAM_BOT_TOKEN no servidor. Sem token, as funções
   retornam {ok:false} e o motor audita em vez de falhar.
   Assinaturas interativas completas (/assinar por área) vivem
   na UI web; o webhook cobre /start e /status (ver _routes).
   ============================================================ */
const TIMEOUT_MS = 10000;

function botToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function chamada(metodo, params) {
  const token = botToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${metodo}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) {
      throw new Error(`Telegram: ${(j && j.description) || ('HTTP ' + res.status)}.`);
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/** Envia texto a um chat. Nunca lança (retorna {ok}). */
async function enviarMensagem(chatId, texto) {
  try {
    await chamada('sendMessage', { chat_id: chatId, text: String(texto || '').slice(0, 4000) });
    return { ok: true, canal: 'telegram', destino: String(chatId) };
  } catch (e) {
    return { ok: false, canal: 'telegram', destino: String(chatId), erro: e.message };
  }
}

module.exports = { botToken, enviarMensagem, chamada };
