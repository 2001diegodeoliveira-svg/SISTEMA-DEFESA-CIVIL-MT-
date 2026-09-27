/* ============================================================
   Parâmetros do alerta de pluviômetro.

   O limiar é uma FRAÇÃO de um limite absoluto configurável:
   limiar = limiteMm * (percentual / 100).

   A leitura usada é o acumulado de 24h (c24) — é o mesmo critério
   técnico que o INMET usa para aviso de chuva intensa, o que evita
   alerta por pancada passageira. Medir "chuva agora" (mm/h) geraria
   alarme falso em quase toda chuva.

   Ordem de resolução do limite:
     1. valor salvo pelacollection "pluv-alerta" (PUT autenticado)
     2. env PLUV_ALERTA_LIMITE_MM
     3. padrão 100 mm
   O percentual tem a mesma lógica (env PLUV_ALERTA_PERCENTUAL, padrão 30)
   e a ativação também (env PLUV_ALERTA_ATIVO, padrão ligado).
   ============================================================ */
const { readCollection, writeCollection } = require('./store');

const COLECAO = 'pluv-alerta';
const DOC_ID = 'config';

const LIMITES = {
  /* Faixa aceita. Abaixo de 1 mm um "pluviômetro" nunca acusaria nada;
     acima de 1000 mm o alerta deixa de ser operativamente útil. */
  limiteMin: 1,
  limiteMax: 1000,
  pctMin: 1,
  pctMax: 100,
};

const PADRAO = {
  limiteMm: 100,
  percentual: 30,
  metrica: 'c24',
  /* A ativação também é do servidor: o mapa não decide sozinho quando
     o alerta está ligado. O operador liga/desliga daqui. */
  ativo: true,
};

function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* Só aceita boolean de verdade: Number("false") = NaN, Number("") = 0 e
   Number(null) = 0, então converter direto desligaria o alerta por
   acidente quando o campo vier ausente. */
function clampBool(v, dflt) {
  if (v === true || v === false) return v;
  return dflt;
}

function envFlag(nome, dflt) {
  const v = process.env[nome];
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on' || s === 'sim') return true;
  if (s === '0' || s === 'false' || s === 'off' || s === 'nao' || s === 'não') return false;
  return dflt;
}

function envOuPadrao() {
  return {
    limiteMm: clampNum(process.env.PLUV_ALERTA_LIMITE_MM, LIMITES.limiteMin, LIMITES.limiteMax, PADRAO.limiteMm),
    percentual: clampNum(process.env.PLUV_ALERTA_PERCENTUAL, LIMITES.pctMin, LIMITES.pctMax, PADRAO.percentual),
    ativo: envFlag('PLUV_ALERTA_ATIVO', PADRAO.ativo),
  };
}

/* Config efetiva = salvo no store, sobreposto pelo default de env. */
async function lerConfig() {
  const base = envOuPadrao();
  let col = [];
  try {
    col = await readCollection(COLECAO);
  } catch {
    col = [];
  }
  const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === DOC_ID);
  if (!doc) return { ...base, origem: 'env' };
  return {
    limiteMm: clampNum(doc.limiteMm, LIMITES.limiteMin, LIMITES.limiteMax, base.limiteMm),
    percentual: clampNum(doc.percentual, LIMITES.pctMin, LIMITES.pctMax, base.percentual),
    ativo: clampBool(doc.ativo, base.ativo),
    origem: 'store',
  };
}

async function gravarConfig(patch) {
  const atual = await lerConfig();
  const novo = {
    id: DOC_ID,
    limiteMm: clampNum(patch.limiteMm, LIMITES.limiteMin, LIMITES.limiteMax, atual.limiteMm),
    percentual: clampNum(patch.percentual, LIMITES.pctMin, LIMITES.pctMax, atual.percentual),
    ativo: clampBool(patch.ativo, atual.ativo),
    metrica: PADRAO.metrica,
    updatedAt: new Date().toISOString(),
    updatedBy: patch.updatedBy || null,
  };
  const col = (await readCollection(COLECAO)) || [];
  const i = col.findIndex((d) => d && d.id === DOC_ID);
  if (i >= 0) col[i] = novo;
  else col.push(novo);
  await writeCollection(COLECAO, col);
  return novo;
}

/* Remove o override salvo → volta a valer o default de env. */
async function limparConfig() {
  const col = (await readCollection(COLECAO)) || [];
  const filtrada = col.filter((d) => !d || d.id !== DOC_ID);
  await writeCollection(COLECAO, filtrada);
  return lerConfig();
}

/* Percentual atingido por uma leitura. Retorna null se a leitura for
   ausente/inválida, para o chamador não contar estação sem dado.
   Atenção: Number(null), Number('') e Number([]) valem 0, então a
   ausência precisa ser barrada ANTES da conversão — do contrário uma
   estação sem leitura entraria como 0 mm (0%) em vez de ser ignorada. */
function percentualAtingido(valor, limiteMm) {
  if (valor === null || valor === undefined || valor === '' || typeof valor === 'boolean') return null;
  if (Array.isArray(valor)) return null;
  const v = Number(valor);
  if (!Number.isFinite(v) || v < 0) return null;
  if (!Number.isFinite(limiteMm) || limiteMm <= 0) return null;
  return (v / limiteMm) * 100;
}

/* Avalia a lista de estações e separa as que cruzaram o limiar.
   stations: [{ codigo, nome, lat, lon, c24 }] */
function avaliar(stations, cfg) {
  const limiar = cfg.limiteMm * (cfg.percentual / 100);
  const alerta = [];
  let acima = 0, avaliadas = 0;
  for (const s of Array.isArray(stations) ? stations : []) {
    if (!s) continue;
    const pct = percentualAtingido(s.c24, cfg.limiteMm);
    if (pct === null) continue;
    avaliadas++;
    const cruza = s.c24 >= limiar;
    if (cruza) acima++;
    alerta.push({
      codigo: String(s.codigo || ''),
      nome: s.nome || 'Estação sem nome',
      lat: Number(s.lat) || null,
      lon: Number(s.lon) || null,
      c24: Number(s.c24) || 0,
      percentual: +pct.toFixed(1),
      acima: cruza,
    });
  }
  // Pior primeiro: quem mais se aproximou do limite abre o popup primeiro.
  alerta.sort((a, b) => Number(b.c24) - Number(a.c24));
  return {
    limiarMm: +limiar.toFixed(2),
    totalAvaliadas: avaliadas,
    totalAcima: acima,
    estacoes: alerta,
  };
}

module.exports = {
  COLECAO,
  DOC_ID,
  LIMITES,
  PADRAO,
  lerConfig,
  gravarConfig,
  limparConfig,
  percentualAtingido,
  avaliar,
};
