/* ============================================================
   Adaptador universal para as funções serverless.
   Um handler puro recebe (req) e retorna um Web Response.
   Na Vercel (Node runtime clássico) a função é chamada como
   (req, res) e a resposta DEVE ser enviada via res — retornar
   um Response sem usar res deixa a conexão aberta e causa TIMEOUT.
   Este wrapper cobre os dois modos:
     - Se receber res (ServerResponse)  → encaminha o Response pelo res.
     - Caso contrário (server.js / web) → apenas devolve o Response.
   ============================================================ */
const { readBody } = require('./http');

function serve(handler) {
  return async function (req, res) {
    // Garante corpo legível para runtime Node que não tem req.text
    if (
      req &&
      typeof req.text !== 'function' &&
      typeof req.on === 'function' &&
      !req._bodyConsumed &&
      (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')
    ) {
      req._bodyText = await readBody(req);
      req._bodyConsumed = true;
      req.text = async () => req._bodyText;
      req.json = async () => {
        try { return req._bodyText ? JSON.parse(req._bodyText) : {}; } catch { return {}; }
      };
    }

    const response = await handler(req);

    if (res && typeof res.writeHead === 'function' && typeof res.end === 'function') {
      const body = await response.text();
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(body === '' ? undefined : body);
      return;
    }
    return response;
  };
}

module.exports = { serve };
