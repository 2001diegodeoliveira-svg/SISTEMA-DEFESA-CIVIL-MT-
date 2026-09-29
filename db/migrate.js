/* ============================================================
   Migração JSON → PostgreSQL (Neon).
   Lê os arquivos da pasta ./data (formato antigo do store.js) e
   popula o banco criado por db/schema.sql. Idempotente.

   Uso:
     DATABASE_URL=... node db/migrate.js
     node db/migrate.js --schema-only   # só aplica o DDL + seed de municípios

   Dependência: pg (npm install). Node >= 18.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { MUNICIPIOS_MT } = require('../api/_lib/municipios');

const DIR_DADOS = path.join(__dirname, '..', 'data');
const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const APENAS_SCHEMA = process.argv.includes('--schema-only');

/* ---------- helpers ---------- */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const linha of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function arquivoJson(nome) {
  return path.join(DIR_DADOS, nome.replace(/[^a-z0-9_\-]/gi, '') + '.json');
}

function lerColecao(nome, opcionais = false) {
  const p = arquivoJson(nome);
  if (!fs.existsSync(p)) {
    if (opcionais) { console.log(`  [skip] ${nome} — arquivo não existe`); return null; }
    throw new Error('Coleção obrigatória ausente: ' + p);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('JSON inválido em ' + p + ': ' + e.message); }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* Placeholders progressivos para insert em lote: cada linha usa índices
   únicos ($1..$22, $23..$44, ...). NUNCA repetir a mesma faixa por linha. */
function placeholders(rows, nCols) {
  return rows.map((_, i) =>
    `(${Array.from({ length: nCols }, (_, j) => '$' + (i * nCols + j + 1)).join(',')})`
  ).join(',');
}

function dtMs(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  return v ? String(v) : null;
}

/* ---------- enums (defesa contra dados antigos) ---------- */
const TIPOS = ['ACIDENTE', 'ENGARRAFAMENTO', 'PERIGO', 'CLIMA', 'INTERDICAO', 'OBRA', 'OUTROS'];
const STATUS = ['NOVA', 'EM_ANALISE', 'EM_ATENDIMENTO', 'ENCAMINHADA', 'RESOLVIDA', 'ENCERRADA'];
const PRIORIDADES = ['BAIXA', 'MEDIA', 'ALTA', 'CRITICA'];

function enumOk(v, lista, fallback) {
  const s = String(v || '').toUpperCase();
  return lista.includes(s) ? s : fallback;
}

/* Perfil fica em minúsculas: enumOk(normalizar mayúscula) NÃO serve aqui. */
function perfilOk(v) {
  const s = String(v || '').toLowerCase();
  return ['admin', 'avancado', 'municipal', 'comum'].includes(s) ? s : 'comum';
}

/* ---------- conexão ---------- */
loadDotEnv();
const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Defina DATABASE_URL (variável de ambiente ou no arquivo .env).');
  console.error('Obtida no Painel do projeto Neon → Connect → string de conexão.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const cli = await pool.connect();
  try {
    console.log('Aplicando schema...');
    await cli.query(SCHEMA);
    console.log('  schema OK');

    /* --- seed municípios --- */
    console.log('Seedando municípios...');
    for (const chunkM of chunk(MUNICIPIOS_MT, 50)) {
      const ph = chunkM.map((_, i) => `($${i + 1})`).join(',');
      await cli.query(`INSERT INTO municipios (nome) VALUES ${ph} ON CONFLICT (nome) DO NOTHING`, chunkM);
    }
    const { rows: muns } = await cli.query('SELECT id, nome, lower(nome) AS nome_lower FROM municipios');
    const munById = new Map(muns.map(m => [m.id, m.nome]));
    const munPorNorm = new Map(muns.map(m => [norm(m.nome), m.id]));
    console.log(`  ${muns.length} municípios`);

    if (APENAS_SCHEMA) {
      console.log('--schema-only: encerrando antes da migração de dados.');
      return;
    }

    /* --- usuários --- */
    console.log('Migrando usuarios...');
    const users = lerColecao('users');
    const userMap = new Map();
    for (const u of users) {
      const munId = u.municipio ? (munPorNorm.get(norm(u.municipio)) || null) : null;
      const res = await cli.query(
        `INSERT INTO usuarios (usuario, senha_hash, nome, perfil, municipio_id, criado_em)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()))
         ON CONFLICT (usuario) DO UPDATE
           SET senha_hash = EXCLUDED.senha_hash,
               nome = EXCLUDED.nome,
               perfil = EXCLUDED.perfil,
               municipio_id = EXCLUDED.municipio_id
         RETURNING id`,
        [u.usuario, u.senhaHash, u.nome || '', perfilOk(u.perfil), munId, dtMsNullable(u.criadoEm)]
      );
      userMap.set(String(u.id), res.rows[0].id);
    }
    console.log(`  ${users.length} usuários`);

    /* --- ocorrências (Waze) --- */
    console.log('Migrando occurrences...');
    const occs = lerColecao('occurrences');
    let occAlteradas = 0;
    for (const b of chunk(occs, 500)) {
      const ph = placeholders(b, 22);
      const vals = [];
      for (const o of b) {
        const tipo = enumOk(o.type, TIPOS, 'OUTROS');
        const status = enumOk(o.status, STATUS, 'NOVA');
        const prioridade = o.priority ? enumOk(o.priority, PRIORIDADES, 'BAIXA') : null;
        if (tipo !== o.type || status !== o.status || (o.priority && prioridade !== o.priority)) occAlteradas++;
        vals.push(
          String(o.id), o.externalId, o.source || 'WAZE', tipo, o.subtype || null,
          o.description || '', numZero(o.latitude), numZero(o.longitude),
          o.street || null, o.city || null, o.state || null, o.country || null,
          o.direction || null, numNull(o.magnitude), numNull(o.reliability),
          numNull(o.confidence), dtMs(o.reportedAt), dtMs(o.receivedAt),
          dtMs(o.updatedAt), status, prioridade,
          o.rawData && typeof o.rawData === 'object' ? JSON.stringify(o.rawData) : (o.rawData || null)
        );
      }
      await cli.query(
        `INSERT INTO occurrences (id, external_id, source, type, subtype, description, latitude, longitude,
          street, city, state, country, direction, magnitude, reliability, confidence,
          reported_at, received_at, updated_at, status, priority, raw_data)
         VALUES ${ph}
         ON CONFLICT (source, external_id) DO UPDATE SET
           description = EXCLUDED.description, latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude, city = EXCLUDED.city, state = EXCLUDED.state,
           country = EXCLUDED.country, direction = EXCLUDED.direction,
           magnitude = EXCLUDED.magnitude, reliability = EXCLUDED.reliability,
           confidence = EXCLUDED.confidence, reported_at = EXCLUDED.reported_at,
           updated_at = EXCLUDED.updated_at, status = EXCLUDED.status,
           priority = EXCLUDED.priority, raw_data = EXCLUDED.raw_data`,
        vals
      );
    }
    console.log(`  ${occs.length} ocorrências${occAlteradas ? ' (' + occAlteradas + ' valores normalizados para enums)' : ''}`);

    /* --- reports --- */
    console.log('Migrando reports...');
    const reports = lerColecao('reports', true);
    if (reports && reports.length) {
      let n = 0;
      for (const r of reports) {
        await cli.query(
          `INSERT INTO reports (id, type, severity, location, description, reporter, lat, lng, created_at, authored_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::integer)
           ON CONFLICT (id) DO NOTHING`,
          [String(r.id), r.type, r.severity || 'info', r.location, r.description,
            r.reporter || 'Anônimo', r.lat, r.lng, dtMs(r.createdAt), userMap.get(String(r.authoredBy)) || null]
        );
        n++;
      }
      console.log(`  ${n} reports`);
    }

    /* --- áreas --- */
    console.log('Migrando areas...');
    const areas = lerColecao('areas', true);
    if (areas && areas.length) {
      let n = 0;
      for (const a of areas) {
        await cli.query(
          `INSERT INTO areas (id, nome, coords, area_km2, estacoes, created_at, authored_by)
           VALUES ($1,$2,$3::jsonb,$4::numeric,$5,$6::timestamptz,$7::integer)
           ON CONFLICT (id) DO NOTHING`,
          [String(a.id), a.nome, JSON.stringify(a.coords), a.areaKm2, Number(a.estacoes) || 0,
            dtMs(a.createdAt), userMap.get(String(a.authoredBy)) || null]
        );
        n++;
      }
      console.log(`  ${n} áreas`);
    }

    /* --- gestão por município (gestao_*.json) --- */
    console.log('Migrando gestao_itens...');
    const SECOES = ['areasDeRisco', 'plancon', 'coordenadores', 'voluntarios', 'inventario',
      'rotasFuga', 'viaturas', 'rastreadorRadio', 'equipeAtual', 'sede', 'alojamento'];
    let gi = 0, docs = 0;
    const docList = [];
    for (const f of fs.readdirSync(DIR_DADOS).filter(f => /^gestao_[a-z0-9_]+\.json$/i.test(f))) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(DIR_DADOS, f), 'utf8')); }
      catch { continue; }
      const munId = munPorNorm.get(norm(doc.nome));
      if (!munId) { console.log(`  [aviso] município desconhecido em ${f}: "${doc.nome}"`); continue; }
      docs++;
      docList.push({ munId, nome: doc.nome, updatedAt: doc.updatedAt });
      for (const sec of SECOES) {
        const lista = Array.isArray(doc.secoes && doc.secoes[sec]) ? doc.secoes[sec] : [];
        for (const item of lista) {
          await cli.query(
            `INSERT INTO gestao_itens (municipio_id, secao, id_origem, dado, criado_em, criado_por, atualizado_em, atualizado_por)
             VALUES ($1,$2::secao_gestao,$3,$4::jsonb,$5::timestamptz,$6,$7::timestamptz,$8)
             ON CONFLICT (municipio_id, secao, id_origem) DO UPDATE SET
               dado = EXCLUDED.dado, atualizado_em = EXCLUDED.atualizado_em, atualizado_por = EXCLUDED.atualizado_por`,
            [munId, sec, String(item.id), JSON.stringify(item),
              dtMs(item.criadoEm), item.criadoPor || null,
              dtMs(item.atualizadoEm), item.atualizadoPor || null]
          );
          gi++;
        }
      }
    }
    for (const d of docList) {
      await cli.query(
        `INSERT INTO gestao_docs (municipio_id, updated_at)
         VALUES ($1,$2::timestamptz)
         ON CONFLICT (municipio_id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [d.munId, dtMs(d.updatedAt)]
      );
    }
    console.log(`  ${docs} documentos, ${gi} itens de gestão`);

    /* --- pluv-alerta (config singleton) --- */
    console.log('Migrando pluv_alerta_config...');
    const pa = lerColecao('pluv-alerta', true);
    if (pa && pa.length) {
      const c = pa.find(d => d && d.id === 'config');
      if (c) {
        await cli.query(
          `INSERT INTO pluv_alerta_config (id, limite_mm, percentual, ativo, updated_at, updated_by)
           VALUES (1,$1,$2,$3,$4::timestamptz,$5::integer)
           ON CONFLICT (id) DO UPDATE SET
             limite_mm = EXCLUDED.limite_mm, percentual = EXCLUDED.percentual,
             ativo = EXCLUDED.ativo, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [c.limiteMm ?? 100, c.percentual ?? 30, c.ativo !== false, dtMs(c.updatedAt),
            userMap.get(String(c.updatedBy)) || null]
        );
        console.log('  config salva');
      }
    } else {
      console.log('  [skip] sem override — padrão do servidor');
    }

    /* --- audit_logs (opcional) --- */
    console.log('Migrando audit_logs...');
    const logs = lerColecao('audit_logs', true);
    let ln = 0;
    if (logs && logs.length) {
      const ja = await cli.query('SELECT count(*) AS n FROM audit_logs');
      if (Number(ja.rows[0].n) > 0) {
        console.log('  [skip] audit_logs já possui registros');
      } else {
        for (const b of chunk(logs, 500)) {
          const ph = placeholders(b, 3);
          const vals = [];
        for (const l of b) {
          vals.push(l.action, l.metadata && typeof l.metadata === 'object' ? JSON.stringify(l.metadata) : (l.metadata || {}), dtMs(l.createdAt));
        }
        await cli.query(
          `INSERT INTO audit_logs (action, metadata, created_at) VALUES ${ph}`,
          vals.flat()
        );
        ln += b.length;
      }
      console.log(`  ${ln} registros`);
    }
  } else {
      console.log('  [skip] sem logs');
    }

    console.log('\nMigração concluída. Municípios: ' + munById.size);
  } finally {
    cli.release();
    await pool.end();
  }
}

function numZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function dtMsNullable(v) {
  if (v === null || v === undefined || v === '') return null;
  return dtMs(v);
}

main().catch((e) => {
  console.error('\nErro na migração:', e.message);
  process.exit(1);
});