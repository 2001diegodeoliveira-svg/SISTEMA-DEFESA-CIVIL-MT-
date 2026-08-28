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

/* body-parser para Vercel (fetch Request) */
async function readJson(req) {
  try {
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
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

module.exports = { corsHeaders, jsonResponse, readJson, bearerToken };
