/* GET /api/alertas → { alertas:[...], atualizadoEm }  (curados + avisos INMET ao vivo)
   Avisos INMET: feed oficial nacional — sem recorte por UF. */
const { jsonResponse, reqUrl } = require('../_lib/http');
const { ALERTAS_SEED } = require('../_lib/seed');
const { serve } = require('../_lib/serverless');

// O feed do INMET é nacional e pode listar áreas de vários estados no mesmo
// aviso; preserva o texto integral das áreas afetadas.
function limparAreas(areaStr) {
  return String(areaStr || '').replace(/^Aviso para as Áreas:\s*/i, '').trim();
}

function campoTabela(html, rotulo) {
  const re = new RegExp('<th[^>]*>' + rotulo + '</th>[\\s\\S]*?<td>([\\s\\S]*?)</td>', 'i');
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/\s+/g, ' ').trim() : '';
}

/* Normaliza datas de alertas curados para datas atuais (relativas a hoje). */
function datasAtuais(al, idx) {
  const origEmit = al.emitidoEm ? new Date(al.emitidoEm).getTime() : NaN;
  const origVal = al.validoAte ? new Date(al.validoAte).getTime() : NaN;
  let duracaoDias = 1;
  if (!isNaN(origEmit) && !isNaN(origVal)) {
    duracaoDias = Math.max(1, Math.round((origVal - origEmit) / 86400000));
  }
  let emit = new Date(Date.now() - (idx % 4) * 86400000);
  if (!isNaN(origEmit)) emit = new Date(Math.max(Date.now() - (idx % 4) * 86400000, origEmit));
  let validade = new Date(emit.getTime() + duracaoDias * 86400000 + 12 * 3600000);
  emit.setHours(6 + (idx % 2) * 4, 0, 0, 0);
  // Garante que a validade nunca fique no passado (defesa contra reordenação do seed).
  if (validade.getTime() <= Date.now()) validade = new Date(Date.now() + 6 * 3600000);
  const fmt = d => d.toISOString().slice(0, 16);
  return { emitidoEm: fmt(emit), validoAte: fmt(validade) };
}

async function fetchInmetAvisos() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch('https://apiprevmet3.inmet.gov.br/avisos/rss', { signal: controller.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const avisos = [];
    for (const item of items) {
      const dm = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
      if (!dm) continue;
      const html = dm[1];
      const area = campoTabela(html, 'Área');
      const fim = campoTabela(html, 'Fim');
      const fimD = new Date(String(fim).replace(' ', 'T'));
      if (isNaN(fimD) || fimD.getTime() < Date.now()) continue;
      avisos.push({
        id: 'INMET-' + ((item.match(/<guid>([^<]+)<\/guid>/) || [])[1] || Math.random().toString(36).slice(2, 8)),
        fonte: 'inmet',
        evento: campoTabela(html, 'Evento'),
        severidade: campoTabela(html, 'Severidade'),
        descricao: campoTabela(html, 'Descrição'),
        inicio: String(campoTabela(html, 'Início')).replace(' ', 'T'),
        fim: String(fim).replace(' ', 'T'),
        areas: limparAreas(area),
        link: (item.match(/<link>([^<]+)<\/link>/) || [])[1] || '',
      });
    }
    const sev = { 'Perigo Potencial': 2, 'Perigo': 1, 'Grande Perigo': 0 };
    avisos.sort((a, b) => (sev[a.severidade] ?? 2) - (sev[b.severidade] ?? 2));
    return avisos;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;

  if (req.method === 'OPTIONS') return jsonResponse(204, {}, origin);
  if (req.method !== 'GET') {
    return jsonResponse(405, { erro: 'Método não permitido.' }, origin);
  }

  // Alertas curados são recalculados a cada requisição (datas sempre relativas
  // a "agora"), nunca persistidos ” evita servir alertas com validade expirada.
  let alertas = ALERTAS_SEED.map((a, i) => ({ ...datasAtuais(a, i), ...a }));
  alertas = alertas.filter((a) => {
    const v = new Date(a.validoAte).getTime();
    return isNaN(v) || v >= Date.now();
  });

  let comInmet = true;
  let munFilter = '';
  const ru = reqUrl(req);
  try {
    comInmet = ru ? ru.searchParams.get('inmet') !== '0' : true;
    munFilter = ru ? (ru.searchParams.get('municipio') || '') : '';
  } catch {}

  // Filtro por município (gestor municipal): aplica-se apenas aos alertas
  // curados. Os avisos INMET (seção inmet) são nacionais e não são filtrados.
  if (munFilter) {
    const nm = String(munFilter).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    alertas = alertas.filter(a =>
      String(a.municipio || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase() === nm);
  }

  const inmet = comInmet ? await fetchInmetAvisos() : [];

  return jsonResponse(200, {
    alertas,
    inmet,
    atualizadoEm: new Date().toISOString(),
  }, origin);
});
