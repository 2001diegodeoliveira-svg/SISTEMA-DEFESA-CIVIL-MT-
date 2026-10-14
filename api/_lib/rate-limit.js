/* ============================================================
   Limite de tentativas de login (anti brute force).

   Janela deslizante simples em memória: após MAX_TENTATIVAS falhas
   para o mesmo IP+usuário dentro da janela, o login é recusado com
   429 antes de qualquer comparação de senha.

   Em ambiente serverless o estado é por instância — ainda reduz
   ataques rápidos, sem exigir infraestrutura externa.
   ============================================================ */

const MAX_TENTATIVAS = Number(process.env.LOGIN_MAX_TENTATIVAS || 8);
const JANELA_MS = Number(process.env.LOGIN_JANELA_MIN || 10) * 60 * 1000;
const MAX_CHAVES = 5000;

const tentativas = new Map(); // chave -> { falhas, primeiroEm }

function trustedProxies(env = process.env) {
  return String(env.TRUSTED_PROXIES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/* IP direto da conexão (socket) — não forjável pelo cliente. Na Vercel o
   runtime Node expõe socket.remoteAddress; no wrapper Express incluímos
   req.ip; nos testes (objeto puro) cai para 'local'. */
function ipDireto(req) {
  if (!req) return '';
  const candidates = [
    req.ip,
    req.socket && req.socket.remoteAddress,
    req.connection && req.connection.remoteAddress,
  ];
  for (const candidate of candidates) {
    const ip = String(candidate || '').trim();
    if (ip) return ip;
  }
  return '';
}

function proxyConfiavel(req, env = process.env) {
  const trusted = trustedProxies(env);
  if (!trusted.length) return false;
  if (trusted.includes('*')) return true;
  const direto = ipDireto(req);
  return direto && trusted.includes(direto);
}

function ipDaRequisicao(req, env = process.env) {
  const direto = ipDireto(req);
  /* CRIPTO-05: só confia em x-forwarded-for quando o IP de origem é um
     proxy conhecido (TRUSTED_PROXIES). Header forjado de cliente
     não-respeitado não reseta o bucket. Em serverless o Map é por
     instância (mitigação parcial) — recomendar throttle no edge
     (Vercel WAF/Upstash) para produção. */
  if (proxyConfiavel(req, env)) {
    const h = req && req.headers;
    const bruto = (h.get && h.get('x-forwarded-for')) || h['x-forwarded-for']
      || (h.get && h.get('x-real-ip')) || h['x-real-ip'] || '';
    const ip = String(bruto).split(',')[0].trim();
    if (ip) return ip;
  }
  return direto || 'local';
}

function chaveDe(req, usuario) {
  return ipDaRequisicao(req) + '|' + String(usuario || '').trim().toLowerCase();
}

function limparAgora() {
  const agora = Date.now();
  for (const [chave, registro] of tentativas) {
    if (agora - registro.primeiroEm > JANELA_MS) tentativas.delete(chave);
  }
}

/* Retorna quanto tempo (ms) ainda falta para poder tentar de novo, ou 0. */
function bloqueioRestante(chave) {
  const registro = tentativas.get(chave);
  if (!registro) return 0;
  const decorrido = Date.now() - registro.primeiroEm;
  if (decorrido > JANELA_MS) { tentativas.delete(chave); return 0; }
  if (registro.falhas < MAX_TENTATIVAS) return 0;
  return JANELA_MS - decorrido;
}

function loginBloqueado(req, usuario) {
  limparAgora();
  return bloqueioRestante(chaveDe(req, usuario));
}

function registrarFalha(req, usuario) {
  limparAgora();
  const chave = chaveDe(req, usuario);
  const registro = tentativas.get(chave);
  if (!registro || Date.now() - registro.primeiroEm > JANELA_MS) {
    if (tentativas.size >= MAX_CHAVES) tentativas.clear();
    tentativas.set(chave, { falhas: 1, primeiroEm: Date.now() });
    return;
  }
  registro.falhas += 1;
}

function limparSucesso(req, usuario) {
  tentativas.delete(chaveDe(req, usuario));
}

function segundosDeEspera(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

module.exports = {
  loginBloqueado,
  registrarFalha,
  limparSucesso,
  segundosDeEspera,
  ipDaRequisicao,
  trustedProxies,
};
