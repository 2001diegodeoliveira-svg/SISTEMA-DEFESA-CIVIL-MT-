process.env.NODE_ENV = 'test';
const handler = require('./api/_routes/inmet-chuva');
(async () => {
  const t0 = Date.now();
  const req = new Request('http://localhost/api/inmet-chuva?ano=2026&uf=MT&refresh=1', { method: 'GET' });
  const res = await handler(req);
  console.log('status:', res.status, 'tempo:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const j = await res.json();
  const cods = j.estacoes.map((e) => String(e.codigo).replace(/;$/, ''));
  console.log('total:', j.totalEstacoes, '| unicos:', new Set(cods).size, '| primeira:', cods[0], j.estacoes[0] && j.estacoes[0].chuva24h);
})().catch((e) => console.error('THREW', e.message));
