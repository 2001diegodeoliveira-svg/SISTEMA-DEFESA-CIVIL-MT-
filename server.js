/* ============================================================
   Servidor Express standalone (desenvolvimento / servidor próprio).
   Monta os mesmos handlers das serverless functions da Vercel.
   Roda com:  npm install && npm start
   Default: http://localhost:3000  (mude via PORT)
   Persistência: arquivos JSON em ./data  (FILE_STORE=0 p/ memória)
   ============================================================ */
const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const cors = require('cors');
app.use(cors({ origin: true, credentials: true }));
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
      res.status(500).json({ erro: 'Erro interno: ' + e.message });
    }
  };
}

/* Todas as rotas /api/* → roteador único (igual ao deploy na Vercel). */
app.all('/api/*', wrap(apiRouter));

// Job de sincronização Waze/TomTom (mock por padrão) — só roda no server.js
// standalone (processo Node persistente); em serverless (Vercel) use
// um agendador externo chamando POST /api/waze?action=sync e
// POST /api/tomtom?action=sync.
require('./api/_lib/waze').startJob();
require('./api/_lib/tomtom').startJob();

/* Serve os estáticos do frontend (mesmo diretório) para testes locais */
app.use(express.static(path.join(__dirname)));

// Fallback: páginas .html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const f = path.join(__dirname, req.path === '/' ? 'index.html' : req.path);
  res.sendFile(f, err => { if (err) next(); });
});

app.listen(PORT, () => {
  console.log(`\nDefesa Civil MT — backend rodando em http://localhost:${PORT}`);
  console.log('Endpoints: /api/auth/login, /api/alertas, /api/reports, /api/areas\n');
});
