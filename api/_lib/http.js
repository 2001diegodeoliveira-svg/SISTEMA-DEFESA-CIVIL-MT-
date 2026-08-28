/* Helpers compartilhados para servidor local (Express) e Vercel serverless. */

function corsHeaders(origin) {
  const allowed = process.env.CORS_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

/* Resposta JSON padrão com CORS */
function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

/* Lê o corpo da requisição de forma robusta.
   Aceita tanto o Web Request da Vercel (req.text()) quanto o Node
   IncomingMessage (stream de chunks) usado em alguns runtimes. */
async function readBody(req) {
  try {
    if (typeof req.text === 'function') {
      return await req.text();
    }
    if (typeof req.on === 'function') {
      return await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
    }
  } catch {}
  return '';
}

/* body-parser robusto (Web Request ou Node IncomingMessage) */
async function readJson(req) {
  const t = await readBody(req);
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

/* Converte req.url (que pode ser relativo — ex.: "/api/proxy?url=...")
   em um objeto URL seguro. Retorna null se não der para parsear. */
function reqUrl(req) {
  const raw = req && req.url ? req.url : '';
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

/* Extrai bearer token do header Authorization */
function bearerToken(req) {
  const h = req.headers.get && req.headers.get('authorization');
  const raw = h || req.headers.authorization || '';
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = { corsHeaders, jsonResponse, readJson, readBody, reqUrl, bearerToken };
