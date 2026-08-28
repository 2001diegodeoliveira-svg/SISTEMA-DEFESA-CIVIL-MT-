/* ============================================================
   Camada de persistência da Defesa Civil MT.
   Drivers:
     - 'file'  : arquivos JSON em ./data (uso local/servidor próprio)
     - 'kv'    : Vercel KV (Upstash) quando KV_REST_API_URL definido
     - 'memory': fallback em memória (Vercel sem KV configurado)
   ============================================================ */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

function driver() {
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
  if (d === 'file') {
    const p = filePath(name);
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
    return [];
  }
  if (d === 'kv') {
    try {
      const v = await kvGet(name);
      if (v !== undefined) return JSON.parse(v);
    } catch {}
    return [];
  }
  return memory[name] || [];
}

async function writeCollection(name, value) {
  const d = driver();
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
  const col = await readCollection(name);
  col.push(item);
  await writeCollection(name, col);
  return item;
}

async function removeById(name, id) {
  let col = await readCollection(name);
  const before = col.length;
  col = col.filter(x => String(x.id) !== String(id));
  if (col.length !== before) await writeCollection(name, col);
  return col.length !== before;
}

module.exports = { readCollection, writeCollection, push, removeById, driver };
