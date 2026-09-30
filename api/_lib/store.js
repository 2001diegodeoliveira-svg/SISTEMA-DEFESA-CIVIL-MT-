/* ============================================================
   Camada de persistência da Defesa Civil MT.
   Drivers:
     - 'pg'    : PostgreSQL (Neon) quando DATABASE_URL definido
                (e FILE_STORE não for igual a "1")
     - 'file'  : arquivos JSON em ./data (uso local/servidor próprio)
     - 'kv'    : Vercel KV (Upstash) quando KV_REST_API_URL definido
     - 'memory': fallback em memória (Vercel sem banco configurado)

   Todas as funções exportadas mantêm o MESMO contrato JSON dos
   arquivos antigos — as rotas não precisam saber de SQL. Aqui
   traduzimos coleção ↔ tabela (camelCase ↔ snake_case).
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const dataDir = path.join(__dirname, '..', '..', 'data');

function driver() {
  if (process.env.DATABASE_URL && process.env.FILE_STORE !== '1') return 'pg';
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) return 'kv';
  if (process.env.VERCEL) {
    // Em serverless a File store é efêmera (sem escrito persistente garantido)
    return process.env.FILE_STORE === '1' ? 'file' : 'memory';
  }
  return process.env.FILE_STORE === '0' ? 'memory' : 'file';
}

function filePath(name) {
  return path.join(dataDir, name.replace(/[^a-z0-9_\-]/gi, '') + '.json');
}

/* ============================================================
   Driver PostgreSQL (Neon)
   ============================================================ */
let pool = null;
let munsCache = null;

function getPool() {
  if (pool) return pool;
  const opts = { connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
  const url = process.env.DATABASE_URL;
  if (/neon\.tech/.test(url) && !/sslmode=(disable|allow|prefer)/i.test(url)) {
    opts.ssl = { rejectUnauthorized: false };
  }
  pool = new Pool(opts);
  return pool;
}

/* ---- helpers de conversão ---- */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function tsPg(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function tsMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}
function docKey(s) {
  return norm(s).replace(/[^a-z0-9]/g, '_');
}
function enumOk(v, lista, fallback) {
  const s = String(v || '').toUpperCase();
  return lista.includes(s) ? s : fallback;
}
/* Perfil é lowercase; enumOk (que usa uppercase) NÃO pode ser usado aqui. */
function perfilOk(v) {
  const s = String(v || '').toLowerCase();
  return ['admin', 'avancado', 'municipal', 'comum'].includes(s) ? s : 'comum';
}

const TIPOS = ['ACIDENTE', 'ENGARRAFAMENTO', 'PERIGO', 'CLIMA', 'INTERDICAO', 'OBRA', 'OUTROS'];
const STATUS = ['NOVA', 'EM_ANALISE', 'EM_ATENDIMENTO', 'ENCAMINHADA', 'RESOLVIDA', 'ENCERRADA'];
const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'];

/* ---- catálogo de municípios (usado por users/gestão) ---- */
async function muns() {
  if (munsCache) return munsCache;
  const { rows } = await getPool().query('SELECT id, nome FROM municipios');
  const byId = new Map();
  const byNorm = new Map();
  const byDoc = new Map();
  for (const r of rows) {
    byId.set(r.id, r.nome);
    byNorm.set(norm(r.nome), { id: r.id, nome: r.nome });
    byDoc.set(docKey(r.nome), { id: r.id, nome: r.nome });
  }
  munsCache = { byNorm, byDoc, byId };
  return munsCache;
}

async function inTx(fn) {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    c.release();
  }
}

function placeholders(rows, nCols) {
  return rows.map((_, i) => `(${Array.from({ length: nCols }, (_, j) => '$' + (i * nCols + j + 1)).join(',')})`).join(',');
}

