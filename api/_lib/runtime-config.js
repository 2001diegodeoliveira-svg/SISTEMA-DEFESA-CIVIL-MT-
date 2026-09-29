const DEFAULT_JWT_SECRET = 'dc-mt-dev-secret-change-me';
const VALID_PROFILES = new Set(['admin', 'avancado', 'municipal', 'comum']);

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production') return [];

  const problems = [];
  const secret = env.JWT_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32 || secret === DEFAULT_JWT_SECRET) {
    problems.push('JWT_SECRET forte é obrigatório.');
  }

  const origins = parseList(env.CORS_ORIGIN);
  if (!origins.length || origins.includes('*')) {
    problems.push('CORS_ORIGIN deve listar origens HTTPS explícitas.');
  } else if (origins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol !== 'https:' || parsed.origin !== origin;
    } catch {
      return true;
    }
  })) {
    problems.push('Cada origem em CORS_ORIGIN deve ser uma URL HTTPS sem caminho.');
  }

  const proxyHosts = parseList(env.PROXY_HOSTS);
  if (!proxyHosts.length || proxyHosts.includes('*') || proxyHosts.some((host) => !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(host))) {
    problems.push('PROXY_HOSTS deve listar domínios explícitos permitidos pelo proxy.');
  }

  let seedUsers = null;
  try {
    seedUsers = JSON.parse(env.SEED_USERS || 'null');
  } catch {}
  if (!Array.isArray(seedUsers) || !seedUsers.length || !seedUsers.every((user) =>
    user && typeof user.usuario === 'string' && user.usuario.trim() &&
    typeof user.senha === 'string' && Buffer.byteLength(user.senha, 'utf8') >= 12 &&
    VALID_PROFILES.has(user.perfil)
  )) {
    problems.push('SEED_USERS deve conter usuários com senhas fortes e perfis válidos; contas demo não são permitidas.');
  } else if (!seedUsers.some((user) => user.perfil === 'admin')) {
    problems.push('SEED_USERS deve incluir pelo menos um administrador.');
  }

  const hasDatabase = Boolean(env.DATABASE_URL && env.FILE_STORE !== '1');
  const hasKvUrl = Boolean(env.KV_REST_API_URL);
  const hasKvToken = Boolean(env.KV_REST_API_TOKEN);
  const hasKv = hasKvUrl && hasKvToken;
  if (hasKvUrl !== hasKvToken) problems.push('KV_REST_API_URL e KV_REST_API_TOKEN devem ser configurados juntos.');
  if (env.VERCEL && !hasDatabase && !hasKv) {
    problems.push('Vercel em produção exige DATABASE_URL ou KV completo; armazenamento local/memória é efêmero.');
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

module.exports = { validateProductionConfig };