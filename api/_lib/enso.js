/* ============================================================
   Módulo ENOS / El Niño — núcleo (Fase 1).

   Classificação de intensidade, regras de alerta declarativas
   (com histerese e deduplicação), auditoria, canais de envio
   (com dry-run) e coletores idempotentes.

   REGRAS PERMANENTES DO MÓDULO:
   - Limiares NUNCA fixos no código: store ("enso-config") >
     env (ENSO_*) > padrão. Nomes e gatilhos dos níveis também
     são configuráveis (store "enso-regras" > ENSO_RULES_JSON).
   - NUNCA envia notificação real em dev/teste: ENSO_DRY_RUN=1
     (padrão) só registra em log/auditoria. Webhook real exige
     ENSO_DRY_RUN=0 E ENSO_WEBHOOK_URL configurada.
   - Níveis altos (ALERTA/EMERGENCIA ou regra com
     exigeConfirmacao) NÃO disparam envio externo sem
     confirmação humana (ver avaliar() + confirmarAlerta()).
   - Falha de UMA fonte nunca derruba o módulo: cada coletor
     roda isolado e atualiza "fonte_status".
   - Sem URLs inventadas: o coletor NOAA usa URLs verificadas ao vivo
     em 2026-10-11 (oni.ascii.txt + sstoi.indices do CPC/NCEP),
     sobrescrevíveis por env; o MOCK segue claramente marcado.
   - Persistência adaptada ao banco existente: usa as coleções
     genéricas do store — "system_config" (docs id-chaveados,
     mapeada p/ tabela system_config no PostgreSQL) e
     "audit_logs" (trilha de auditoria, mapeada no pg).
     Nenhuma migração nova é exigida na Fase 1.
   ============================================================ */
const { readCollection, writeCollection, push } = require('./store');

/* ---------- utilidades de config (mesmo padrão de pluvialerta) ---------- */
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function envFlag(nome, dflt) {
  const v = process.env[nome];
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'sim', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'nao', 'não', 'no'].includes(s)) return false;
  return dflt;
}

/* ---------- logger estruturado (padrão de api/_lib/waze.js) ---------- */
const MAX_HISTORY = 200;
const logHistory = [];
function log(level, event, message, metadata) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    message: message || '',
    metadata: metadata || {},
  };
  logHistory.push(entry);
  if (logHistory.length > MAX_HISTORY) logHistory.shift();
  const line = `[${entry.timestamp}] ${level.toUpperCase()} ${event} — ${entry.message}`;
  if (level === 'error') console.error(line, metadata || '');
  else if (level === 'warn') console.warn(line, metadata || '');
  else console.log(line, metadata || '');
  return entry;
}
const logger = {
  info: (e, m, d) => log('info', e, m, d),
  warn: (e, m, d) => log('warn', e, m, d),
  error: (e, m, d) => log('error', e, m, d),
  history: (limit = MAX_HISTORY) => logHistory.slice(-limit).reverse(),
};

/* ============================================================
   Limiares de classificação (CONFIGURÁVEIS).
   Ordem de resolução: store "enso-config" > env ENSO_* > padrão.
   ============================================================ */
const LIMIARES_PADRAO = {
  neutroBanda: 0.5, // |anomalia| < banda => NEUTRO
  fraco: 0.5, // El Niño fraco >= fraco (idem La Niña <= -fraco)
  moderado: 1.0,
  forte: 1.5,
  muitoForte: 2.0,
};
const LIMIARES_LIMITES = { min: 0.05, max: 5 };

function limiaresDoEnv() {
  return {
    neutroBanda: clampNum(process.env.ENSO_NEUTRO_BANDA, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, LIMIARES_PADRAO.neutroBanda),
    fraco: clampNum(process.env.ENSO_FRACO, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, LIMIARES_PADRAO.fraco),
    moderado: clampNum(process.env.ENSO_MODERADO, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, LIMIARES_PADRAO.moderado),
    forte: clampNum(process.env.ENSO_FORTE, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, LIMIARES_PADRAO.forte),
    muitoForte: clampNum(process.env.ENSO_MUITO_FORTE, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, LIMIARES_PADRAO.muitoForte),
  };
}

/** Normaliza um objeto de limiares: faixas válidas + ordem monotônica.
 *  Valores inconsistentes voltam ao padrão (nunca quebram o módulo). */
function normalizarLimiares(obj) {
  const base = limiaresDoEnv();
  const l = {
    neutroBanda: clampNum(obj && obj.neutroBanda, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, base.neutroBanda),
    fraco: clampNum(obj && obj.fraco, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, base.fraco),
    moderado: clampNum(obj && obj.moderado, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, base.moderado),
    forte: clampNum(obj && obj.forte, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, base.forte),
    muitoForte: clampNum(obj && obj.muitoForte, LIMIARES_LIMITES.min, LIMIARES_LIMITES.max, base.muitoForte),
  };
  // Ordem exigida: banda <= fraco <= moderado <= forte <= muitoForte.
  // Violações são elevadas ao patamar anterior (nunca quebram o módulo).
  const seq = ['neutroBanda', 'fraco', 'moderado', 'forte', 'muitoForte'];
  for (let i = 1; i < seq.length; i += 1) {
    if (!(l[seq[i]] >= l[seq[i - 1]])) l[seq[i]] = l[seq[i - 1]];
  }
  return l;
}