/* ---- ocorrências ---- */
function occToRow(o) {
  return {
    id: String(o.id ?? ''),
    external_id: String(o.externalId ?? ''),
    source: String(o.source || 'WAZE').toUpperCase(),
    type: enumOk(o.type, TIPOS, 'OUTROS'),
    subtype: o.subtype || null,
    description: o.description || '',
    latitude: num(o.latitude),
    longitude: num(o.longitude),
    street: o.street || null,
    city: o.city || null,
    state: o.state || null,
    country: o.country || null,
    direction: o.direction || null,
    magnitude: num(o.magnitude),
    reliability: num(o.reliability),
    confidence: num(o.confidence),
    reported_at: tsPg(o.reportedAt),
    received_at: tsPg(o.receivedAt),
    updated_at: tsPg(o.updatedAt),
    status: enumOk(o.status, STATUS, 'NOVA'),
    priority: o.priority ? enumOk(o.priority, PRIORIDADES, 'BAIXA') : null,
    raw_data: o.rawData && typeof o.rawData === 'object' ? JSON.stringify(o.rawData) : (o.rawData || null),
  };
}
function occFromRow(r) {
  return {
    id: r.id,
    externalId: r.external_id,
    source: r.source,
    type: r.type,
    subtype: r.subtype,
    description: r.description,
    latitude: r.latitude,
    longitude: r.longitude,
    street: r.street,
    city: r.city,
    state: r.state,
    country: r.country,
    direction: r.direction,
    magnitude: r.magnitude,
    reliability: r.reliability,
    confidence: r.confidence,
    reportedAt: tsMs(r.reported_at),
    receivedAt: tsMs(r.received_at),
    updatedAt: tsMs(r.updated_at),
    status: r.status,
    priority: r.priority,
    rawData: r.raw_data !== null && r.raw_data !== undefined ? r.raw_data : null,
  };
}

/* ---- pg: usuários ---- */
async function pgReadUsers() {
  const { rows } = await getPool().query(
    'SELECT u.*, m.nome AS municipio_nome FROM usuarios u LEFT JOIN municipios m ON m.id = u.municipio_id'
  );
  return rows.map((r) => ({
    id: r.id,
    usuario: r.usuario,
    senhaHash: r.senha_hash,
    nome: r.nome,
    perfil: r.perfil,
    municipio: r.municipio_nome || '',
    ativo: r.ativo,
    cadastroId: r.cadastro_id,
    bootstrapAdmin: r.bootstrap_admin,
    otp: r.totp_secret ? { secret: r.totp_secret, ativo: r.totp_habilitado === true } : null,
    criadoEm: r.criado_em ? r.criado_em.toISOString() : undefined,
  }));
}
async function pgWriteUsers(list) {
  const m = await muns();
  const rows = (Array.isArray(list) ? list : []).map((u) => {
    const mun = u.municipio ? m.byNorm.get(norm(u.municipio)) : undefined;
    return [u.usuario, u.senhaHash, u.nome || '', perfilOk(u.perfil), mun ? mun.id : null,
      u.ativo !== false, u.cadastroId || null, u.bootstrapAdmin === true,
      (u.otp && u.otp.secret) || null, Boolean(u.otp && u.otp.ativo), tsPg(u.criadoEm)];
  });
  if (!rows.length) return;
  const sql =
    `INSERT INTO usuarios (usuario, senha_hash, nome, perfil, municipio_id, ativo, cadastro_id, bootstrap_admin, totp_secret, totp_habilitado, criado_em)
     VALUES ${placeholders(rows, 11)}
     ON CONFLICT (usuario) DO UPDATE SET
       senha_hash = EXCLUDED.senha_hash, nome = EXCLUDED.nome,
       perfil = EXCLUDED.perfil, municipio_id = EXCLUDED.municipio_id,
       ativo = EXCLUDED.ativo, cadastro_id = EXCLUDED.cadastro_id,
       bootstrap_admin = EXCLUDED.bootstrap_admin,
       totp_secret = EXCLUDED.totp_secret, totp_habilitado = EXCLUDED.totp_habilitado`;
  await getPool().query(sql, rows.flat());
}

function registrationFromRow(row) {
  return {
    ...row.dados,
    id: row.id,
    usuario: row.usuario,
    senhaHash: row.senha_hash,
    status: row.status,
    situacao: row.situacao,
    parecer: row.parecer,
    criadoEm: tsMs(row.criado_em),
    atualizadoEm: tsMs(row.atualizado_em),
    avaliadoEm: tsMs(row.avaliado_em),
    avaliadoPor: row.avaliado_por,
  };
}

async function pgReadUserRegistrations() {
  const { rows } = await getPool().query('SELECT * FROM solicitacoes_usuarios ORDER BY criado_em DESC');
  return rows.map(registrationFromRow);
}

