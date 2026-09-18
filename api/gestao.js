/* ============================================================
   Gestão por município — CRUD das seções operacionais.
   Persistência: um documento JSON por município (gestao_<nome>.json).

   GET    /api/gestao?municipio=<nome>   → documento completo (seções)
   POST   /api/gestao                     → upsert de item { municipio, secao, item }
   DELETE /api/gestao?municipio=&secao=&id= → remove item

   Permissões:
     admin      → leitura/escrita em qualquer município
     municipal  → leitura/escrita SOMENTE no próprio município
     avancado   → somente leitura
     comum      → sem acesso
   ============================================================ */
const { jsonResponse, readJson, bearerToken } = require('./_lib/http');
const { verifyToken } = require('./_lib/auth');
const { readCollection, writeCollection } = require('./_lib/store');
const { serve } = require('./_lib/serverless');

const SECOES = [
  'areasDeRisco', 'plancon', 'coordenadores', 'voluntarios',
  'inventario', 'rotasFuga', 'viaturas', 'rastreadorRadio',
  'equipeAtual', 'sede', 'alojamento',
];

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function docName(municipio) {
  return 'gestao_' + norm(municipio).replace(/[^a-z0-9]/g, '_');
}
async function loadDoc(municipio) {
  const raw = await readCollection(docName(municipio));
  if (raw && raw.secoes) return raw;
  return { nome: String(municipio || '').trim(), updatedAt: null, secoes: {} };
}
async function userForPayload(payload) {
  const users = await readCollection('users');
  return users.find(u => String(u.id) === String(payload && payload.sub)) || null;
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const method = req.method;
  if (method === 'OPTIONS') return jsonResponse(204, {}, origin);

  let url = null;
  try { url = new URL(req.url, 'http://localhost'); } catch { /* não usamos */ }
  const qp = (k) => (url ? (url.searchParams.get(k) || '') : '');

  const token = bearerToken(req);
  const payload = token && verifyToken(token);

  if (method === 'GET') {
    const municipio = qp('municipio');
    if (!municipio) return jsonResponse(400, { erro: 'Informe ?municipio=<nome>.' }, origin);
    const doc = await loadDoc(municipio);
    return jsonResponse(200, { ok: true, municipio: doc.nome, secoes: doc.secoes }, origin);
  }

  const podeEscrever = async () => {
    if (!payload) return { ok: false, erro: 'Autenticação necessária.' };
    if (payload.perfil === 'admin') return { ok: true };
    if (payload.perfil !== 'municipal') return { ok: false, erro: 'Seu perfil não pode editar a gestão.' };
    const me = await userForPayload(payload);
    if (!me || !me.municipio) return { ok: false, erro: 'Seu perfil não está vinculado a um município.' };
    return { ok: true, munVinculado: norm(me.municipio) };
  };

  if (method === 'POST' || method === 'PUT') {
    const perm = await podeEscrever();
    if (!perm.ok) return jsonResponse(payload ? 403 : 401, { erro: perm.erro }, origin);
    const body = await readJson(req);
    const mun = body.municipio;
    const sec = body.secao;
    const item = body.item && typeof body.item === 'object' ? body.item : null;
    if (!mun || !sec || !item) {
      return jsonResponse(400, { erro: 'Campos obrigatórios: municipio, secao, item.' }, origin);
    }
    if (!SECOES.includes(sec)) return jsonResponse(400, { erro: 'Seção inválida.' }, origin);
    if (perm.munVinculado && norm(mun) !== perm.munVinculado) {
      return jsonResponse(403, { erro: 'Acesso limitado ao seu município.' }, origin);
    }
    const doc = await loadDoc(mun);
    const lista = Array.isArray(doc.secoes[sec]) ? doc.secoes[sec] : [];
    const id = item.id ? String(item.id) : String(Date.now());
    const base = Object.assign({}, item, { id });
    const idx = lista.findIndex(x => String(x.id) === String(id));
    if (idx >= 0) {
      lista[idx] = Object.assign({}, lista[idx], base, { atualizadoEm: new Date().toISOString(), atualizadoPor: payload.usuario });
    } else {
      lista.push(Object.assign({}, base, { criadoEm: new Date().toISOString(), criadoPor: payload.usuario }));
    }
    doc.secoes[sec] = lista;
    doc.updatedAt = Date.now();
    await writeCollection(docName(mun), doc);
    return jsonResponse(200, { ok: true, secao: sec, items: lista }, origin);
  }

  if (method === 'DELETE') {
    const perm = await podeEscrever();
    if (!perm.ok) return jsonResponse(payload ? 403 : 401, { erro: perm.erro }, origin);
    const municipio = qp('municipio');
    const secao = qp('secao');
    const id = qp('id');
    if (!municipio || !secao || !id) {
      return jsonResponse(400, { erro: 'Informe ?municipio=&secao=&id=.' }, origin);
    }
    if (perm.munVinculado && norm(municipio) !== perm.munVinculado) {
      return jsonResponse(403, { erro: 'Acesso limitado ao seu município.' }, origin);
    }
    if (!SECOES.includes(secao)) return jsonResponse(400, { erro: 'Seção inválida.' }, origin);
    const doc = await loadDoc(municipio);
    const lista = Array.isArray(doc.secoes[secao]) ? doc.secoes[secao] : [];
    const next = lista.filter(x => String(x.id) !== String(id));
    doc.secoes[secao] = next;
    doc.updatedAt = Date.now();
    await writeCollection(docName(municipio), doc);
    return jsonResponse(200, { ok: true, removed: next.length !== lista.length, secao, items: next }, origin);
  }

  return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
});