/** Lê os limiares efetivos. Devolve { ..., origem: 'store'|'env' }. */
async function lerLimiares() {
  const base = limiaresDoEnv();
  let col = [];
  try {
    col = await readCollection('system_config');
  } catch {
    col = [];
  }
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-config');
  if (!doc || !doc.limiares) return { ...base, origem: 'env' };
  return { ...normalizarLimiares(doc.limiares), origem: 'store' };
}

/** Salva override de limiares (rota autenticada). */
async function gravarLimiares(patch, updatedBy) {
  const atuais = await lerLimiares();
  const novos = normalizarLimiares({ ...atuais, ...(patch || {}) });
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-config');
  resto.push({ id: 'enso-config', limiares: novos, updatedBy: updatedBy || null, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return { ...novos, origem: 'store' };
}

/** Remove o override salvo (volta a env/padrão). */
async function limparLimiares() {
  const col = await readCollection('system_config');
  await writeCollection('system_config', (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-config'));
  return lerLimiares();
}

/* ============================================================
   Classificador ENOS.
   ============================================================ */
/** Classifica uma anomalia de TSM (°C) em fase + intensidade.
 *  Lança Error se o valor não for numérico finito.
 *  @param {number} valor anomalia em °C (ex.: ONI, Niño 3.4)
 *  @param {object} [limiares] limiares efetivos (ver lerLimiares)
 *  @returns {{fase: 'EL_NINO'|'LA_NINA'|'NEUTRO', intensidade, valor, limiares}} */
function classificar(valor, limiares) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    throw new Error('anomalia inválida: esperado número finito em °C');
  }
  const l = normalizarLimiares(limiares || limiaresDoEnv());
  const abs = Math.abs(valor);
  if (abs < l.neutroBanda) {
    return { fase: 'NEUTRO', intensidade: 'NEUTRO', valor, limiares: l };
  }
  const intensidade = abs >= l.muitoForte ? 'MUITO_FORTE'
    : abs >= l.forte ? 'FORTE'
      : abs >= l.moderado ? 'MODERADO' : 'FRACO';
  return { fase: valor > 0 ? 'EL_NINO' : 'LA_NINA', intensidade, valor, limiares: l };
}

/* ============================================================
   Regras de alerta declarativas (CONFIGURÁVEIS).
   Níveis: OBSERVACAO → ATENCAO → ALERTA → EMERGENCIA.
   Ordem: store "enso-regras" > ENSO_RULES_JSON > padrão.
   ============================================================ */
const NIVEIS = ['OBSERVACAO', 'ATENCAO', 'ALERTA', 'EMERGENCIA'];
const NIVEIS_EXIGEM_CONFIRMACAO = new Set(['ALERTA', 'EMERGENCIA']);

const REGRAS_PADRAO = [
  {
    id: 'enso-observacao', nivel: 'OBSERVACAO',
    descricao: 'Anomalia fora da banda neutra: acompanhar evolução.',
    condicao: { indice: 'ONI', operador: '>=', limiarAbs: 0.5 },
    exigeConfirmacao: false, canais: ['webhook'],
  },
  {
    id: 'enso-atencao', nivel: 'ATENCAO',
    descricao: 'Anomalia moderada: atenção das equipes.',
    condicao: { indice: 'ONI', operador: '>=', limiarAbs: 1.0 },
    exigeConfirmacao: false, canais: ['email', 'webhook'],
  },
  {
    id: 'enso-alerta', nivel: 'ALERTA',
    descricao: 'Anomalia forte: preparar resposta. Exige confirmação humana.',
    condicao: { indice: 'ONI', operador: '>=', limiarAbs: 1.5 },
    exigeConfirmacao: true, canais: ['email', 'webhook'],
  },
  {
    id: 'enso-emergencia', nivel: 'EMERGENCIA',
    descricao: 'Anomalia muito forte: resposta imediata. Exige confirmação humana.',
    condicao: { indice: 'ONI', operador: '>=', limiarAbs: 2.0 },
    exigeConfirmacao: true, canais: ['email', 'webhook'],
  },
];

function regraValida(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (!NIVEIS.includes(r.nivel)) return false;
  const c = r.condicao;
  if (!c || typeof c !== 'object') return false;
  if (typeof c.indice !== 'string' || !c.indice) return false;
  if (!['>=', '<='].includes(c.operador)) return false;
  if (typeof c.limiarAbs !== 'number' || !Number.isFinite(c.limiarAbs) || c.limiarAbs < 0) return false;
  if (!Array.isArray(r.canais) || !r.canais.length) return false;
  return true;
}

function regrasDoEnv() {
  const raw = process.env.ENSO_RULES_JSON;
  if (!raw) return { regras: REGRAS_PADRAO.map((r) => ({ ...r })), origem: 'padrao' };
  try {
    const parsed = JSON.parse(raw);
    const lista = Array.isArray(parsed) ? parsed : parsed.regras;
    if (!Array.isArray(lista)) throw new Error('ENSO_RULES_JSON sem lista de regras');
    const validas = lista.filter(regraValida);
    if (!validas.length) throw new Error('ENSO_RULES_JSON sem regras válidas');
    return { regras: validas, origem: 'env' };
  } catch (e) {
    logger.warn('enso.regras-env-invalidas', 'ENSO_RULES_JSON inválido; usando padrão.', { erro: e.message });
    return { regras: REGRAS_PADRAO.map((r) => ({ ...r })), origem: 'padrao' };
  }
}

/** Lê as regras efetivas. Devolve { regras, origem: 'store'|'env'|'padrao' }. */
async function lerRegras() {
  const base = regrasDoEnv();
  let col = [];
  try {
    col = await readCollection('system_config');
  } catch {
    col = [];
  }
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-regras');
  if (!doc || !Array.isArray(doc.regras)) return base;
  const validas = doc.regras.filter(regraValida);
  if (!validas.length) return base;
  return { regras: validas, origem: 'store' };
}

/** Salva override de regras (rota autenticada). */
async function gravarRegras(regras, updatedBy) {
  if (!Array.isArray(regras) || !regras.length) throw new Error('Informe ao menos uma regra válida.');
  const validas = regras.filter(regraValida);
  if (!validas.length) throw new Error('Nenhuma regra válida informada.');
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-regras');
  resto.push({ id: 'enso-regras', regras: validas, updatedBy: updatedBy || null, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return { regras: validas, origem: 'store' };
}

/** Remove o override de regras. */
async function limparRegras() {
  const col = await readCollection('system_config');
  await writeCollection('system_config', (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-regras'));
  return lerRegras();
}

function histerese() {
  return clampNum(process.env.ENSO_HISTERESE, 0, 1, 0.1);
}
function reavisoMs() {
  return clampNum(process.env.ENSO_REAVISO_HORAS, 0.25, 720, 24) * 3600000;
}

/** Lê o estado anterior das regras (para histerese/dedup). */
async function lerEstadoRegras() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-estado');
    return (doc && doc.estado && typeof doc.estado === 'object') ? doc.estado : {};
  } catch {
    return {};
  }
}

async function gravarEstadoRegras(estado) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-estado');
  resto.push({ id: 'enso-estado', estado, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
}

/** Testa a condição de uma regra contra |valor|. */
function condicaoDispara(regra, valorAbs) {
  const { operador, limiarAbs } = regra.condicao;
  return operador === '<=' ? valorAbs <= limiarAbs : valorAbs >= limiarAbs;
}

/** Avalia as regras contra uma medição, aplicando histerese e
 *  deduplicação. Função pura (não persiste): recebe o estado anterior
 *  e devolve { transicoes, novoEstado }.
 *  @param {{indice, valor}} medicao
 *  @param {{regras, estadoAnterior, agoraMs?, hist?, reavisoIntervaloMs?}} ctx */
function avaliarRegras(medicao, ctx) {
  if (!medicao || typeof medicao.valor !== 'number' || !Number.isFinite(medicao.valor)) {
    throw new Error('medição inválida: valor numérico finito esperado');
  }
  const regras = (ctx && ctx.regras) || [];
  const anterior = (ctx && ctx.estadoAnterior) || {};
  const agora = (ctx && ctx.agoraMs) || Date.now();
  const hist = (ctx && ctx.hist !== undefined) ? ctx.hist : histerese();
  const reaviso = (ctx && ctx.reavisoIntervaloMs !== undefined) ? ctx.reavisoIntervaloMs : reavisoMs();
  const valorAbs = Math.abs(medicao.valor);
  const transicoes = [];
  const novoEstado = { ...anterior };

  for (const regra of regras) {
    if (!regraValida(regra)) continue;
    const prev = anterior[regra.id];
    const dispara = condicaoDispara(regra, valorAbs);
    const margemSaida = Math.max(0, regra.condicao.limiarAbs - hist);

    if (dispara) {
      if (!prev || !prev.ativo) {
        novoEstado[regra.id] = { ativo: true, nivel: regra.nivel, valorDisparo: medicao.valor, disparoEm: new Date(agora).toISOString(), ultimoEnvio: null };
        transicoes.push({ regraId: regra.id, nivel: regra.nivel, tipo: 'DISPARADO', valor: medicao.valor, exigeConfirmacao: regra.exigeConfirmacao === true });
      } else if (!prev.ultimoEnvio || (agora - Date.parse(prev.ultimoEnvio)) >= reaviso) {
        transicoes.push({ regraId: regra.id, nivel: regra.nivel, tipo: 'REAVISADO', valor: medicao.valor, exigeConfirmacao: regra.exigeConfirmacao === true });
      } else {
        transicoes.push({ regraId: regra.id, nivel: regra.nivel, tipo: 'MANTIDO', valor: medicao.valor, exigeConfirmacao: regra.exigeConfirmacao === true });
      }
    } else if (prev && prev.ativo && valorAbs < margemSaida) {
      novoEstado[regra.id] = { ...prev, ativo: false, encerradoEm: new Date(agora).toISOString() };
      transicoes.push({ regraId: regra.id, nivel: regra.nivel, tipo: 'ENCERRADO', valor: medicao.valor, exigeConfirmacao: false });
    }
    // Entre limiar-histerese e limiar: mantém o estado anterior (histerese),
    // sem transição — evita liga/desliga por ruído na borda.
  }
  return { transicoes, novoEstado };
}

function marcarEnvio(novoEstado, regraId, quandoIso) {
  if (novoEstado && novoEstado[regraId]) novoEstado[regraId] = { ...novoEstado[regraId], ultimoEnvio: quandoIso };
  return novoEstado;
}

/* ============================================================
   Alertas (alerta_regra → alerta → alerta_envio).
   Pendentes ficam no doc "enso-alertas" (system_config).
   ============================================================ */
const MAX_ALERTAS = 200;

async function lerAlertas() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-alertas');
    return Array.isArray(doc && doc.lista) ? doc.lista : [];
  } catch {
    return [];
  }
}

async function gravarAlertas(lista) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-alertas');
  // Teto: descarta os mais antigos já resolvidos primeiro.
  let l = Array.isArray(lista) ? lista.slice() : [];
  if (l.length > MAX_ALERTAS) {
    const pend = l.filter((a) => a.estado === 'PENDENTE');
    const resolv = l.filter((a) => a.estado !== 'PENDENTE').slice(l.length - MAX_ALERTAS + pend.length);
    l = [...pend, ...resolv].slice(-MAX_ALERTAS);
  }
  resto.push({ id: 'enso-alertas', lista: l, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return l;
}

function novoAlerta(transicao, medicao, { por }) {
  return {
    id: `enso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    regraId: transicao.regraId,
    nivel: transicao.nivel,
    valor: medicao.valor,
    indice: medicao.indice,
    fonte: medicao.fonte || null,
    estado: 'PENDENTE',
    criadoEm: new Date().toISOString(),
    criadoPor: por || 'avaliacao',
    confirmadoPor: null,
    envios: [],
  };
}

/** Registra alertas para transições DISPARADO/REAVISADO.
 *  Níveis que exigem confirmação ficam PENDENTE (sem envio externo).
 *  Dedup: PENDENTE aberto da mesma regra+nível é reaproveitado. */
async function registrarAlertas(transicoes, medicao, { por, confirmado = false } = {}) {
  const lista = await lerAlertas();
  const criados = [];
  for (const t of transicoes) {
    if (t.tipo !== 'DISPARADO' && t.tipo !== 'REAVISADO') continue;
    const aberto = lista.find((a) => a.estado === 'PENDENTE' && a.regraId === t.regraId && a.nivel === t.nivel);
    if (aberto) {
      criados.push({ ...aberto, reaproveitado: true });
      continue;
    }
    const precisa = t.exigeConfirmacao || NIVEIS_EXIGEM_CONFIRMACAO.has(t.nivel);
    const alerta = novoAlerta(t, medicao, { por });
    if (!precisa || confirmado === true) alerta.estado = 'AGUARDANDO_ENVIO';
    lista.push(alerta);
    criados.push(alerta);
  }
  await gravarAlertas(lista);
  return { lista, criados };
}

/** Confirma (ou dispensa) um alerta PENDENTE. Só humano autenticado. */
async function confirmarAlerta(alertaId, { por, aprovar }) {
  const lista = await lerAlertas();
  const alerta = lista.find((a) => a.id === alertaId);
  if (!alerta) throw new Error('alerta não encontrado');
  if (alerta.estado !== 'PENDENTE') throw new Error(`alerta já está ${alerta.estado}`);
  alerta.confirmadoPor = por || null;
  alerta.confirmadoEm = new Date().toISOString();
  alerta.estado = aprovar === false ? 'DISPENSADO' : 'AGUARDANDO_ENVIO';
  await gravarAlertas(lista);
  return alerta;
}

async function marcarAlertaEnviado(alertaId, envios) {
  const lista = await lerAlertas();
  const alerta = lista.find((a) => a.id === alertaId);
  if (!alerta) return null;
  alerta.envios = [...(alerta.envios || []), ...(envios || [])];
  alerta.estado = 'ENVIADO';
  alerta.enviadoEm = new Date().toISOString();
  await gravarAlertas(lista);
  return alerta;
}

/* ============================================================
   Auditoria (coleção "audit_logs" — mapeada no PostgreSQL).
   Campos: regra, gatilho, destinatários, canal, horário, resultado.
   ============================================================ */
async function auditar(action, metadata) {
  const entry = {
    id: `enso-audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    action: `enso.${action}`,
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
  };
  try {
    await push('audit_logs', { id: entry.id, action: entry.action, metadata: entry.metadata, createdAt: entry.createdAt });
  } catch (e) {
    logger.error('enso.auditoria-falhou', 'Falha ao persistir auditoria.', { erro: e.message });
  }
  logger.info(`enso.auditoria`, `${entry.action}`, entry.metadata);
  return entry;
}

/* ============================================================
   Canais (interface abstrata).
   - email: implementado como outbox (doc "enso-outbox") + dry-run.
     Sem dependência de SMTP na Fase 1; o MTA externo consome a fila.
   - webhook: POST HTTP real (fetch + timeout) quando configurado.
   - telegram/sms/whatsapp: stubs (erros explícitos).
   ============================================================ */
function dryRunAtivo() {
  return envFlag('ENSO_DRY_RUN', true);
}
function webhookUrl() {
  return (process.env.ENSO_WEBHOOK_URL || '').trim();
}
function emailDestinoPadrao() {
  return (process.env.ENSO_EMAIL_DESTINO || '').trim();
}

const CANAIS_IMPLEMENTADOS = ['email', 'webhook'];
const CANAIS_STUB = ['telegram', 'sms', 'whatsapp'];

async function canalEmail({ para, assunto, corpo, alerta }) {
  const destinos = (Array.isArray(para) ? para : [para || emailDestinoPadrao()]).filter(Boolean);
  if (dryRunAtivo()) {
    logger.info('enso.canal-email.dry-run', `E-mail NÃO enviado (dry-run) para ${destinos.join(', ') || '(sem destino)'}.`, { assunto });
    return { ok: true, canal: 'email', dryRun: true, destinos };
  }
  // Sem transporte SMTP na Fase 1 (nenhuma dependência nova):
  // enfileira no outbox para o MTA externo e audita.
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-outbox');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-outbox');
  const fila = Array.isArray(doc && doc.fila) ? doc.fila.slice(-199) : [];
  fila.push({ para: destinos, assunto, corpo, alertaId: (alerta && alerta.id) || null, enfileiradoEm: new Date().toISOString() });
  resto.push({ id: 'enso-outbox', fila, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  logger.info('enso.canal-email.outbox', `E-mail enfileirado p/ MTA externo: ${destinos.join(', ')}.`, { assunto });
  return { ok: true, canal: 'email', dryRun: false, outbox: true, destinos };
}

async function canalWebhook({ evento, dados }) {
  const url = webhookUrl();
  if (dryRunAtivo() || !url) {
    logger.info('enso.canal-webhook.dry-run', `Webhook NÃO disparado (dry-run/sem URL): ${evento}.`, { evento });
    return { ok: true, canal: 'webhook', dryRun: true, evento };
  }
  const timeoutMs = clampNum(process.env.FETCH_TIMEOUT_MS, 1000, 60000, 10000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evento, dados, enviadoEm: new Date().toISOString() }),
      signal: ctrl.signal,
    });
    const ok = res.ok;
    logger.info('enso.canal-webhook.envio', `Webhook ${evento}: HTTP ${res.status}.`, { status: res.status });
    return { ok, canal: 'webhook', dryRun: false, status: res.status };
  } catch (e) {
    logger.error('enso.canal-webhook.erro', `Falha no webhook ${evento}.`, { erro: e.message });
    return { ok: false, canal: 'webhook', dryRun: false, erro: e.message };
  } finally {
    clearTimeout(t);
  }
}

function canalStub(nome) {
  return async () => {
    const erro = `canal ${nome} é stub na Fase 1 (não implementado)`;
    logger.warn('enso.canal-stub', erro, { canal: nome });
    return { ok: false, canal: nome, erro };
  };
}

const canais = {
  email: canalEmail,
  webhook: canalWebhook,
  telegram: canalStub('telegram'),
  sms: canalStub('sms'),
  whatsapp: canalStub('whatsapp'),
};

/** Despacha uma mensagem pelos canais da regra e audita cada envio.
 *  Nunca lança: falha de canal vira resultado {ok:false} auditado. */
async function despachar(alerta, regra, mensagem) {
  const lista = Array.isArray(regra && regra.canais) && regra.canais.length ? regra.canais : ['webhook'];
  const envios = [];
  for (const nome of lista) {
    const fn = canais[nome];
    if (!fn) {
      envios.push({ ok: false, canal: nome, erro: 'canal desconhecido' });
      continue;
    }
    try {
      let r;
      if (nome === 'email') {
        r = await fn({ para: emailDestinoPadrao(), assunto: `[SGI PROTEGE/ENOS] ${alerta.nivel} — ${regra.id}`, corpo: mensagem, alerta });
      } else if (nome === 'webhook') {
        r = await fn({ evento: `enso.${alerta.nivel.toLowerCase()}`, dados: { alertaId: alerta.id, regraId: regra.id, nivel: alerta.nivel, valor: alerta.valor } });
      } else {
        r = await fn();
      }
      envios.push(r);
    } catch (e) {
      envios.push({ ok: false, canal: nome, erro: e.message });
    }
    const ultimo = envios[envios.length - 1];
    await auditar('alerta_envio', {
      regra: regra.id, nivel: alerta.nivel,
      gatilho: { valor: alerta.valor, indice: alerta.indice },
      destinatario: ultimo.destinos || (ultimo.canal === 'webhook' ? (webhookUrl() || null) : null),
      canal: nome, horario: new Date().toISOString(),
      resultado: ultimo.ok ? 'OK' : `FALHA: ${ultimo.erro || ''}`,
      dryRun: ultimo.dryRun === true, alertaId: alerta.id,
    });
  }
  return envios;
}

/* ============================================================
   Coletores idempotentes (falha isolada por fonte).
   ============================================================ */
function coletorMock() {
  return {
    id: 'mock',
    nome: 'MOCK de desenvolvimento (dados fictícios)',
    async coletar() {
      return {
        indice: 'ONI', valor: 0.7, unidade: '°C',
        observadoEm: new Date().toISOString(),
        fonte: 'MOCK (dados fictícios para desenvolvimento)',
        mock: true,
      };
    },
  };
}

/** Coletor NOAA/CPC — URLs verificadas ao vivo em 2026-10-11.
 *  ONI:  https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
 *         (linhas "SEAS YR TOTAL ANOM", ex.: "JAS 2026  29.12   2.16")
 *  Regiões Niño (1+2, 3, 4, 3.4 — total + anomalia, mensal):
 *         https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices
 *  Ambas 100% configuráveis (ENSO_NOAA_ONI_URL / ENSO_NOAA_SST_URL);
 *  ENSO_NOAA_ENABLED=0 desliga o coletor (mantém só o MOCK). */
const URL_ONI_PADRAO = 'https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt';
const URL_SST_PADRAO = 'https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices';

function noaaEnabled() {
  return envFlag('ENSO_NOAA_ENABLED', true);
}
function urlNoaaOni() {
  return (process.env.ENSO_NOAA_ONI_URL || '').trim() || URL_ONI_PADRAO;
}
function urlNoaaSst() {
  return (process.env.ENSO_NOAA_SST_URL || '').trim() || URL_SST_PADRAO;
}

/* Último mês de cada trimestre ONI -> data ISO (dia 1). NDJ termina
 * em janeiro do ano seguinte. */
const FIM_TRIMESTRE = {
  DJF: [2, 0], JFM: [3, 0], FMA: [4, 0], MAM: [5, 0], AMJ: [6, 0], MJJ: [7, 0],
  JJA: [8, 0], JAS: [9, 0], ASO: [10, 0], SON: [11, 0], OND: [12, 0], NDJ: [1, 1],
};
function dataDoTrimestre(temporada, ano) {
  const fim = FIM_TRIMESTRE[String(temporada || '').toUpperCase()];
  if (!fim || !Number.isInteger(ano)) return null;
  const mm = String(fim[0]).padStart(2, '0');
  return `${ano + fim[1]}-${mm}-01`;
}

/** Parser do oni.ascii.txt. Devolve linhas cronológicas
 *  [{temporada, ano, total, anom}]. Ignora cabeçalho e linhas ruins;
 *  lança Error se nenhuma linha válida. */
function parseOniAscii(texto) {
  const linhas = [];
  for (const crua of String(texto || '').split(/\r?\n/)) {
    const m = crua.trim().match(/^([A-Z]{3})\s+(\d{4})\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) continue;
    if (!FIM_TRIMESTRE[m[1]]) continue;
    linhas.push({ temporada: m[1], ano: Number(m[2]), total: Number(m[3]), anom: Number(m[4]) });
  }
  if (!linhas.length) throw new Error('oni.ascii.txt sem linhas válidas (formato mudou?)');
  return linhas;
}

/** Parser do sstoi.indices. Devolve linhas cronológicas
 *  [{ano, mes, nino12:{total,anom}, nino3, nino4, nino34}].
 *  Ignora cabeçalho e linhas ruins; lança Error se vazio. */
function parseSstoi(texto) {
  const linhas = [];
  for (const crua of String(texto || '').split(/\r?\n/)) {
    const p = crua.trim().split(/\s+/);
    if (p.length < 10) continue;
    const ano = Number(p[0]);
    const mes = Number(p[1]);
    const nums = p.slice(2, 10).map(Number);
    if (!Number.isInteger(ano) || !(mes >= 1 && mes <= 12) || nums.some((n) => !Number.isFinite(n))) continue;
    const [t12, a12, t3, a3, t4, a4, t34, a34] = nums;
    linhas.push({
      ano, mes,
      nino12: { total: t12, anom: a12 }, nino3: { total: t3, anom: a3 },
      nino4: { total: t4, anom: a4 }, nino34: { total: t34, anom: a34 },
    });
  }
  if (!linhas.length) throw new Error('sstoi.indices sem linhas válidas (formato mudou?)');
  return linhas;
}

async function buscarTexto(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function coletorNoaa() {
  return {
    id: 'noaa',
    nome: 'NOAA/CPC (ONI + regiões Niño)',
    /** Devolve ARRAY de amostras (últimos 24 ONI + última de cada
     *  região Niño). Falha com Error após retentativa. */
    async coletar({ timeoutMs = 15000 } = {}) {
      if (!noaaEnabled()) throw new Error('coletor NOAA desligado (ENSO_NOAA_ENABLED=0)');
      const urlOni = urlNoaaOni();
      const urlSst = urlNoaaSst();
      let ultimoErro = null;
      for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
        try {
          const [txtOni, txtSst] = await Promise.all([
            buscarTexto(urlOni, timeoutMs),
            buscarTexto(urlSst, timeoutMs),
          ]);
          const oni = parseOniAscii(txtOni);
          const sst = parseSstoi(txtSst);
          const amostras = [];
          for (const r of oni.slice(-24)) {
            const obs = dataDoTrimestre(r.temporada, r.ano);
            if (!obs) continue;
            amostras.push({
              indice: 'ONI', valor: r.anom, total: r.total,
              temporada: r.temporada, ano: r.ano, unidade: '°C',
              observadoEm: obs, fonte: urlOni, mock: false,
            });
          }
          const u = sst[sst.length - 1];
          const obsSst = `${u.ano}-${String(u.mes).padStart(2, '0')}-01`;
          for (const [indice, d] of [['NINO12', u.nino12], ['NINO3', u.nino3], ['NINO4', u.nino4], ['NINO34', u.nino34]]) {
            amostras.push({
              indice, valor: d.anom, total: d.total, ano: u.ano, mes: u.mes,
              unidade: '°C', observadoEm: obsSst, fonte: urlSst, mock: false,
            });
          }
          if (!amostras.length) throw new Error('nenhuma amostra extraída (verifique os formatos)');
          return amostras;
        } catch (e) {
          ultimoErro = e;
          await new Promise((r) => setTimeout(r, 500 * tentativa)); // backoff
        }
      }
      throw new Error(`coleta NOAA falhou após retentativa: ${ultimoErro && ultimoErro.message}`);
    },
  };
}

function staleHoras() {
  return clampNum(process.env.ENSO_FONTE_STALE_HORAS, 1, 720, 72);
}

/** Intervalo mínimo entre coletas manuais (anti-abuso da rota pública). */
function intervaloColetaMs() {
  return clampNum(process.env.ENSO_COLETA_INTERVALO_MIN, 1, 1440, 10) * 60000;
}

async function lerFonteStatus() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-fonte-status');
    return (doc && doc.fontes && typeof doc.fontes === 'object') ? doc.fontes : {};
  } catch {
    return {};
  }
}

