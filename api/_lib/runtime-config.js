const DEFAULT_JWT_SECRET = 'dc-mt-dev-secret-change-me';
const VALID_PROFILES = new Set(['admin', 'avancado', 'municipal', 'comum']);

function isLoginEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.AUTH_LOGIN_ENABLED || '').trim().toLowerCase());
}

function isSeedOnlyLoginEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.AUTH_SEED_ONLY || '').trim().toLowerCase());
}

/* Suspensão explícita de manutenção (fail-closed): com AUTH_SUSPENDED
   ativo, ninguém autentica e nenhuma operação protegida executa —
   diferente de AUTH_LOGIN_ENABLED=false, que significa acesso liberado.
   NUNCA reaproveitar "login desligado = liberado" como suspensão. */
function isSuspended(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.AUTH_SUSPENDED || '').trim().toLowerCase());
}

/* MAINTENANCE_UNTIL: ISO-8601 do fim previsto da suspensão (ms epoch ou null). */
function maintenanceUntilMs(env = process.env) {
  const t = Date.parse(String(env.MAINTENANCE_UNTIL || ''));
  return Number.isFinite(t) ? t : null;
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

/* JWT_EXP allowlist: número + unidade (s/m/h/d), teto de 24h, default 12h.
   Evita token vitalício via valor como "never" ou gigante. */
const JWT_EXP_DEFAULT = '12h';
const JWT_EXP_MAX_SECONDS = 24 * 3600;

function parseJwtExpToSeconds(value) {
  const raw = String(value === undefined || value === null ? JWT_EXP_DEFAULT : value).trim();
  const m = raw.match(/^(\d+)([smhd])$/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * multipliers[m[2]];
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > JWT_EXP_MAX_SECONDS) return null;
  return seconds;
}

function resolveJwtExp(value) {
  const raw = String(value === undefined || value === null || value === '' ? JWT_EXP_DEFAULT : value).trim();
  return parseJwtExpToSeconds(raw) === null ? JWT_EXP_DEFAULT : raw;
}

function isJwtExpValid(value) {
  return parseJwtExpToSeconds(value) !== null;
}

function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production' && env.VERCEL_ENV !== 'production') return [];

  const onVercel = Boolean(env.VERCEL);
  const problems = [];
  const secret = env.JWT_SECRET || '';
  if (isLoginEnabled(env) && (Buffer.byteLength(secret, 'utf8') < 32 || secret === DEFAULT_JWT_SECRET)) {
    problems.push('JWT_SECRET forte é obrigatório.');
  }
  if (isLoginEnabled(env) && !/^[a-f0-9]{64}$/i.test(env.MFA_ENCRYPTION_KEY || '')) {
    problems.push('MFA_ENCRYPTION_KEY deve conter 64 caracteres hexadecimais (32 bytes).');
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
  let seedParseError = false;
  try {
    seedUsers = JSON.parse(env.SEED_USERS || 'null');
  } catch { seedParseError = true; }
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

  /* Suspensão em produção deve ser explícita e temporária: exige
     MAINTENANCE_UNTIL ISO futura; ausente/inválida/vencida recusa o boot
     para que a renovação seja consciente (o roteador valida por request,
     então o vencimento passa a bloquear sozinho). */
  if (isSuspended(env)) {
    const ate = maintenanceUntilMs(env);
    if (ate === null) {
      problems.push('MAINTENANCE_UNTIL deve conter uma data ISO válida enquanto AUTH_SUSPENDED estiver ativo.');
    } else if (ate <= Date.now()) {
      problems.push('MAINTENANCE_UNTIL vencido: renove a data ou desligue AUTH_SUSPENDED para religar.');
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

  /* CRIPTO-03: JWT_EXP com allowlist e teto de 24h. Valor como "never" ou
     gigante geraria token vitalício — recusa o boot em produção. */
  if (!isJwtExpValid(env.JWT_EXP === undefined || env.JWT_EXP === '' ? JWT_EXP_DEFAULT : env.JWT_EXP)) {
    problems.push('JWT_EXP inválido: use número+unidade (ex.: 15m, 12h) com teto de 24h.');
  }

  /* CRIPTO-01: login desligado + seed de produção coexistindo é configuração
     perigosa (verifyToken() libera admin para qualquer request). Em produção,
     esse par deve falhar fechado no CI/deploy. Mantemos o modo manutenção
     (AUTH off sem seed) para não quebrar o fluxo intencional de manutenção. */
  if (!isLoginEnabled(env) && Array.isArray(seedUsers) && seedUsers.length) {
    problems.push('AUTH_LOGIN_ENABLED=false não pode coexistir com SEED_USERS em produção.');
  }
  if (seedParseError && env.SEED_USERS) {
    problems.push('SEED_USERS contém JSON inválido.');
  }

  return problems;
}

module.exports = { isLoginEnabled, isSeedOnlyLoginEnabled, isSuspended, maintenanceUntilMs, validateProductionConfig, parseJwtExpToSeconds, resolveJwtExp, isJwtExpValid, JWT_EXP_DEFAULT, JWT_EXP_MAX_SECONDS };