async function pgCreateUserRegistration(registration) {
  const { rows } = await getPool().query(
    `INSERT INTO solicitacoes_usuarios
       (id, usuario, senha_hash, email, cpf, dados, status, situacao, parecer, criado_em, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,'Pendente','Ativo','',$7,$7)
     RETURNING *`,
    [registration.id, registration.usuario, registration.senhaHash,
      registration.email.toLowerCase(), registration.cpf.replace(/\D/g, ''),
      JSON.stringify(registration.dados), tsPg(registration.criadoEm)]
  );
  return registrationFromRow(rows[0]);
}

async function pgUpdateUserRegistration(id, changes) {
  const municipalityCache = changes.status === 'Aprovado' ? await muns() : null;
  return inTx(async (client) => {
    const found = await client.query('SELECT * FROM solicitacoes_usuarios WHERE id = $1 FOR UPDATE', [String(id)]);
    if (!found.rows[0]) return null;
    const current = registrationFromRow(found.rows[0]);
    if (current.status !== 'Pendente') {
      const error = new Error('Somente solicitações pendentes podem ser analisadas.');
      error.code = 'REGISTRATION_NOT_PENDING';
      throw error;
    }

    const data = { ...current, ...(changes.dados || {}), ...(changes.nivel ? { nivel: changes.nivel } : {}) };
    data.historico = (data.historico || []).concat([{
      data: new Date().toISOString(),
      autor: changes.avaliadoPor || 'admin',
      acao: changes.status === 'Aprovado' ? 'Cadastro aprovado' : 'Cadastro recusado',
      detalhe: changes.parecer || '',
    }]);
    if (changes.status === 'Aprovado') {
      const perfil = data.perfil === 'Municipal'
        ? 'municipal'
        : (data.nivel === 'Consulta' ? 'comum' : 'avancado');
      const municipality = data.perfil === 'Municipal'
        ? municipalityCache.byNorm.get(norm(data.municipio))
        : null;
      if (data.perfil === 'Municipal' && !municipality) {
        const error = new Error('Município inválido para vincular a conta.');
        error.code = 'INVALID_MUNICIPALITY';
        throw error;
      }

      await client.query(
        `INSERT INTO usuarios (usuario, senha_hash, nome, perfil, municipio_id, ativo, cadastro_id, bootstrap_admin, criado_em)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,FALSE,now())`,
        [current.usuario, current.senhaHash, data.nome || '', perfil, municipality ? municipality.id : null, current.id]
      );
    }

    const { rows } = await client.query(
      `UPDATE solicitacoes_usuarios
          SET dados = $2::jsonb, email = $3, cpf = $4, status = $5,
              parecer = $6, atualizado_em = now(), avaliado_em = now(), avaliado_por = $7
        WHERE id = $1 RETURNING *`,
      [String(id), JSON.stringify(data), String(data.email || '').toLowerCase(),
        String(data.cpf || '').replace(/\D/g, ''), changes.status,
        changes.parecer || '', changes.avaliadoPor || 'admin']
    );
    return registrationFromRow(rows[0]);
  });
}

async function pgDeleteUserRegistration(id) {
  const result = await getPool().query(
    `DELETE FROM solicitacoes_usuarios WHERE id = $1 AND status <> 'Aprovado'`, [String(id)]
  );
  return result.rowCount > 0;
}

/* ---- pg: ocorrências ---- */
async function pgReadOccurrences() {
  const { rows } = await getPool().query('SELECT * FROM occurrences');
  return rows.map(occFromRow);
}
async function pgWriteOccurrences(list) {
  const rows = (Array.isArray(list) ? list : []).map(occToRow);
  await inTx(async (c) => {
    await c.query('DELETE FROM occurrences');
    for (const b of chunks(rows, 500)) {
      if (!b.length) continue;
      const n = 22;
      const sql =
        `INSERT INTO occurrences (id, external_id, source, type, subtype, description, latitude, longitude,
           street, city, state, country, direction, magnitude, reliability, confidence,
           reported_at, received_at, updated_at, status, priority, raw_data)
         VALUES ${placeholders(b, n)}`;
      await c.query(sql, b.flatMap((r) => [
        r.id, r.external_id, r.source, r.type, r.subtype, r.description, r.latitude, r.longitude,
        r.street, r.city, r.state, r.country, r.direction, r.magnitude, r.reliability, r.confidence,
        r.reported_at, r.received_at, r.updated_at, r.status, r.priority, r.raw_data,
      ]));
    }
  });
}

