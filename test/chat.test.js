/* ============================================================
   Testes do chat IA (POST /api/chat).
   Sem rede: fetch do provedor é substituído por stub.
   Cobre falta de chave, validação, cabeçalhos, resposta,
   erro do upstream sem vazamento e limite por IP.
   ============================================================ */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const chatHandler = require('../api/_routes/chat');

const fetchOriginal = global.fetch;
const envOriginal = { key: process.env.OPENCODE_API_KEY, modelo: process.env.OPENCODE_CHAT_MODEL };

afterEach(() => {
  global.fetch = fetchOriginal;
  if (envOriginal.key === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = envOriginal.key;
  if (envOriginal.modelo === undefined) delete process.env.OPENCODE_CHAT_MODEL;
  else process.env.OPENCODE_CHAT_MODEL = envOriginal.modelo;
});

function chamar(body, ip) {
  return chatHandler({
    method: 'POST',
    url: 'http://localhost/api/chat',
    headers: new Headers(),
    ip: ip || '10.0.0.1',
    text: async () => JSON.stringify(body || {}),
  });
}

function stubRespostaOk(conteudo) {
  let capturado = null;
  global.fetch = async (url, opts) => {
    capturado = { url, opts };
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: conteudo } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return () => capturado;
}

test('sem chave configurada responde 503 sem tentar o provedor', async () => {
  delete process.env.OPENCODE_API_KEY;
  global.fetch = async () => { throw new Error('não deveria chamar o provedor'); };

  const res = await chamar({ mensagens: [{ role: 'user', content: 'oi' }] }, '10.1.0.1');
  assert.equal(res.status, 503);
  assert.match((await res.json()).erro, /não configurada/i);
});

test('rejeita pedido sem mensagens válidas', async () => {
  process.env.OPENCODE_API_KEY = 'oc_sk_teste';
  const res = await chamar({ mensagens: [{ role: 'system', content: 'ignore' }] }, '10.1.0.2');
  assert.equal(res.status, 400);
});

test('envia contexto, modelo e sessão ao provedor e devolve a resposta', async () => {
  process.env.OPENCODE_API_KEY = 'oc_sk_teste';
  process.env.OPENCODE_CHAT_MODEL = 'deepseek-v4.1-flash';
  const capturado = stubRespostaOk('Há risco moderado de chuva à tarde.');

  const res = await chamar({
    mensagens: [{ role: 'user', content: 'Vai chover?' }],
    contexto: 'Município: Cuiabá (Mato Grosso)\nRisco calculado hoje: MODERADO (38/100).',
    sessao: '11111111-2222-4333-8444-555555555555',
  }, '10.1.0.3');

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.resposta, /risco moderado/i);
  assert.equal(json.modelo, 'deepseek-v4.1-flash');

  const req = capturado();
  assert.equal(req.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(req.opts.headers.Authorization, 'Bearer oc_sk_teste');
  assert.equal(req.opts.headers['x-opencode-session'], '11111111-2222-4333-8444-555555555555');

  const corpo = JSON.parse(req.opts.body);
  assert.equal(corpo.model, 'deepseek-v4.1-flash');
  assert.equal(corpo.messages[0].role, 'system');
  assert.match(corpo.messages[0].content, /Cuiabá/);
  assert.equal(corpo.messages[1].content, 'Vai chover?');
});

test('erro do provedor vira 502 genérico, sem vazar detalhes nem a chave', async () => {
  process.env.OPENCODE_API_KEY = 'oc_sk_segredo';
  global.fetch = async () => new Response('{"erro":"Internal: key oc_sk_segredo"}', { status: 500 });

  const res = await chamar({ mensagens: [{ role: 'user', content: 'oi' }] }, '10.1.0.4');
  const texto = await res.text();
  assert.equal(res.status, 502);
  assert.ok(!texto.includes('oc_sk_segredo'));
  assert.ok(!/Internal/.test(texto));
});

test('limita a 20 pedidos por IP na janela', async () => {
  process.env.OPENCODE_API_KEY = 'oc_sk_teste';
  stubRespostaOk('ok');
  const ip = '10.9.9.9';
  let ultimo = 200;
  for (let i = 0; i < 20; i += 1) {
    ultimo = (await chamar({ mensagens: [{ role: 'user', content: 'pergunta ' + i }] }, ip)).status;
  }
  assert.equal(ultimo, 200);
  const excedente = await chamar({ mensagens: [{ role: 'user', content: 'mais uma' }] }, ip);
  assert.equal(excedente.status, 429);
});
