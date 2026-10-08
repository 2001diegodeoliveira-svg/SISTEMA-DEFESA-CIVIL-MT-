const DEFAULT_JWT_SECRET = 'dc-mt-dev-secret-change-me';
const VALID_PROFILES = new Set(['admin', 'avancado', 'municipal', 'comum']);

function isLoginEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.AUTH_LOGIN_ENABLED || '').trim().toLowerCase());
}

function isSeedOnlyLoginEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.AUTH_SEED_ONLY || '').trim().toLowerCase());
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production') return [];

  const onVercel = Boolean(env.VERCEL);
  const problems = [];
  const secret = env.JWT_SECRET || '';
  if (isLoginEnabled(env) && (Buffer.byteLength(secret, 'utf8') < 32 || secret === DEFAULT_JWT_SECRET)) {
    problems.push('JWT_SECRET forte é obrigatório.');
  }

  const origins = parseList(env.CORS_ORIGIN);
  if (!origins.length || origins.includes('*')) {
    problems.push('CORS_ORIGIN deve listar origens explícitas.');
  } else if (origins.some((origin) => {
    try {
      const parsed = new URL(origin);
      /* Na Vercel o serviço está exposto à internet: exigimos HTTPS.
         Em servidor próprio atrás de proxy/túnel, HTTP em rede local
         também é aceito (o túnel termina TLS antes de chegar aqui). */
      if (parsed.protocol !== 'https:' && onVercel) return true;
      return parsed.origin !== origin;
    } catch {
      return true;
    }
  })) {
    problems.push(onVercel
      ? 'Cada origem em CORS_ORIGIN deve ser uma URL HTTPS sem caminho.'
      : 'Cada origem em CORS_ORIGIN deve ser uma URL sem caminho (ex.: http://localhost:3000).');
  }

  const proxyHosts = parseList(env.PROXY_HOSTS);
  if (!proxyHosts.length || proxyHosts.includes('*') || proxyHosts.some((host) => !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(host))) {
    problems.push('PROXY_HOSTS deve listar domínios explícitos permitidos pelo proxy.');
  }

  let seedUsers = null;
  try {
    seedUsers = JSON.parse(env.SEED_USERS || 'null');
  } catch {}
  const hasDatabase = Boolean(env.DATABASE_URL && env.FILE_STORE !== '1');
  if (hasDatabase) {
    try {
      new URL(env.DATABASE_URL);
    } catch {
      problems.push('DATABASE_URL não é uma URL PostgreSQL válida.');
    }
  }
  const hasKvUrl = Boolean(env.KV_REST_API_URL);
  const hasKvToken = Boolean(env.KV_REST_API_TOKEN);
  const hasKv = hasKvUrl && hasKvToken;
  if (isLoginEnabled(env) && seedUsers && (!Array.isArray(seedUsers) || !seedUsers.every((user) =>
    user && typeof user.usuario === 'string' && user.usuario.trim() &&
    typeof user.senha === 'string' && Buffer.byteLength(user.senha, 'utf8') >= 10 && Buffer.byteLength(user.senha, 'utf8') <= 72 &&
    VALID_PROFILES.has(user.perfil)
  ))) {
    problems.push('SEED_USERS, quando definido, deve conter usuários com senhas de 10 a 72 bytes UTF-8 e perfis válidos.');
  } else if (isLoginEnabled(env) && Array.isArray(seedUsers) && seedUsers.length && !seedUsers.some((user) => user.perfil === 'admin')) {
    problems.push('SEED_USERS deve incluir pelo menos um administrador.');
  }

  if (isLoginEnabled(env) && (!Array.isArray(seedUsers) || !seedUsers.length) && !hasDatabase && !hasKv) {
    problems.push('Configure um admin bootstrap em SEED_USERS ou um banco persistente com administrador ativo.');
  }
  if (hasKvUrl !== hasKvToken) problems.push('KV_REST_API_URL e KV_REST_API_TOKEN devem ser configurados juntos.');
  if (onVercel) {
    if (!hasDatabase && !hasKv) {
      problems.push('Vercel em produção exige DATABASE_URL ou KV completo; armazenamento local/memória é efêmero.');
    } else if (hasDatabase && /localhost|127\.0\.0\.1/.test(env.DATABASE_URL || '')) {
      // Na Vercel o banco precisa estar acessível pela internet (Neon, etc.).
      problems.push('DATABASE_URL aponta para localhost; Vercel precisa de um PostgreSQL remoto acessível pela internet.');
    }
  }

  if (['1', 'true', 'yes', 'on'].includes(String(env.WAZE_MOCK_ENABLED || '').toLowerCase())) {
    problems.push('WAZE_MOCK_ENABLED deve estar desativado em produção.');
  }
  if (['1', 'true', 'yes', 'on'].includes(String(env.TOMTOM_MOCK_ENABLED || '').toLowerCase())) {
    problems.push('TOMTOM_MOCK_ENABLED deve estar desativado em produção.');
  }
  if (['1', 'true', 'yes', 'on'].includes(String(env.WAZE_ENABLED || '').toLowerCase()) && !env.WAZE_FEED_URL) {
    problems.push('WAZE_FEED_URL é obrigatória quando WAZE_ENABLED está ativo.');
  }
  if (['1', 'true', 'yes', 'on'].includes(String(env.TOMTOM_ENABLED || '').toLowerCase()) && !env.TOMTOM_API_KEY) {
    problems.push('TOMTOM_API_KEY é obrigatória quando TOMTOM_ENABLED está ativo.');
  }

  return problems;
}

module.exports = { isLoginEnabled, isSeedOnlyLoginEnabled, validateProductionConfig };