/* ---- pg: reports ---- */
function repToRow(r) {
  return {
    id: String(r.id), type: r.type, severity: r.severity || 'info', location: r.location,
    description: r.description, reporter: r.reporter || 'Anônimo', lat: num(r.lat), lng: num(r.lng),
    created_at: tsPg(r.createdAt), authored_by: num(r.authoredBy),
  };
}
async function pgPushReport(item) {
  const r = repToRow(item);
  await getPool().query(
    `INSERT INTO reports (id, type, severity, location, description, reporter, lat, lng, created_at, authored_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [r.id, r.type, r.severity, r.location, r.description, r.reporter, r.lat, r.lng, r.created_at, r.authored_by]
  );
}

/* ---- pg: áreas ---- */
function areaToRow(a) {
  return {
    id: String(a.id), nome: a.nome,
    coords: JSON.stringify(a.coords), area_km2: num(a.areaKm2),
    estacoes: Number(a.estacoes) || 0, created_at: tsPg(a.createdAt), authored_by: num(a.authoredBy),
  };
}
async function pgReadAreas() {
  const { rows } = await getPool().query('SELECT * FROM areas');
  return rows.map((r) => ({
    id: r.id, nome: r.nome,
    coords: r.coords !== null && r.coords !== undefined ? r.coords : null,
    areaKm2: r.area_km2, estacoes: r.estacoes, createdAt: tsMs(r.created_at), authoredBy: r.authored_by,
  }));
}
async function pgWriteAreas(list) {
  const rows = (Array.isArray(list) ? list : []).map(areaToRow);
  await inTx(async (c) => {
    await c.query('DELETE FROM areas');
    for (const b of chunks(rows, 200)) {
      if (!b.length) continue;
      const n = 7;
      const sql =
        `INSERT INTO areas (id, nome, coords, area_km2, estacoes, created_at, authored_by)
         VALUES ${placeholders(b, n)}`;
      await c.query(sql, b.flatMap((r) => [r.id, r.nome, r.coords, r.area_km2, r.estacoes, r.created_at, r.authored_by]));
    }
  });
}

/* ---- pg: gestão por município ---- */
async function pgReadGestaoDoc(name) {
  const m = await muns();
  const mun = m.byDoc.get(String(name).replace(/^gestao_/, ''));
  if (!mun) return null;
  const c = await getPool().connect();
  try {
    const [itens, meta] = await Promise.all([
      c.query('SELECT * FROM gestao_itens WHERE municipio_id = $1', [mun.id]),
      c.query('SELECT updated_at FROM gestao_docs WHERE municipio_id = $1', [mun.id]),
    ]);
    const secoes = {};
    for (const r of itens.rows) {
      (secoes[r.secao] = secoes[r.secao] || []).push({
        id: r.id_origem,
        ...(r.dado !== null && r.dado !== undefined ? r.dado : {}),
        ...(r.criado_em ? { criadoEm: r.criado_em.toISOString() } : {}),
        ...(r.criado_por ? { criadoPor: r.criado_por } : {}),
        ...(r.atualizado_em ? { atualizadoEm: r.atualizado_em.toISOString() } : {}),
        ...(r.atualizado_por ? { atualizadoPor: r.atualizado_por } : {}),
      });
    }
    return { nome: mun.nome, updatedAt: meta.rows[0] ? tsMs(meta.rows[0].updated_at) : null, secoes };
  } finally {
    c.release();
  }
}
async function pgWriteGestaoDoc(name, doc) {
  const m = await muns();
  const mun = m.byDoc.get(String(name).replace(/^gestao_/, ''));
  if (!mun) throw new Error('Município de gestão desconhecido: ' + name);
  const SECOES = ['areasDeRisco', 'plancon', 'coordenadores', 'voluntarios', 'inventario',
    'rotasFuga', 'viaturas', 'rastreadorRadio', 'equipeAtual', 'sede', 'alojamento'];
  await inTx(async (c) => {
    await c.query('DELETE FROM gestao_itens WHERE municipio_id = $1', [mun.id]);
    const rows = [];
    for (const sec of SECOES) {
      const lista = Array.isArray(doc.secoes && doc.secoes[sec]) ? doc.secoes[sec] : [];
      for (const item of lista) {
        rows.push([
          mun.id, sec, String(item.id), JSON.stringify(item),
          tsPg(item.criadoEm), item.criadoPor || null,
          tsPg(item.atualizadoEm), item.atualizadoPor || null,
        ]);
      }
    }
    for (const b of chunks(rows, 200)) {
      if (!b.length) continue;
      const n = 8;
      const sql =
        `INSERT INTO gestao_itens (municipio_id, secao, id_origem, dado, criado_em, criado_por, atualizado_em, atualizado_por)
         VALUES ${placeholders(b, n)}`;
      await c.query(sql, b.flat());
    }
    await c.query(
      `INSERT INTO gestao_docs (municipio_id, updated_at)
       VALUES ($1,$2) ON CONFLICT (municipio_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [mun.id, tsPg(doc.updatedAt)]
    );
  });
}
/* Resumo para a visão "geral" (panorama estadual) — 1 doc por município. */
async function pgResumoGestao() {
  const m = await muns();
  const { rows } = await getPool().query(
    `SELECT g.municipio_id, g.secao, count(*) AS n
       FROM gestao_itens g
      GROUP BY g.municipio_id, g.secao`
  );
  const { rows: metas } = await getPool().query('SELECT municipio_id, updated_at FROM gestao_docs');
  const porMun = {};
  for (const r of rows) {
    const e = (porMun[r.municipio_id] = porMun[r.municipio_id] || {});
    e[r.secao] = Number(r.n);
  }
  const metaMap = new Map(metas.map((x) => [x.municipio_id, x.updated_at]));
  const out = [];
  for (const [id, secCounts] of Object.entries(porMun)) {
    const nome = m.byId.get(Number(id));
    if (!nome) continue;
    out.push({ nome, secoes: secCounts, updatedAt: metaMap.get(Number(id)) ? tsMs(metaMap.get(Number(id))) : null });
  }
  return out;
}

