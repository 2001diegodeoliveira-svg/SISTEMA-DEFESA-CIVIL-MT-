/* ============================================================
   Regressão: o mapa não pode exibir dados demonstrativos.
   - Sem lista fixa de estações (ESTACOES_DC) no front.
   - Sem cadastro estático de abrigos (js/abrigos_mt.json).
   - Sem número fixo de barragens no HTML inicial.
   - Contagem de estações em áreas usa INMET + ANA (APIs reais).
   ============================================================ */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const ler = (p) => fs.readFileSync(path.join(RAIZ, p), 'utf8');

test('js/data.js não define lista fixa de estações (ESTACOES_DC)', () => {
  const src = ler('js/data.js');
  assert.equal(src.includes('ESTACOES_DC'), false);
  assert.equal(src.includes('52 mm/24h'), false);
  assert.equal(src.includes('120 vagas'), false);
});

test('mapa-areas conta estações pelas APIs oficiais (INMET + ANA)', () => {
  const src = ler('js/mapa-areas.js');
  assert.equal(src.includes('dcStations'), false);
  assert.match(src, /inmet-chuva/);
  assert.match(src, /ana-hidrologia/);
});

test('mapa não carrega cadastro estático de abrigos', () => {
  const src = ler('js/mapa-locais.js');
  assert.equal(src.includes('abrigos_mt.json'), false);
  assert.match(src, /sem cadastro oficial/);
  assert.equal(fs.existsSync(path.join(RAIZ, 'js/abrigos_mt.json')), false);
});

test('mapa.html não exibe total fixo de barragens no HTML inicial', () => {
  const src = ler('mapa.html');
  assert.equal(src.includes('1.274 em MT'), false);
});
