/* ============================================================
   Motor de avaliação de regras de alerta (Fase 5).
   Regras por área monitorada (tipos):
     foco_novo    — focos INPE do dia dentro da área, novos desde
                    o último ciclo (snapshot por área+regra)
     chuva_24h    — open-meteo no centroide >= mm (default = config
                    global do pluv-alerta)
     aviso_inmet  — aviso vigente cujo polígono/área cruza a área
     estacao_pane — estação INMET em pane dentro da área
   Dedup: não recria evento aberto igual (mesma área+regra+dia).
   Eventos em system_config doc "alertas-eventos" (teto 500) +
   trilha em audit_logs. Envio por push (web-push) e Telegram
   (fetch puro); falhas de canal viram resultado auditado.
   Fetchers injetáveis (testes): avaliarTodas(areas, {buscar}).
   ============================================================ */
const { readCollection, writeCollection, push } = require('./store');

const TIMEOUT_MS = 15000;
const MAX_EVENTOS = 500;

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

async function buscarTexto(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SGIProtege/1.0 (+motor-alertas)', Accept: '*/*' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function buscarJson(url, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SGIProtege/1.0 (+motor-alertas)', Accept: 'application/json' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- geometria ---------- */
function bboxDaArea(area) {
  if (area.bbox) return area.bbox;
  const pts = Array.isArray(area.coords) ? area.coords : [];
  if (!pts.length) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of pts) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (minLat > maxLat) return null;
  return { minLat, maxLat, minLon, maxLon };
}

function emBbox(lat, lon, bbox) {
  return bbox && lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

function emPoligono(lat, lon, coords) {
  if (!Array.isArray(coords) || coords.length < 3) return true; // sem polígono: vale o bbox
  let dentro = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const [laI, loI] = coords[i];
    const [laJ, loJ] = coords[j];
    if ((loI > lon) !== (loJ > lon) && lat < ((laJ - laI) * (lon - loI)) / (loJ - loI) + laI) {
      dentro = !dentro;
    }
  }
  return dentro;
}

function centroide(bbox) {
  if (!bbox) return null;
  return { lat: (bbox.minLat + bbox.maxLat) / 2, lon: (bbox.minLon + bbox.maxLon) / 2 };
}

/* ---------- fetchers reais (substituíveis em testes) ---------- */
function parseFocosCSV(txt) {
  const linhas = String(txt || '').split('\n');
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(',').map((h) => h.trim());
  const idx = {};
  ['lat', 'lon', 'data_hora_gmt', 'satelite', 'municipio', 'estado'].forEach((k) => { idx[k] = cab.indexOf(k); });
  const out = [];
  for (let i = 1; i < linhas.length; i++) {
    const c = linhas[i].split(',');
    if (c.length < cab.length - 2) continue;
    const lat = parseFloat(c[idx.lat]);
    const lon = parseFloat(c[idx.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      lat, lon,
      data: (c[idx.data_hora_gmt] || '').trim(),
      satelite: (c[idx.satelite] || '').trim(),
      municipio: (c[idx.municipio] || '').trim(),
      estado: (c[idx.estado] || '').trim(),
    });
  }
  return out;
}

const buscarPadrao = {
  async focosDoDia() {
    const iso = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const txt = await buscarTexto(
      `https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_${iso}.csv`
    );
    return parseFocosCSV(txt);
  },
  async avisos() {
    const { parseLista } = require('../_routes/avisos');
    const txt = await buscarTexto('https://apiprevmet3.inmet.gov.br/avisos/rss');
    return parseLista(txt).filter((a) => a.vigente);
  },
  async avisoDetalhe(id) {
    const { parseDetalhe } = require('../_routes/avisos');
    const txt = await buscarTexto(`https://apiprevmet3.inmet.gov.br/avisos/rss/${id}`);
    return parseDetalhe(txt);
  },
  async chuva24h(lat, lon) {
    const j = await buscarJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&daily=precipitation_sum&forecast_days=3&past_days=3&timezone=auto'
    );
    const dias = (j.daily && j.daily.time) || [];
    const vals = (j.daily && j.daily.precipitation_sum) || [];
    const hoje = new Date().toISOString().slice(0, 10);
    let mm = 0;
    for (let i = 0; i < dias.length; i++) {
      if (dias[i] === hoje) mm += Number(vals[i]) || 0;
    }
    return mm;
  },
  async estacoes() {
    const j = await buscarJson('https://apitempo.inmet.gov.br/estacoes/T');
    return Array.isArray(j) ? j : [];
  },
  async limiarChuvaGlobal() {
    try {
      const pluv = require('./pluvialerta');
      const cfg = await pluv.lerConfig();
      return cfg.limiarMm != null ? cfg.limiarMm : 30;
    } catch {
      return 30;
    }
  },
};

