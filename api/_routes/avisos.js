/* ============================================================
   GET /api/avisos — avisos meteorológicos do INMET (nacional).
   Fonte oficial (verificada ao vivo em 2026-10-13):
     lista:   https://apiprevmet3.inmet.gov.br/avisos/rss
     detalhe: https://apiprevmet3.inmet.gov.br/avisos/rss/<id>
              (CAP 1.2 com <polygon>, severidade, vigência).
   Sem filtro por UF: nacional por padrão. O front recorta por
   viewport/UF com os polígonos do detalhe.
   GET /api/avisos          lista com vigência e severidade
   GET /api/avisos?id=56064 detalhe CAP + polígono ([lat,lon])
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl } = require('../_lib/http');
const { serve } = require('../_lib/serverless');

const RSS_URL = 'https://apiprevmet3.inmet.gov.br/avisos/rss';
const TIMEOUT_MS = 15000;

const SEVERIDADE_NIVEL = { 'Perigo Potencial': 1, Perigo: 2, 'Grande Perigo': 3 };

async function buscarTexto(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SGIProtege/1.0 (+painel-operacional)', Accept: '*/*' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`INMET respondeu HTTP ${res.status}.`);
    const buf = Buffer.from(await res.arrayBuffer());
    let texto = buf.toString('utf8');
    if (texto.includes('\uFFFD')) texto = buf.toString('latin1');
    return texto;
  } finally {
    clearTimeout(timer);
  }
}

function campoTabela(html, rotulo) {
  const re = new RegExp('<th[^>]*>' + rotulo + '</th>[\\s\\S]*?<td>([\\s\\S]*?)</td>', 'i');
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
}

function textoTag(xml, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/* Datas do INMET vêm em hora de Brasília sem offset
   ("2026-10-13 23:00", "14/10/2026 00:01"). Sem sufixo, `new Date`
   interpreta no fuso do servidor (UTC na Vercel), deslocando a
   vigência em horas. Brasília é UTC-3 o ano todo (sem horário de
   verão desde 2019), então convertemos com offset explícito.
   CAP com offset próprio (ex.: -03:00) usa o nativo. */
const FUSO_BRASILIA_MIN = -180;

function parseData(v) {
  if (!v) return null;
  const texto = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(texto);
  if (m) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - FUSO_BRASILIA_MIN * 60000;
    return new Date(ms).toISOString();
  }
  m = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(texto);
  if (m) {
    const ms = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - FUSO_BRASILIA_MIN * 60000;
    return new Date(ms).toISOString();
  }
  const d = new Date(texto);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseLista(xml) {
  const itens = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const agora = Date.now();
  const out = [];
  for (const item of itens) {
    const link = textoTag(item, 'link');
    const idMatch = /\/rss\/(\d+)/.exec(link);
    if (!idMatch) continue;
    const dm = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/);
    const html = dm ? dm[1] : '';
    const evento = campoTabela(html, 'Evento') || textoTag(item, 'title').replace(/^Aviso de\s+/i, '').replace(/\..*$/, '');
    const severidade = campoTabela(html, 'Severidade');
    const inicioIso = parseData(campoTabela(html, 'Início'));
    const fimIso = parseData(campoTabela(html, 'Fim'));
    // Vigente = já começou E ainda não terminou (como na versão MT:
    // futuro distante ou expirado não dispara modal).
    const inicioOk = inicioIso ? Date.parse(inicioIso) <= agora : true;
    const fimOk = fimIso ? Date.parse(fimIso) >= agora : true;
    out.push({
      id: idMatch[1],
      evento: evento || null,
      severidade: severidade || null,
      nivel: SEVERIDADE_NIVEL[severidade] || 0,
      inicio: inicioIso,
      fim: fimIso,
      vigente: inicioOk && fimOk,
      descricao: campoTabela(html, 'Descrição') || null,
      areas: campoTabela(html, 'Área') || null,
    });
  }
  out.sort((a, b) => (b.nivel - a.nivel) || String(a.id).localeCompare(String(b.id)));
  return out;
}

function parsePoligono(xml) {
  const m = /<polygon>([\s\S]*?)<\/polygon>/i.exec(xml);
  if (!m) return null;
  const pts = m[1].trim().split(/\s+/).map((par) => {
    const [lat, lon] = par.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return [lat, lon];
  }).filter(Boolean);
  return pts.length >= 3 ? pts : null;
}

function parseDetalhe(xml) {
  return {
    evento: textoTag(xml, 'event') || null,
    severidade: textoTag(xml, 'severity') || null,
    urgencia: textoTag(xml, 'urgency') || null,
    certeza: textoTag(xml, 'certainty') || null,
    inicio: parseData(textoTag(xml, 'onset')),
    fim: parseData(textoTag(xml, 'expires')),
    publicadoEm: parseData(textoTag(xml, 'sent')),
    areaDesc: textoTag(xml, 'areaDesc') || null,
    poligono: parsePoligono(xml),
  };
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  if (req.method === 'OPTIONS') {
    const { corsHeaders } = require('../_lib/http');
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  const ru = reqUrl(req);
  const id = ru ? ru.searchParams.get('id') : null;
  try {
    if (id) {
      if (!/^\d+$/.test(id)) return jsonResponse(400, { erro: 'id inválido.' }, origin);
      const detalhe = parseDetalhe(await buscarTexto(`${RSS_URL}/${id}`));
      if (!detalhe.evento && !detalhe.poligono) {
        return jsonResponse(404, { erro: 'Aviso não encontrado ou formato inesperado.' }, origin);
      }
      const res = jsonResponse(200, {
        fonte: 'INMET — Avisos (CAP)',
        id,
        atualizadoEm: new Date().toISOString(),
        ...detalhe,
      }, origin);
      Object.entries(cacheHeaders(3600, 3600)).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    }
    const avisos = parseLista(await buscarTexto(RSS_URL));
    const res = jsonResponse(200, {
      fonte: 'INMET — Avisos meteorológicos (nacional)',
      atualizadoEm: new Date().toISOString(),
      total: avisos.length,
      vigentes: avisos.filter((a) => a.vigente).length,
      observacao: 'Polígonos por aviso em GET /api/avisos?id= (CAP oficial).',
      avisos,
    }, origin);
    Object.entries(cacheHeaders(600, 600)).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  } catch (e) {
    return jsonResponse(502, { erro: 'Falha ao consultar os avisos do INMET.', detalhes: e.message }, origin);
  }
});

module.exports.parseLista = parseLista;
module.exports.parseDetalhe = parseDetalhe;
module.exports.parsePoligono = parsePoligono;
module.exports.parseData = parseData;
