/* ============================================================
   Testes do feed de notícias (GET /api/noticias).
   Sem rede: o fetch do Google Notícias é substituído por um stub.
   Cobre filtro de escopo (MT), descarte de ruído/antigo, etiqueta
   de defesa civil e cache (normal x fresco=1).
   ============================================================ */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const noticiasHandler = require('../api/_routes/noticias');

const fetchOriginal = global.fetch;

afterEach(() => {
  global.fetch = fetchOriginal;
});

function rss(itens) {
  return '<?xml version="1.0" encoding="UTF-8"?><rss><channel>' +
    itens.map((i) => {
      const pub = i.pubDate instanceof Date ? i.pubDate.toUTCString() : i.pubDate;
      return '<item><title>' + i.titulo + '</title>' +
        '<link>https://news.google.com/rss/articles/' + encodeURIComponent(i.titulo) + '</link>' +
        '<pubDate>' + pub + '</pubDate>' +
        '<source>' + (i.fonte || 'Fonte Teste') + '</source></item>';
    }).join('') +
    '</channel></rss>';
}

function stubFetch(xml) {
  global.fetch = async () => new Response(xml, { status: 200 });
}

function chamar(query) {
  return noticiasHandler({
    method: 'GET',
    url: 'http://localhost/api/noticias' + (query || ''),
    headers: new Headers(),
  });
}

const AGORA = new Date();

test('mantém só notícias de MT, descarta ruído e etiqueta defesa civil', async () => {
  stubFetch(rss([
    { titulo: 'Defesa Civil de MT envia ajuda a municípios após chuvas', pubDate: AGORA, fonte: 'G1' },
    { titulo: 'Defesa Civil do Mato Grosso do Sul alerta para temporal', pubDate: AGORA },
    { titulo: 'Clima ao vivo em Cuiabá', pubDate: AGORA },
    { titulo: 'Chuva forte atinge Cuiabá e Várzea Grande nesta sexta', pubDate: AGORA },
  ]));

  const res = await chamar('?n=6');
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.ok, true);
  assert.equal(json.noticias.length, 2);
  const titulos = json.noticias.map((n) => n.titulo).join(' | ');
  assert.ok(!/Mato Grosso do Sul/.test(titulos), 'não deve trazer notícias de MS');
  assert.ok(!/Clima ao vivo/.test(titulos), 'não deve trazer widgets de webcam');

  const defesa = json.noticias.find((n) => /Defesa Civil de MT/.test(n.titulo));
  assert.equal(defesa.tag, 'DEFESA CIVIL');
  assert.ok(json.noticias[0].data, 'item precisa vir com data formatada');
});

test('descarta itens mais antigos que 15 dias', async () => {
  const antigo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  stubFetch(rss([
    { titulo: 'Notícia velha sobre chuva em Cuiabá', pubDate: antigo },
  ]));

  const json = await (await chamar('?n=6')).json();
  assert.equal(json.noticias.length, 0);
});

test('cache curto por padrão e no-store com fresco=1', async () => {
  stubFetch(rss([
    { titulo: 'Defesa Civil de MT atualiza alerta de chuva em Cuiabá', pubDate: AGORA },
  ]));

  const normal = await chamar('?n=6');
  assert.match(normal.headers.get('cache-control'), /s-maxage=300/);

  const fresco = await chamar('?n=6&fresco=1');
  assert.match(fresco.headers.get('cache-control'), /no-store/);
});

test('nunca falha a rota quando o upstream cai', async () => {
  global.fetch = async () => { throw new Error('rede indisponível'); };

  const res = await chamar('?n=6');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.deepEqual(json.noticias, []);
});