/* ---------- snapshots (o que já foi visto por área+regra) ---------- */
async function lerSnapshots() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'motor-snapshots');
    return (doc && doc.mapa && typeof doc.mapa === 'object') ? doc.mapa : {};
  } catch {
    return {};
  }
}

async function gravarSnapshots(mapa) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'motor-snapshots');
  resto.push({ id: 'motor-snapshots', mapa, updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
}

/* ---------- eventos ---------- */
async function lerEventos() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'alertas-eventos');
    return Array.isArray(doc && doc.lista) ? doc.lista : [];
  } catch {
    return [];
  }
}

async function gravarEventos(lista) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'alertas-eventos');
  resto.push({ id: 'alertas-eventos', lista: lista.slice(-MAX_EVENTOS), updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return lista;
}

async function auditar(action, metadata) {
  const entry = {
    id: `motor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    action: `motor.${action}`,
    metadata: metadata || {},
    createdAt: new Date().toISOString(),
  };
  try {
    await push('audit_logs', { id: entry.id, action: entry.action, metadata: entry.metadata, createdAt: entry.createdAt });
  } catch (e) {
    console.error('[motor] falha ao auditar:', e && e.message);
  }
  return entry;
}

/* ---------- avaliação ---------- */
const SEVERIDADE = {
  foco_novo: 'alto',
  chuva_24h: 'alto',
  aviso_inmet: null, // vem do nível do aviso
  estacao_pane: 'medio',
};

function chaveDedup(areaId, tipo, extra) {
  return `${areaId}|${tipo}|${hojeISO()}|${extra || ''}`;
}

async function avaliarArea(area, buscar = buscarPadrao, ctx = {}) {
  const bbox = bboxDaArea(area);
  if (!bbox) return { areaId: area.id, eventos: [], erros: ['área sem geometria'] };
  const eventos = [];
  const erros = [];
  const snaps = ctx.snaps || {};
  const regras = Array.isArray(area.regras) && area.regras.length
    ? area.regras
    : [{ tipo: 'foco_novo' }, { tipo: 'aviso_inmet' }];

  for (const regra of regras) {
    const tipo = regra.tipo;
    try {
      if (tipo === 'foco_novo') {
        const focos = await buscar.focosDoDia();
        const dentro = focos.filter((f) => emBbox(f.lat, f.lon, bbox) && emPoligono(f.lat, f.lon, area.coords));
        const vistos = new Set(snaps[`${area.id}|foco_novo`] || []);
        const novos = dentro.filter((f) => {
          const k = `${f.lat.toFixed(3)},${f.lon.toFixed(3)}`;
          return !vistos.has(k);
        });
        snaps[`${area.id}|foco_novo`] = dentro.map((f) => `${f.lat.toFixed(3)},${f.lon.toFixed(3)}`);
        if (novos.length) {
          eventos.push({
            tipo, severidade: SEVERIDADE.foco_novo,
            titulo: `${novos.length} novo(s) foco(s) em ${area.nome}`,
            detalhe: `INPE BDQueimadas: ${novos.slice(0, 5).map((f) => `${f.municipio || '?'} (${f.lat.toFixed(2)},${f.lon.toFixed(2)})`).join('; ')}${novos.length > 5 ? '…' : ''}`,
            dados: { total: novos.length },
            dedup: chaveDedup(area.id, tipo, `n${novos.length}`),
          });
        }
      } else if (tipo === 'chuva_24h') {
        const c = centroide(bbox);
        const mm = await buscar.chuva24h(c.lat.toFixed(4), c.lon.toFixed(4));
        const limiar = Number(regra.mm) > 0 ? Number(regra.mm) : await buscar.limiarChuvaGlobal();
        if (mm >= limiar) {
          eventos.push({
            tipo, severidade: SEVERIDADE.chuva_24h,
            titulo: `Chuva de ${mm.toFixed(1)} mm/24h em ${area.nome} (limiar ${limiar} mm)`,
            detalhe: `Acumulado 24h no centroide da área.`,
            dados: { mm: +mm.toFixed(1), limiar },
            dedup: chaveDedup(area.id, tipo, `mm${Math.round(mm)}`),
          });
        }
      } else if (tipo === 'aviso_inmet') {
        const avisos = await buscar.avisos();
        for (const a of avisos) {
          let cruza = false;
          try {
            const det = await buscar.avisoDetalhe(a.id);
            const poly = det && det.poligono;
            if (poly && poly.length) {
              cruza = poly.some(([la, lo]) => emBbox(la, lo, bbox));
            } else {
              cruza = true; // sem polígono: presume cobertura (listado como vigente)
            }
          } catch {
            cruza = true;
          }
          if (!cruza) continue;
          eventos.push({
            tipo, severidade: a.nivel >= 3 ? 'critico' : (a.nivel === 2 ? 'alto' : 'medio'),
            titulo: `Aviso INMET: ${a.evento} (${a.severidade}) — ${area.nome}`,
            detalhe: (a.descricao || '').slice(0, 280),
            dados: { avisoId: a.id, nivel: a.nivel, fim: a.fim },
            dedup: chaveDedup(area.id, tipo, `aviso${a.id}`),
          });
        }
      } else if (tipo === 'estacao_pane') {
        const estacoes = await buscar.estacoes();
        const panes = estacoes.filter((s) => {
          const lat = parseFloat(s.VL_LATITUDE);
          const lon = parseFloat(s.VL_LONGITUDE);
          return emBbox(lat, lon, bbox)
            && String(s.CD_SITUACAO || '').toLowerCase() !== 'operante';
        });
        if (panes.length) {
          eventos.push({
            tipo, severidade: SEVERIDADE.estacao_pane,
            titulo: `${panes.length} estação(ões) INMET em pane em ${area.nome}`,
            detalhe: panes.slice(0, 5).map((s) => `${s.DC_NOME} (${s.CD_ESTACAO})`).join('; '),
            dados: { total: panes.length },
            dedup: chaveDedup(area.id, tipo, `n${panes.length}`),
          });
        }
      }
    } catch (e) {
      erros.push(`${tipo}: ${e.message}`);
    }
  }
  return { areaId: area.id, eventos, erros };
}

async function registrarEventos(area, avaliados) {
  const lista = await lerEventos();
  const abertos = new Set(lista.filter((e) => e.estado === 'aberto').map((e) => e.dedup));
  const novos = [];
  for (const ev of avaliados) {
    if (abertos.has(ev.dedup)) continue;
    const item = {
      id: `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      areaId: area.id,
      areaNome: area.nome,
      uf: area.uf || null,
      ...ev,
      estado: 'aberto',
      criadoEm: new Date().toISOString(),
      reconhecidoPor: null,
      reconhecidoEm: null,
      envios: [],
    };
    lista.push(item);
    abertos.add(item.dedup);
    novos.push(item);
  }
  await gravarEventos(lista);
  return novos;
}

module.exports = {
  bboxDaArea, emBbox, emPoligono, centroide, parseFocosCSV,
  lerSnapshots, gravarSnapshots, lerEventos, gravarEventos, auditar,
  avaliarArea, registrarEventos, buscarPadrao, SEVERIDADE,
};
