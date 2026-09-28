/* ============================================================
   Notícias diárias — tempo, ações climáticas e Defesa Civil MT.
   Fonte: Google Notícias (RSS de busca), conteúdo atualizado o dia todo.

   GET /api/noticias             → agrega as buscas padrão (diárias)
   GET /api/noticias?q=termo     → busca própria (use ";" p/ várias)
   GET /api/noticias?n=10        → limite de itens (padrão 6, máx 10)
   ============================================================ */
const { jsonResponse } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const BUSCAS = [
  'defesa civil mato grosso',
  'tempo clima mato grosso',
  'ações climáticas mato grosso',
  'cuiabá tempo chuva',
  'queimadas mato grosso',
  'chuva mato grosso',
];

const RSS_URL = 'https://news.google.com/rss/search?q=%s&hl=pt-BR&gl=BR&ceid=BR:pt-419';
const MAX_IDADE_MS = 1000 * 60 * 60 * 24 * 15; // aceita itens de até 15 dias (rede de segurança)
const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

/* Descarta widgets/agregadores automáticos de webcam (ex.: "Clima ao Vivo em Cuiabá"). */
function ehRuido(titulo) {
  const x = String(titulo || '').toLowerCase();
  return /clima ao vivo|c[âa]mera do tempo|webcam|\bveja agora\b/.test(x) || x.length < 15;
}

/* Mantém só notícias que citam explicitamente Mato Grosso ou cidades do estado. */
function noEscopo(titulo) {
  const x = String(titulo || '').toLowerCase();
  if (/mato grosso do sul|mato-grossense do sul/.test(x)) return false;
  if (/mato grosso\b/.test(x)) return true;
  return /cuiab[aá]|v[aá]rzea grande|rondon[oó]polis|sinop|sorriso|tangar[aá] da serra|c[aá]ceres|barra do gar[çc]as|primavera do leste|lucas do rio verde|alta floresta|confresa|j[uú]ara|pocon[eé]|ros[aá]rio oeste|pontes e lacerda|col[níí]der|nobres|s[aã]o f[eé]lix do araguaia|guarant[aã] do norte|santa carmem|s[ií]ria|nova mutum|\bmt\b/.test(x);
}

/* Remove o sufixo " - <Fonte>" que o Google adiciona ao título. */
function stripFonte(titulo, fonte) {
  const t = String(titulo || '').trim();
  if (fonte) {
    const suf = new RegExp('\\s+-\\s+' + fonte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    return t.replace(suf, '').trim();
  }
  return t;
}

function fmtData(ms) {
  const d = new Date(ms);
  return String(d.getDate()).padStart(2, '0') + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear();
}

function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#0*34;/g, '"')
    .replace(/&#0*38;/g, '&');
}

/* Deriva uma etiqueta curta para o card a partir do título. */
function tagDaTitulo(titulo) {
  const x = String(titulo || '').toLowerCase();
  const regras = [
    [/fogo|queimad|incendi|fuma[çc]a/, 'FOGO E QUEIMADAS'],
    [/chuva|alagamento|inunda[çc][aã]o|enchente|granizo|temporal/, 'CHUVA / TEMPESTADE'],
    [/vento|rajadas?/, 'VENTO FORTE'],
    [/calor|temperatura|onda de calor/, 'ONDA DE CALOR'],
    [/seca|estiagem|umidade baixa|baixa umidade/, 'ESTIAGEM / SECA'],
    [/deslizamento|desabamento|desmoronamento|rompimento/, 'RISCO GEOLÓGICO'],
    [/defesa civil|prote[çc][aã]o e defesa/, 'DEFESA CIVIL'],
    [/clim[aá]tic|sustentabilidade|mitiga[çc][aã]o|carbono/, 'AÇÃO CLIMÁTICA'],
    [/previs[aã]o|clima|meteorol/, 'TEMPO / CLIMA'],
  ];
  for (const [re, tag] of regras) if (re.test(x)) return tag;
  return 'COMUNICADO';
}

function parseItens(xml) {
  const out = [];
  const reItem = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = reItem.exec(xml)) !== null) {
    const bloco = m[1];
    const t = /<title>([\s\S]*?)<\/title>/.exec(bloco);
    const l = /<link[^>]*>([\s\S]*?)<\/link>/.exec(bloco);
    const d = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(bloco);
    const s = /<source[^>]*>([\s\S]*?)<\/source>/.exec(bloco);
    if (!t || !l) continue;
    const fonte = s ? decodeXml(s[1]).trim() : 'Agência de notícias';
    const titulo = stripFonte(decodeXml(t[1]), fonte);
    if (!titulo) continue;
    out.push({
      titulo,
      link: decodeXml(l[1]).trim(),
      pubMs: d ? Math.max(0, Date.parse(decodeXml(d[1]))) : Date.now(),
      fonte,
    });
  }
  return out;
}

async function buscar(q) {
  const url = RSS_URL.replace('%s', encodeURIComponent(q));
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DefesaCivilMT/1.0; +https://sistema-defesa-civil-mt.vercel.app)' },
  });
  if (!r.ok) throw new Error('http ' + r.status);
  return parseItens(await r.text());
}

module.exports = serve(async function handler(req) {
  const origin = req.headers && req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não permitido.' }, origin);

  let url = null;
  try { url = new URL(req.url, 'http://localhost'); } catch { /* mantém null */ }
  const qs = url ? url.searchParams : null;
  const buscas = (
    (qs && qs.get('q')) ? qs.get('q').split(';').map(x => x.trim()).filter(Boolean) : BUSCAS
  );
  const limite = Math.min(parseInt((qs && qs.get('n')) || '6', 10) || 6, 10);

  const agora = Date.now();
  let itens = [];
  const resultados = await Promise.all(buscas.map(q => buscar(q).catch(() => [])));
  resultados.forEach(list => { itens = itens.concat(list); });

  // Remove itens fora do escopo (outros estados) e duplicatas; ordena do mais recente.
  const vistos = new Set();
  itens = itens
    .filter(i => agora - i.pubMs <= MAX_IDADE_MS)
    .filter(i => noEscopo(i.titulo))
    .filter(i => !ehRuido(i.titulo))
    .filter(i => {
      const chave = i.titulo.toLowerCase().replace(/\s+/g, ' ').trim();
      if (vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    })
    .sort((a, b) => b.pubMs - a.pubMs)
    .slice(0, limite)
    .map(i => ({
      titulo: i.titulo,
      link: i.link,
      fonte: i.fonte,
      data: fmtData(i.pubMs),
      tag: tagDaTitulo(i.titulo),
    }));

  const res = jsonResponse(200, {
    ok: true,
    geradosEm: agora,
    fonte: 'Google Notícias — busca recente por clima, ações climáticas e Defesa Civil em Mato Grosso',
    noticias: itens,
  }, origin);
  // Permite cache curto no CDN/navegador (feed é atualizado continuamente).
  res.headers.set('Cache-Control', 'public, max-age=600, s-maxage=600');
  return res;
});