async function gravarFonteStatus(fontes) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-fonte-status');
  resto.push({ id: 'enso-fonte-status', fontes, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return fontes;
}

/** Upsert em lote (1 leitura + 1 escrita) — evita N roundtrips ao
 *  banco quando um coletor devolve dezenas de amostras. */
async function registrarAmostras(lote) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'enso-indice');
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-indice');
  const lista = Array.isArray(doc && doc.lista) ? doc.lista : [];
  const vistos = new Set(lista.map((a) => `${a.fonte}|${a.observadoEm}`));
  const agoraIso = new Date().toISOString();
  for (const amostra of lote || []) {
    const chave = `${amostra.fonte}|${amostra.observadoEm}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    lista.push({ ...amostra, registradoEm: agoraIso });
  }
  resto.push({ id: 'enso-indice', lista: lista.slice(-500), updatedAt: agoraIso });
  await writeCollection('system_config', resto);
  return lista;
}

/** Upsert idempotente por (fonte, observadoEm) no doc "enso-indice". */
async function registrarAmostra(amostra) {
  return registrarAmostras([amostra]);
}

async function ultimaAmostra(indice) {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'enso-indice');
    const lista = Array.isArray(doc && doc.lista) ? doc.lista : [];
    if (indice) {
      for (let i = lista.length - 1; i >= 0; i -= 1) {
        if (lista[i] && lista[i].indice === indice) return lista[i];
      }
      return null;
    }
    return lista.length ? lista[lista.length - 1] : null;
  } catch {
    return null;
  }
}

/** Executa os coletores com falha isolada. Nunca lança.
 *  @param {{usarMock?: boolean, timeoutMs?: number}} opts */
async function executarColeta({ usarMock = true, timeoutMs = 10000 } = {}) {
  const coletores = [coletorNoaa()];
  if (usarMock) coletores.push(coletorMock());
  const fontes = await lerFonteStatus();
  const agora = Date.now();
  const amostras = [];
  for (const c of coletores) {
    try {
      const resultado = await c.coletar({ timeoutMs });
      const lote = Array.isArray(resultado) ? resultado : [resultado];
      await registrarAmostras(lote);
      amostras.push(...lote);
      const resumo = lote.map((a) => `${a.indice}=${a.valor}`).join(', ');
      fontes[c.id] = { ok: true, ultimoSucesso: new Date().toISOString(), ultimoErro: null, mensagem: `OK (${resumo}°C)` };
      logger.info('enso.coleta.ok', `${c.id}: ${lote.length} amostra(s).`, { fonte: c.id });
    } catch (e) {
      fontes[c.id] = { ...(fontes[c.id] || {}), ok: false, ultimoErro: new Date().toISOString(), mensagem: e.message };
      logger.warn('enso.coleta.falhou', `${c.id}: ${e.message} (módulo segue operando).`, { fonte: c.id });
    }
  }
  const limiteStale = staleHoras() * 3600000;
  for (const id of Object.keys(fontes)) {
    const f = fontes[id];
    const ref = f.ultimoSucesso ? Date.parse(f.ultimoSucesso) : 0;
    f.stale = agora - ref > limiteStale;
  }
  await gravarFonteStatus(fontes);
  return { amostras, fontes };
}

/* ============================================================
   Fontes oficiais (URLs 100% configuráveis via ENSO_FONTES_JSON).
   Padrões = links já exibidos na página antiga; NÃO foram
   verificados ao vivo nesta fase — valide antes de produção.
   ============================================================ */
const FONTES_PADRAO = [
  { id: 'inmet', nome: 'INMET', descricao: 'Instituto Nacional de Meteorologia', url: 'https://portal.inmet.gov.br' },
  { id: 'cptec', nome: 'CPTEC / INPE', descricao: 'Previsões e ENOS', url: 'https://www.cptec.inpe.br' },
  { id: 'cemaden', nome: 'CEMADEN', descricao: 'Centro de Monitoramento de Desastres', url: 'https://www.gov.br/cemaden' },
  { id: 'ana', nome: 'ANA / SNIRH', descricao: 'Níveis e vazões dos rios', url: 'https://www.snirh.gov.br' },
  { id: 'queimadas', nome: 'INPE Queimadas', descricao: 'Focos de calor', url: 'https://terrabrasilis.dpi.inpe.br' },
  { id: 'noaa', nome: 'NOAA / CPC', descricao: 'Classificação do ENOS', url: 'https://www.cpc.ncep.noaa.gov' },
];

function lerFontes() {
  const raw = process.env.ENSO_FONTES_JSON;
  if (!raw) return { fontes: FONTES_PADRAO.map((f) => ({ ...f })), origem: 'padrao' };
  try {
    const parsed = JSON.parse(raw);
    const lista = Array.isArray(parsed) ? parsed : parsed.fontes;
    if (!Array.isArray(lista) || !lista.length) throw new Error('sem fontes');
    return { fontes: lista.filter((f) => f && f.nome && f.url), origem: 'env' };
  } catch {
    return { fontes: FONTES_PADRAO.map((f) => ({ ...f })), origem: 'padrao' };
  }
}

const DISCLAIMER = 'A SGI PROTEGE é apenas uma ferramenta que facilita a visualização dos dados: não produz classificação própria. Em caso de divergência, valem os alertas oficiais do INMET, do CEMADEN e da Defesa Civil.';

module.exports = {
  // config / classificação
  LIMIARES_PADRAO, LIMIARES_LIMITES, NIVEIS, REGRAS_PADRAO, FONTES_PADRAO, DISCLAIMER,
  lerLimiares, gravarLimiares, limparLimiares, normalizarLimiares, classificar,
  // regras
  lerRegras, gravarRegras, limparRegras, regraValida,
  avaliarRegras, marcarEnvio, lerEstadoRegras, gravarEstadoRegras,
  histerese, reavisoMs,
  // alertas + auditoria
  lerAlertas, gravarAlertas, registrarAlertas, confirmarAlerta, marcarAlertaEnviado, auditar,
  // canais
  canais, despachar, dryRunAtivo, webhookUrl, CANAIS_IMPLEMENTADOS, CANAIS_STUB,
  // coletores
  executarColeta, registrarAmostra, registrarAmostras, ultimaAmostra, lerFonteStatus, coletorMock, coletorNoaa,
  intervaloColetaMs,
  parseOniAscii, parseSstoi, dataDoTrimestre, urlNoaaOni, urlNoaaSst, noaaEnabled,
  lerFontes,
  logger,
};
