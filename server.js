/* ============================================================
   Servidor Express standalone (desenvolvimento / servidor próprio).
   Monta os mesmos handlers das serverless functions da Vercel.
   Roda com:  npm install && npm start
   Default: http://localhost:3000  (mude via PORT)
   Persistência: arquivos JSON em ./data  (FILE_STORE=0 p/ memória)
   ============================================================ */
const path = require('path');
const express = require('express');

/* Carrega variáveis do arquivo .env local (se existir) antes de inicializar
   o store — permite rodar local com PostgreSQL apenas criando o .env. */
(function loadDotEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!require('fs').existsSync(p)) return;
    for (const linha of require('fs').readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* .env ausente — usa variáveis do ambiente */ }
})();

const app = express();
const PORT = process.env.PORT || 3000;

const cors = require('cors');

/* O CORS do Express NÃO pode refletir qualquer origem: isso ignoraria a
   allowlist de CORS_ORIGIN aplicada pela API e permitiria que um site
   malicioso chamasse as rotas autenticadas no navegador do usuário.
   Reutilizamos exatamente a mesma lista配置 da camada de API. */
function origensPermitidas() {
  const producao = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  return (process.env.CORS_ORIGIN || (producao ? '' : '*'))
    .split(',').map((item) => item.trim()).filter(Boolean);
}

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    const permitidas = origensPermitidas();
    // Sem header Origin (navegação, curl, mesmo servidor) => não é CORS.
    if (!origin) return callback(null, false);
    if (permitidas.includes('*')) return callback(null, true);
    return callback(null, permitidas.includes(origin));
  },
}));
app.use(express.json({ limit: '1mb' }));

const apiRouter = require('./api/index');

/* Empacota handler de serverless (fetch Request/Response) para Express */
function wrap(fn) {
  return async function (req, res) {
    const proto = req.secure ? 'https' : (req.headers['x-forwarded-proto'] || 'http');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
    let absUrl;
    try {
      absUrl = new URL(req.originalUrl || req.url, proto + '://' + host).href;
    } catch {
      absUrl = proto + '://' + host + (req.originalUrl || req.url);
    }
    const nreq = {
      method: req.method,
      url: absUrl,
      headers: {
        get: name => req.get(name),
        authorization: req.get('authorization'),
      },
      on: undefined,
      text: async () => JSON.stringify(req.body || {}),
    };
    try {
      const nres = await fn(nreq);
      if (!nres) return res.status(404).json({ erro: 'Rota não encontrada.' });
      if (typeof nres.headers?.entries === 'function') {
        for (const [k, v] of nres.headers.entries()) res.setHeader(k, v);
      }
      const body = await nres.text();
      res.status(nres.status).send(body === '' ? null : body);
    } catch (e) {
      console.error('[http] erro interno:', e);
      res.status(500).json({ erro: 'Erro interno.' });
    }
  };
}

/* Todas as rotas /api/* → roteador único (igual ao deploy na Vercel). */
app.all('/api/*', wrap(apiRouter));

// Job de sincronização Waze/TomTom — só roda no server.js
// standalone (processo Node persistente); em serverless (Vercel) use
// um agendador externo chamando POST /api/waze?action=sync e
// POST /api/tomtom?action=sync.
require('./api/_lib/waze').startJob();
require('./api/_lib/tomtom').startJob();

/* Nunca servir dados sensíveis nem o código do backend pela web.
   Expor a porta 3000 na internet sem esta barreira vaza .env, hashes de
   senha em ./data, o schema do banco e o próprio source do servidor.

   A regra é de lista PERMITIDA (allowlist), não de bloqueio: assim, qualquer
   arquivo novo colocado na raiz por engano continua privado por padrão. */
const ARQUIVOS_RAIZ_BLOQUEADOS = new Set([
  '.env', '.env.local', '.env.producao', '.env.producao.local', '.env.production', '.env.example',
  'vercel.json', 'ecosystem.config.js', 'skills-lock.json',
]);

/* Extensões publicáveis dentro de pastas de conteúdo (css/, js/, imagens/...). */
const EXTENSOES_PUBLICAS = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.map', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.pdf', '.txt',
]);

/* Na raiz do projeto só páginas e imagens ficam públicas — nada de script. */
const EXTENSOES_RAIZ_PERMITIDAS = new Set([
  '.html', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.webmanifest', '.woff', '.woff2', '.ttf', '.otf', '.pdf',
]);

/* Pastas internas: contêm código, dados, dependências ou configuração. */
const PASTAS_INTERNAS = new Set([
  'api', 'bankend', 'data', 'db', 'node_modules', 'test', 'tests', 'logs',
  'scripts', 'src', 'coverage', 'public', 'private', '.git', '.vercel', '.agents',
  '.opencode', '.vscode', '.idea',
]);

app.use((req, res, next) => {
  const caminho = decodeURIComponent((req.path || '').split('?')[0]);
  const segmentos = caminho.split('/').filter(Boolean);
  if (!segmentos.length) return next();

  const base = segmentos[segmentos.length - 1];
  const ext = path.extname(base).toLowerCase();
  const naRaiz = segmentos.length === 1;

  // Arquivos ocultos (.env, .gitignore, .vercel.json) nunca são públicos.
  if (segmentos.some((s) => s.startsWith('.'))) {
    return res.status(404).json({ erro: 'Não encontrado.' });
  }
  if (naRaiz && ARQUIVOS_RAIZ_BLOQUEADOS.has(base)) {
    return res.status(404).json({ erro: 'Não encontrado.' });
  }
  // Pastas internas (dados, banco, backend, dependências) nunca são públicas.
  if (PASTAS_INTERNAS.has(segmentos[0].toLowerCase())) {
    return res.status(404).json({ erro: 'Não encontrado.' });
  }
  // Allowlist de extensões: .js só é público dentro de pastas de conteúdo.
  const permitidas = naRaiz ? EXTENSOES_RAIZ_PERMITIDAS : EXTENSOES_PUBLICAS;
  if (!permitidas.has(ext)) {
    return res.status(404).json({ erro: 'Não encontrado.' });
  }
  return next();
});

/* Serve os estáticos do frontend (mesmo diretório) para testes locais */
app.use(express.static(path.join(__dirname)));

// Fallback: páginas .html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const f = path.join(__dirname, req.path === '/' ? 'index.html' : req.path);
  res.sendFile(f, err => { if (err) next(); });
});

app.listen(PORT, () => {
  console.log(`\nSGI PROTEGE MT — backend rodando em http://localhost:${PORT}`);
  console.log('Endpoints: /api/auth/login, /api/alertas, /api/reports, /api/areas\n');
});