/* ---- pg: pluv-alerta (config singleton) ---- */
async function pgReadPluv() {
  const { rows } = await getPool().query('SELECT * FROM pluv_alerta_config WHERE id = 1');
  const r = rows[0];
  if (!r) return [];
  return [{
    id: 'config',
    limiteMm: r.limite_mm, percentual: r.percentual, ativo: r.ativo,
    metrica: 'c24', updatedAt: r.updated_at ? r.updated_at.toISOString() : undefined,
    updatedBy: r.updated_by,
  }];
}
async function pgWritePluv(list) {
  const doc = (Array.isArray(list) ? list : []).find((d) => d && d.id === 'config');
  await getPool().query('DELETE FROM pluv_alerta_config WHERE id = 1');
  if (!doc) return;
  await getPool().query(
    `INSERT INTO pluv_alerta_config (id, limite_mm, percentual, ativo, updated_at, updated_by)
     VALUES (1,$1,$2,$3,$4,$5)`,
    [num(doc.limiteMm), num(doc.percentual), doc.ativo !== false, tsPg(doc.updatedAt), num(doc.updatedBy)]
  );
}

/* ---- dispatcher pg ---- */
async function pgRead(name) {
  if (name === 'users') return pgReadUsers();
  if (name === 'user_registrations') return pgReadUserRegistrations();
  if (name === 'occurrences') return pgReadOccurrences();
  if (name === 'areas') return pgReadAreas();
  if (name.startsWith('gestao_')) { const d = await pgReadGestaoDoc(name); return d || []; }
  if (name === 'pluv-alerta') return pgReadPluv();
  if (name === 'reports') {
    const { rows } = await getPool().query('SELECT * FROM reports ORDER BY created_at DESC');
    return rows.map((r) => ({
      id: r.id, type: r.type, severity: r.severity, location: r.location, description: r.description,
      reporter: r.reporter, lat: r.lat, lng: r.lng, createdAt: tsMs(r.created_at), authoredBy: r.authored_by,
    }));
  }
  if (name === 'audit_logs') {
    const { rows } = await getPool().query('SELECT * FROM audit_logs ORDER BY created_at DESC');
    return rows.map((r) => ({ id: r.id, action: r.action, metadata: r.metadata, createdAt: tsMs(r.created_at) }));
  }
  return [];
}
async function pgWrite(name, value) {
  if (name === 'users') return pgWriteUsers(value);
  if (name === 'user_registrations') {
    const existing = await pgReadUserRegistrations();
    const next = Array.isArray(value) ? value : [];
    for (const item of next) {
      if (!existing.some((entry) => String(entry.id) === String(item.id))) await pgCreateUserRegistration(item);
    }
    return;
  }
  if (name === 'occurrences') return pgWriteOccurrences(value);
  if (name === 'areas') return pgWriteAreas(value);
  if (name.startsWith('gestao_')) return pgWriteGestaoDoc(name, value);
  if (name === 'pluv-alerta') return pgWritePluv(value);
  /* fallback genérico: nada a fazer para coleções sem escrita mapeada */
}
async function pgPush(name, item) {
  if (name === 'reports') return pgPushReport(item);
  if (name === 'audit_logs') {
    await getPool().query(
      'INSERT INTO audit_logs (action, metadata, created_at) VALUES ($1,$2,$3)',
      [item.action, item.metadata && typeof item.metadata === 'object' ? JSON.stringify(item.metadata) : (item.metadata || {}), tsPg(item.createdAt)]
    );
    return item;
  }
  if (name === 'areas') {
    const a = areaToRow(item);
    await getPool().query(
      `INSERT INTO areas (id, nome, coords, area_km2, estacoes, created_at, authored_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [a.id, a.nome, a.coords, a.area_km2, a.estacoes, a.created_at, a.authored_by]
    );
    return item;
  }
  return item;
}

/* ============================================================
   Drivers file / kv / memory (comportamento original)
   ============================================================ */
async function kvGet(name) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(name)}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  if (!res.ok) throw new Error('kv get:' + res.status);
  const j = await res.json();
  return j && j.result && j.result !== null ? j.result : undefined;
}

async function kvSet(name, value) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/set/${encodeURIComponent(name)}/${encodeURIComponent(JSON.stringify(value))}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  if (!res.ok) throw new Error('kv set:' + res.status);
}

const memory = {};

async function readCollection(name) {
  const d = driver();
  if (d === 'pg') return pgRead(name);
  if (d === 'file') {
    const p = filePath(name);
    if (!fs.existsSync(p)) return [];
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`Falha ao ler coleção "${name}": ${e.message}`);
    }
  }
  if (d === 'kv') {
    const value = await kvGet(name);
    return value === undefined ? [] : JSON.parse(value);
  }
  return memory[name] || [];
}

async function writeCollection(name, value) {
  const d = driver();
  if (d === 'pg') return pgWrite(name, value);
  if (d === 'file') {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(filePath(name), JSON.stringify(value, null, 2), 'utf8');
    return;
  }
  if (d === 'kv') {
    await kvSet(name, value);
    return;
  }
  memory[name] = value;
}

async function push(name, item) {
  const d = driver();
  if (d === 'pg') return pgPush(name, item);
  const col = await readCollection(name);
  col.push(item);
  await writeCollection(name, col);
  return item;
}

async function removeById(name, id) {
  const d = driver();
  if (d === 'pg') {
    if (name === 'areas') {
      await getPool().query('DELETE FROM areas WHERE id = $1', [String(id)]);
      return true;
    }
    return false;
  }
  let col = await readCollection(name);
  const before = col.length;
  col = col.filter(x => String(x.id) !== String(id));
  if (col.length !== before) await writeCollection(name, col);
  return col.length !== before;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function createUserRegistration(registration) {
  if (driver() === 'pg') return pgCreateUserRegistration(registration);
  const list = await readCollection('user_registrations');
  list.unshift(registration);
  await writeCollection('user_registrations', list);
  return registration;
}

async function updateUserRegistration(id, changes) {
  if (driver() === 'pg') return pgUpdateUserRegistration(id, changes);
  const registrations = await readCollection('user_registrations');
  const index = registrations.findIndex((item) => String(item.id) === String(id));
  if (index < 0) return null;
  const current = registrations[index];
  if (current.status !== 'Pendente') {
    const error = new Error('Somente solicitações pendentes podem ser analisadas.');
    error.code = 'REGISTRATION_NOT_PENDING';
    throw error;
  }
  const updated = { ...current, ...(changes.dados || {}), ...(changes.nivel ? { nivel: changes.nivel } : {}), status: changes.status,
    parecer: changes.parecer || '', avaliadoEm: Date.now(), avaliadoPor: changes.avaliadoPor || 'admin',
    atualizadoEm: Date.now() };
  updated.historico = (updated.historico || []).concat([{
    data: new Date().toISOString(), autor: changes.avaliadoPor || 'admin',
    acao: changes.status === 'Aprovado' ? 'Cadastro aprovado' : 'Cadastro recusado', detalhe: changes.parecer || '',
  }]);
  if (changes.status === 'Aprovado') {
    const users = await readCollection('users');
    if (users.some((user) => String(user.usuario).toLowerCase() === String(current.usuario).toLowerCase())) {
      const error = new Error('Este usuário já existe.');
      error.code = '23505';
      throw error;
    }
    const perfil = updated.perfil === 'Municipal' ? 'municipal' : (updated.nivel === 'Consulta' ? 'comum' : 'avancado');
    users.push({ id: 'U' + (users.length + 1), usuario: current.usuario, senhaHash: current.senhaHash,
      nome: updated.nome || '', perfil, municipio: updated.perfil === 'Municipal' ? updated.municipio : '',
      ativo: true, cadastroId: current.id, bootstrapAdmin: false, criadoEm: new Date().toISOString() });
    await writeCollection('users', users);
  }
  registrations[index] = updated;
  await writeCollection('user_registrations', registrations);
  return updated;
}

async function editUserRegistration(id, data) {
  if (driver() === 'pg') {
    return inTx(async (client) => {
      const found = await client.query('SELECT * FROM solicitacoes_usuarios WHERE id = $1 FOR UPDATE', [String(id)]);
      if (!found.rows[0]) return null;
      const current = registrationFromRow(found.rows[0]);
      if (current.status !== 'Pendente') {
        const error = new Error('Somente solicitações pendentes podem ser editadas.');
        error.code = 'REGISTRATION_NOT_PENDING';
        throw error;
      }
      const updatedData = { ...current, ...data, usuario: current.usuario };
      updatedData.historico = (updatedData.historico || []).concat([{
        data: new Date().toISOString(), autor: 'Administrador', acao: 'Cadastro editado',
      }]);
      const { rows } = await client.query(
        `UPDATE solicitacoes_usuarios
            SET dados = $2::jsonb, email = $3, cpf = $4, atualizado_em = now()
          WHERE id = $1 RETURNING *`,
        [String(id), JSON.stringify(updatedData), String(updatedData.email).toLowerCase(), String(updatedData.cpf).replace(/\D/g, '')]
      );
      return registrationFromRow(rows[0]);
    });
  }
  const list = await readCollection('user_registrations');
  const index = list.findIndex((item) => String(item.id) === String(id));
  if (index < 0) return null;
  if (list[index].status !== 'Pendente') {
    const error = new Error('Somente solicitações pendentes podem ser editadas.');
    error.code = 'REGISTRATION_NOT_PENDING';
    throw error;
  }
  const now = new Date().toISOString();
  list[index] = { ...list[index], ...data, usuario: list[index].usuario, atualizadoEm: now,
    historico: (list[index].historico || []).concat([{ data: now, autor: 'Administrador', acao: 'Cadastro editado' }]) };
  await writeCollection('user_registrations', list);
  return list[index];
}

async function deleteUserRegistration(id) {
  if (driver() === 'pg') return pgDeleteUserRegistration(id);
  const list = await readCollection('user_registrations');
  const registration = list.find((item) => String(item.id) === String(id));
  if (!registration || registration.status === 'Aprovado') return false;
  await writeCollection('user_registrations', list.filter((item) => String(item.id) !== String(id)));
  return true;
}

module.exports = {
  readCollection,
  writeCollection,
  push,
  removeById,
  createUserRegistration,
  updateUserRegistration,
  editUserRegistration,
  deleteUserRegistration,
  driver,
  resumoGestao: async function () {
    if (driver() === 'pg') return pgResumoGestao();
    return [];
  },
};