/* ============================================================
   Provedor de TOTP (Google Authenticator) com carregamento tardio.

   O otplib v13 é ESM e depende de @scure/base (também ESM). Um
   `require()` dessas dependências quebra em runtimes CommonJS sem
   suporte a require(ESM) — e derrubaria a API inteira, porque o
   roteador central carrega este módulo.

   Aqui o pacote é importado sob demanda com `import()` dinâmico
   (suportado em qualquer runtime com ESM). Se ainda assim falhar,
   a API continua no ar e apenas o 2FA se recusa a emitir código.
   ============================================================ */
let cache = null;
let attempted = false;

async function load() {
  if (cache) return cache;
  if (attempted) return null;
  attempted = true;
  try {
    cache = await import('otplib');
  } catch {
    cache = null;
  }
  return cache;
}

/* Gera um segredo base32 ou null se o TOTP estiver indisponível. */
async function generateSecret() {
  const lib = await load();
  return lib ? lib.generateSecret() : null;
}

/* Monta a otpauth:// URI usada no QR code, ou null se indisponível. */
async function generateURI({ issuer, label, secret }) {
  const lib = await load();
  if (!lib) return null;
  return lib.generateURI({ strategy: 'totp', issuer, label, secret });
}

/* Confere um código de 6 dígitos. Sem biblioteca carregada, recusa
   (fail-closed): nunca aprova um código que não foi validado. */
async function verifyCode(secret, token) {
  if (!secret || !token) return false;
  const code = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const lib = await load();
  if (!lib) return false;
  try {
    const result = lib.verifySync({ secret, token: code });
    return result === true || (result && result.valid === true);
  } catch {
    return false;
  }
}

module.exports = { generateSecret, generateURI, verifyCode };
