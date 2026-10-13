/* ============================================================
   Áreas monitoradas (Fase 5).
   GET  /api/areas-monitoradas            público: lista + regras
   POST /api/areas-monitoradas            autenticado: cria
     <- {nome, bbox|coords, municipio?, uf?, regras?, canais?}
   PUT  /api/areas-monitoradas?id=        autenticado: atualiza
   DELETE /api/areas-monitoradas?id=      autenticado: remove
   Regras válidas: foco_novo, chuva_24h {mm?}, aviso_inmet,
   estacao_pane. Sem regras = padrão [foco_novo, aviso_inmet].
   Persistência: system_config doc "areas-monitoradas".
   ============================================================ */
const { jsonResponse, readJson, bearerToken, reqUrl } = require('../_lib/http');
const { verifyToken } = require('../_lib/auth');
const { serve } = require('../_lib/serverless');
const { readCollection, writeCollection } = require('../_lib/store');

const TIPOS_REGRA = new Set(['foco_novo', 'chuva_24h', 'aviso_inmet', 'estacao_pane']);

function bboxValido(b) {
  return b && Number.isFinite(b.minLat) && Number.isFinite(b.maxLat)
    && Number.isFinite(b.minLon) && Number.isFinite(b.maxLon)
    && b.minLat >= -90 && b.maxLat <= 90 && b.minLon >= -180 && b.maxLon <= 180
    && b.minLat < b.maxLat && b.minLon < b.maxLon;
}

function normalizarRegras(regras) {
  if (regras === undefined) return [{ tipo: 'foco_novo' }, { tipo: 'aviso_inmet' }];
  if (!Array.isArray(regras) || !regras.length) throw new Error('Regras inválidas: lista vazia.');
  return regras.map((r) => {
    const tipo = r && r.tipo;
    if (!TIPOS_REGRA.has(tipo)) throw new Error(`Regra inválida: ${tipo}.`);
    const out = { tipo };
    if (tipo === 'chuva_24h' && r.mm !== undefined) {
      const mm = Number(r.mm);
      if (!Number.isFinite(mm) || mm < 1 || mm > 1000) throw new Error('chuva_24h.mm deve estar entre 1 e 1000.');
      out.mm = mm;
    }
    return out;
  });
}

function normalizarCanais(canais) {
  const c = canais && typeof canais === 'object' ? canais : {};
  const chats = Array.isArray(c.telegramChats)
    ? [...new Set(c.telegramChats.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20)
    : [];
  return { push: c.push !== false, telegram: c.telegram === true, telegramChats: chats };
}

function bboxDeCoords(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, n = 0;
  for (const p of coords) {
    const lat = Number(p && p[0]);
    const lon = Number(p && p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    n++;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (!n) return null;
  return { minLat, maxLat, minLon, maxLon };
}

async function lerAreas() {
  try {
    const col = await readCollection('system_config');
    const doc = (Array.isArray(col) ? col : []).find((d) => d && d.id === 'areas-monitoradas');
    return Array.isArray(doc && doc.lista) ? doc.lista : [];
  } catch {
    return [];
  }
}

async function gravarAreas(lista) {
  const col = await readCollection('system_config');
  const resto = (Array.isArray(col) ? col : []).filter((d) => !d || d.id !== 'areas-monitoradas');
  resto.push({ id: 'areas-monitoradas', lista: lista.slice(-500), updatedAt: new Date().toISOString() });
  await writeCollection('system_config', resto);
  return lista;
}

function validarNova(body) {
  const nome = String((body && body.nome) || '').trim().slice(0, 80);
  if (!nome) throw new Error('Informe o nome da área.');
  let bbox = (body && body.bbox) || null;
  const coords = body && Array.isArray(body.coords) ? body.coords.slice(0, 500) : null;
  if (!bboxValido(bbox)) bbox = coords ? bboxDeCoords(coords) : null;
  if (!bboxValido(bbox)) throw new Error('Informe bbox ou coords (polígono) válidos.');
  return {
    nome,
    bbox,
    coords,
    municipio: String((body && body.municipio) || '').slice(0, 80) || null,
    uf: String((body && body.uf) || '').toUpperCase().slice(0, 2) || null,
    regras: normalizarRegras(body && body.regras),
    canais: normalizarCanais(body && body.canais),
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  const ru = reqUrl(req);
  const id = ru ? ru.searchParams.get('id') : null;

  if (req.method === 'GET') {
    const lista = await lerAreas();
    return jsonResponse(200, { total: lista.length, areas: lista }, origin);
  }

  const token = bearerToken(req);
  const payload = token && verifyToken(token);
  if (!payload) return jsonResponse(401, { erro: 'Autenticação necessária.' }, origin);

  if (req.method === 'POST' && !id) {
    const body = await readJson(req);
    let nova;
    try {
      nova = validarNova(body);
    } catch (e) {
      return jsonResponse(400, { erro: e.message }, origin);
    }
    nova.id = `am-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    nova.criadoPor = payload.sub || null;
    nova.criadoEm = new Date().toISOString();
    const lista = await lerAreas();
    lista.push(nova);
    await gravarAreas(lista);
    return jsonResponse(201, { area: nova }, origin);
  }

  if ((req.method === 'PUT' || req.method === 'DELETE') && id) {
    const lista = await lerAreas();
    const i = lista.findIndex((a) => String(a.id) === String(id));
    if (i < 0) return jsonResponse(404, { erro: 'Área não encontrada.' }, origin);
    if (req.method === 'DELETE') {
      lista.splice(i, 1);
      await gravarAreas(lista);
      return jsonResponse(200, { removida: id }, origin);
    }
    const body = await readJson(req);
    let patch;
    try {
      patch = validarNova({ ...lista[i], ...body });
    } catch (e) {
      return jsonResponse(400, { erro: e.message }, origin);
    }
    lista[i] = { ...lista[i], ...patch, id: lista[i].id };
    await gravarAreas(lista);
    return jsonResponse(200, { area: lista[i] }, origin);
  }

  return jsonResponse(405, { erro: 'Método não suportado.' }, origin);
});

module.exports.lerAreas = lerAreas;
module.exports.gravarAreas = gravarAreas;
module.exports.TIPOS_REGRA = [...TIPOS_REGRA];
