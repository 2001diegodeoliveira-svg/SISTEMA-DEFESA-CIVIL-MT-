/* ============================================================
   Janela de demonstração — libera a API sem token por N horas
   a partir do primeiro acesso, mesmo com AUTH_LOGIN_ENABLED=true.

   DEMO_HORAS:
     ausente  -> 24 (janela padrão de demonstração)
     0        -> desabilitada (login exigido desde o início)
     maior >0 -> duração da janela em horas

   O marco do primeiro acesso fica na coleção system_config (store em
   qualquer driver) e é cacheado em memória por TTL_CACHE_MS para não
   consultar o banco a cada requisição.
   ============================================================ */
const { readCollection, writeCollection } = require('./store');

const CHAVE = 'demo';
const HORAS_PADRAO = 24;
const TTL_CACHE_MS = 30 * 1000;

let cache = { inicio: null, atualizadoEm: 0, indisponivel: false };

function duracaoMs(env = process.env) {
  const bruto = String(env.DEMO_HORAS === undefined || env.DEMO_HORAS === null ? '' : env.DEMO_HORAS).trim();
  if (bruto === '') return HORAS_PADRAO * 3600000;
  const horas = Number(bruto);
  return Number.isFinite(horas) && horas > 0 ? horas * 3600000 : 0;
}

function demoHabilitado(env = process.env) {
  return duracaoMs(env) > 0;
}

function janelaAberta(inicio) {
  if (!inicio) return false;
  return Date.now() - Number(inicio) < duracaoMs();
}

/* Estado síncrono — usado por verifyToken e pelas rotas depois de demoAtualizar(). */
function demoAberto() {
  if (!demoHabilitado()) return false;
  if (cache.inicio === null) return false;
  return janelaAberta(cache.inicio);
}

/* Lê (ou cria) o marco do primeiro acesso. Assíncrono; chamado por api/index.js. */
async function demoAtualizar() {
  if (!demoHabilitado()) {
    cache = { inicio: null, atualizadoEm: 0, indisponivel: false };
    return false;
  }

  const agora = Date.now();
  if (cache.atualizadoEm && agora - cache.atualizadoEm < TTL_CACHE_MS) return demoAberto();

  try {
    const config = await readCollection('system_config');
    const registro = Array.isArray(config) ? config.find((item) => item && item.id === CHAVE) : null;
    let inicio = registro && Number(registro.inicio) > 0 ? Number(registro.inicio) : null;
    if (!inicio) {
      inicio = agora;
      const demais = Array.isArray(config) ? config.filter((item) => item && item.id !== CHAVE) : [];
      await writeCollection('system_config', [
        { id: CHAVE, inicio, duracaoHoras: duracaoMs() / 3600000 },
        ...demais,
      ]);
    }
    cache = { inicio, atualizadoEm: agora, indisponivel: false };
  } catch (error) {
    /* Sem persistência a janela segue aberto a partir da primeira falha:
       melhor manter o acesso de demonstração do que derrubar a API. */
    console.error('[demo] persistência indisponível:', error && error.message);
    cache = { inicio: cache.inicio || agora, atualizadoEm: agora, indisponivel: true };
  }
  return demoAberto();
}

function demoEstado() {
  const duracao = duracaoMs();
  const inicio = cache.inicio;
  const expiraEm = inicio ? Number(inicio) + duracao : null;
  const restanteMs = expiraEm ? Math.max(0, expiraEm - Date.now()) : 0;
  return {
    habilitado: duracao > 0,
    inicio,
    duracaoHoras: duracao / 3600000,
    expiraEm,
    restanteMs,
    aberto: demoAberto(),
    indisponivel: cache.indisponivel,
  };
}

/* Zera o cache em memória — usado pelos testes. */
function demoReset() {
  cache = { inicio: null, atualizadoEm: 0, indisponivel: false };
}

module.exports = { demoAtualizar, demoAberto, demoEstado, demoReset, demoHabilitado, duracaoMs };
