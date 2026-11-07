/* ============================================================
   IBGE / BrasilAPI proxy dedicado (backend).
   GET /api/ibge/estados
   GET /api/ibge/municipios?uf=XX
   GET /api/ibge/malhas/estados
   GET /api/ibge/malhas/estados/XX
   Cache CDN via s-maxage/stale-while-revalidate (origemPara).
   Fallback automático para último JSON válido (X-Stale).
   Observabilidade: saúde registrada em system_config (fonte-saude).
   ============================================================ */
const { jsonResponse, cacheHeaders, reqUrl, bearerToken } = require('../_lib/http');
const { serve } = require('../_lib/serverless');
const { origemPara, FONTES } = require('../_lib/origens');
const { readCollection, writeCollection } = require('../_lib/store');
const LOCALIDADES = require('../_lib/ibge-localidades.json');

const BRASILAPI_BASE = 'https://brasilapi.com.br/api/ibge';
const IBGE_MALHAS_BASE = 'https://servicodados.ibge.gov.br/api/v3/malhas';
const TIMEOUT_MS = 10000;

/* Snapshot local do IBGE (gerado por scripts/gerar-snapshot-ibge.js).
   Evita depender do servicodados em tempo real, que fica instável fora
   do Brasil. Os dados de localidades mudam raramente (novos municípios). */
const SNAPSHOT_ESTADOS = Array.isArray(LOCALIDADES.estados)
  ? LOCALIDADES.estados.slice().sort((a, b) => Number(a.id) - Number(b.id))
  : [];
const SNAPSHOT_MUNICIPIOS = (LOCALIDADES.municipios && typeof LOCALIDADES.municipios === 'object')
  ? LOCALIDADES.municipios
  : {};
const SNAPSHOT_ATUALIZADO = LOCALIDADES.atualizadoEm || null;

function todosMunicipiosSnapshot() {
  return Object.keys(SNAPSHOT_MUNICIPIOS)
    .sort()
    .reduce((acc, uf) => acc.concat(SNAPSHOT_MUNICIPIOS[uf] || []), []);
}

/* Indicadores do painel do município via SIDRA (Censo 2022 + PIB 2023). */
async function buscarIndicadores(codigo) {
  const alvos = [
    `https://apisidra.ibge.gov.br/values/t/4714/n6/${codigo}/v/93,6318,614/p/2022`,
    `https://apisidra.ibge.gov.br/values/t/9923/n6/${codigo}/v/93/p/2022/c1/1,2`,
    `https://apisidra.ibge.gov.br/values/t/5938/n6/${codigo}/v/37/p/2023`,
  ];
  const respostas = await Promise.allSettled(alvos.map((upstreamUrl) =>
    buscarOrigemComFallback({
      parsed: new URL(upstreamUrl),
      origemId: 'ibge-sidra',
      timeoutMs: 20000,
      maxBytes: 5 * 1024 * 1024,
    }).then((result) => JSON.parse(result.buf.toString('utf8')))
  ));

  const dados = { codigo, fonte: 'IBGE — SIDRA (Censo 2022 / PIB 2023)', anos: { populacao: 2022, pib: 2023 } };
  const tabela = (idx) => {
    const r = respostas[idx];
    return r && r.status === 'fulfilled' && Array.isArray(r.value) ? r.value.slice(1) : [];
  };

  for (const row of tabela(0)) {
    const valor = parseFloat(row.V);
    if (!Number.isFinite(valor)) continue;
    if (row.D2C === '93') dados.populacao = valor;
    else if (row.D2C === '6318') dados.areaKm2 = valor;
    else if (row.D2C === '614') dados.densidade = valor;
  }
  for (const row of tabela(1)) {
    const valor = parseFloat(row.V);
    if (!Number.isFinite(valor)) continue;
    if (row.D4C === '1') dados.populacaoUrbana = valor;
    else if (row.D4C === '2') dados.populacaoRural = valor;
  }
  for (const row of tabela(2)) {
    const valor = parseFloat(row.V);
    if (!Number.isFinite(valor)) continue;
    if (row.D2C === '37') dados.pibMilReais = valor;
  }
  if (dados.populacaoUrbana != null && dados.populacaoRural != null) {
    const total = dados.populacaoUrbana + dados.populacaoRural;
    if (total > 0) dados.urbanizacaoPct = Math.round((dados.populacaoUrbana / total) * 1000) / 10;
  }
  if (dados.pibMilReais != null && dados.populacao) {
    dados.pibPerCapita = Math.round((dados.pibMilReais * 1000 / dados.populacao) * 100) / 100;
  }
  return dados;
}

const UF_POR_SIGLA = {
  RO:'11', AC:'12', AM:'13', RR:'14', PA:'15', AP:'16', TO:'17',
  MA:'21', PI:'22', CE:'23', RN:'24', PB:'25', PE:'26', AL:'27',
  SE:'28', BA:'29', MG:'31', ES:'32', RJ:'33', SP:'35', PR:'41',
  SC:'42', RS:'43', MS:'50', MT:'51', GO:'52', DF:'53',
};

function normalizarUF(uf) {
  const v = String(uf || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(v) && UF_POR_SIGLA[v]) return UF_POR_SIGLA[v];
  return v;
}

function validarUF(uf) {
  const v = normalizarUF(uf);
  if (!/^\d{2}$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= 11 && n <= 53 ? v : null;
}

async function buscarOrigemComFallback({ parsed, origemId, timeoutMs, maxBytes }) {
  const origem = FONTES.find(f => f.id === origemId) || { ...FONTES[0] };
  const { buscarOrigem, lerFallback, salvarFallback, registrarSaude, chaveFallback } = require('./proxy');

  try {
    const upstream = await buscarOrigem({ parsed, timeoutMs, maxBytes });
    const buf = upstream.body;
    const contentType = upstream.headers.get('content-type') || 'application/json';

    await registrarSaude(origemId, upstream.ok);

    if (upstream.ok && buf.length <= 5 * 1024 * 1024) {
      try {
        await salvarFallback(chaveFallback(parsed), {
          status: upstream.status,
          contentType,
          base64: buf.toString('base64'),
          salvoEm: new Date().toISOString(),
        });
      } catch {}
    }

    return { upstream, buf, contentType };
  } catch (e) {
    await registrarSaude(origemId, false);
    const velho = await lerFallback(chaveFallback(parsed));
    if (velho && velho.base64) {
      const buf = Buffer.from(velho.base64, 'base64');
      const idadeSeg = Math.max(0, Math.round((Date.now() - Date.parse(velho.salvoEm)) / 1000));
      return {
        upstream: {
          status: velho.status || 200,
          ok: true,
          headers: { get: () => velho.contentType || 'application/json' },
        },
        buf,
        contentType: velho.contentType || 'application/json',
        stale: true,
        idadeSeg,
      };
    }
    throw e;
  }
}

module.exports = serve(async function handler(req) {
  const origin = req.headers.get ? req.headers.get('origin') : undefined;
  const headers = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'GET') return jsonResponse(405, { erro: 'Método não suportado.' }, origin);

  try {
    const url = reqUrl(req);
    const path = url ? url.pathname.replace('/api/ibge', '') : '/estados';
    const params = url ? url.searchParams : new URLSearchParams();

    // Health check endpoint
    if (path === '/health') {
      return jsonResponse(200, { status: 'ok', timestamp: new Date().toISOString() }, origin);
    }

    let data, ttlSeg, staleSeg, origemId, upstreamUrl;

    if (path === '/estados' || path === '/estados/') {
      return jsonResponse(200, SNAPSHOT_ESTADOS, origin, {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
        'X-Fonte': 'snapshot-ibge',
        'X-Snapshot-Atualizado': SNAPSHOT_ATUALIZADO || 'desconhecido',
      });

    } else if (path === '/municipios' || path === '/municipios/') {
      const ufParam = String(params.get('uf') || '').trim();
      const cacheSnapshot = {
        'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
        'X-Fonte': 'snapshot-ibge',
        'X-Snapshot-Atualizado': SNAPSHOT_ATUALIZADO || 'desconhecido',
      };
      if (ufParam.toLowerCase() === 'todos') {
        return jsonResponse(200, todosMunicipiosSnapshot(), origin, cacheSnapshot);
      }
      const uf = validarUF(ufParam);
      if (!uf) return jsonResponse(400, { erro: 'Parâmetro uf obrigatório (ex.: 51).' }, origin);
      const lista = SNAPSHOT_MUNICIPIOS[uf] || [];
      if (!lista.length) {
        return jsonResponse(404, { erro: 'UF sem municípios no snapshot local.', uf }, origin);
      }
      return jsonResponse(200, lista, origin, cacheSnapshot);

    } else if (path === '/indicadores' || path === '/indicadores/') {
      const codigo = String(params.get('cod') || '').trim();
      if (!/^\d{7}$/.test(codigo)) {
        return jsonResponse(400, { erro: 'Parâmetro cod (código IBGE de 7 dígitos) obrigatório.' }, origin);
      }
      const indicadores = await buscarIndicadores(codigo);
      return jsonResponse(200, indicadores, origin, {
        'Cache-Control': 'public, s-maxage=604800, stale-while-revalidate=2592000',
        'X-Fonte': 'ibge-sidra',
      });

    } else if (path === '/malhas/estados' || path === '/malhas/estados/') {
      console.log('[ibge] fetching malhas estados');
      origemId = 'ibge';
      upstreamUrl = `${IBGE_MALHAS_BASE}/paises/BR?formato=application/vnd.geo+json&intrarregiao=UF&qualidade=minima`;
      let result;
      try {
        result = await buscarOrigemComFallback({
          parsed: new URL(upstreamUrl),
          origemId,
          timeoutMs: 15000,
          maxBytes: 10 * 1024 * 1024,
        });
        console.log('[ibge] malhas estados result:', result.upstream?.status, result.upstream?.ok);
        if (!result.upstream.ok) throw new Error('Upstream returned ' + result.upstream.status);
      } catch (e) {
        console.error('[ibge] malhas estados error:', e.message);
        // Fallback estático com geometrias simplificadas dos 27 estados
        const fallbackMalha = {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { codarea: '11', nome: 'Rondônia', sigla: 'RO' }, geometry: { type: 'Polygon', coordinates: [[[-64.8,-10.9],[-62.3,-10.9],[-62.3,-13.7],[-64.8,-13.7],[-64.8,-10.9]]] } },
            { type: 'Feature', properties: { codarea: '12', nome: 'Acre', sigla: 'AC' }, geometry: { type: 'Polygon', coordinates: [[[-70.0,-7.5],[-68.0,-7.5],[-68.0,-11.0],[-70.0,-11.0],[-70.0,-7.5]]] } },
            { type: 'Feature', properties: { codarea: '13', nome: 'Amazonas', sigla: 'AM' }, geometry: { type: 'Polygon', coordinates: [[[-70.0,-0.5],[-64.5,-0.5],[-64.5,-10.0],[-70.0,-10.0],[-70.0,-0.5]]] } },
            { type: 'Feature', properties: { codarea: '14', nome: 'Roraima', sigla: 'RR' }, geometry: { type: 'Polygon', coordinates: [[[-64.5,1.5],[-59.5,1.5],[-59.5,-2.5],[-64.5,-2.5],[-64.5,1.5]]] } },
            { type: 'Feature', properties: { codarea: '15', nome: 'Pará', sigla: 'PA' }, geometry: { type: 'Polygon', coordinates: [[[-59.5,-1.5],[-46.5,-1.5],[-46.5,-9.5],[-59.5,-9.5],[-59.5,-1.5]]] } },
            { type: 'Feature', properties: { codarea: '16', nome: 'Amapá', sigla: 'AP' }, geometry: { type: 'Polygon', coordinates: [[[-54.5,0.5],[-50.5,0.5],[-50.5,-4.5],[-54.5,-4.5],[-54.5,0.5]]] } },
            { type: 'Feature', properties: { codarea: '17', nome: 'Tocantins', sigla: 'TO' }, geometry: { type: 'Polygon', coordinates: [[[-51.0,-5.0],[-46.5,-5.0],[-46.5,-13.5],[-51.0,-13.5],[-51.0,-5.0]]] } },
            { type: 'Feature', properties: { codarea: '21', nome: 'Maranhão', sigla: 'MA' }, geometry: { type: 'Polygon', coordinates: [[[-48.5,-1.0],[-42.0,-1.0],[-42.0,-10.5],[-48.5,-10.5],[-48.5,-1.0]]] } },
            { type: 'Feature', properties: { codarea: '22', nome: 'Piauí', sigla: 'PI' }, geometry: { type: 'Polygon', coordinates: [[[-45.5,-2.5],[-41.0,-2.5],[-41.0,-11.0],[-45.5,-11.0],[-45.5,-2.5]]] } },
            { type: 'Feature', properties: { codarea: '23', nome: 'Ceará', sigla: 'CE' }, geometry: { type: 'Polygon', coordinates: [[[-41.5,-2.0],[-37.5,-2.0],[-37.5,-8.0],[-41.5,-8.0],[-41.5,-2.0]]] } },
            { type: 'Feature', properties: { codarea: '24', nome: 'Rio Grande do Norte', sigla: 'RN' }, geometry: { type: 'Polygon', coordinates: [[[-38.5,-4.5],[-35.0,-4.5],[-35.0,-7.5],[-38.5,-7.5],[-38.5,-4.5]]] } },
            { type: 'Feature', properties: { codarea: '25', nome: 'Paraíba', sigla: 'PB' }, geometry: { type: 'Polygon', coordinates: [[[-38.5,-6.0],[-34.5,-6.0],[-34.5,-8.5],[-38.5,-8.5],[-38.5,-6.0]]] } },
            { type: 'Feature', properties: { codarea: '26', nome: 'Pernambuco', sigla: 'PE' }, geometry: { type: 'Polygon', coordinates: [[[-41.0,-7.0],[-35.0,-7.0],[-35.0,-10.0],[-41.0,-10.0],[-41.0,-7.0]]] } },
            { type: 'Feature', properties: { codarea: '27', nome: 'Alagoas', sigla: 'AL' }, geometry: { type: 'Polygon', coordinates: [[[-38.0,-8.5],[-35.5,-8.5],[-35.5,-10.5],[-38.0,-10.5],[-38.0,-8.5]]] } },
            { type: 'Feature', properties: { codarea: '28', nome: 'Sergipe', sigla: 'SE' }, geometry: { type: 'Polygon', coordinates: [[[-38.0,-9.5],[-36.5,-9.5],[-36.5,-11.5],[-38.0,-11.5],[-38.0,-9.5]]] } },
            { type: 'Feature', properties: { codarea: '29', nome: 'Bahia', sigla: 'BA' }, geometry: { type: 'Polygon', coordinates: [[[-46.5,-8.0],[-38.0,-8.0],[-38.0,-18.0],[-46.5,-18.0],[-46.5,-8.0]]] } },
            { type: 'Feature', properties: { codarea: '31', nome: 'Minas Gerais', sigla: 'MG' }, geometry: { type: 'Polygon', coordinates: [[[-49.5,-14.0],[-41.0,-14.0],[-41.0,-23.0],[-49.5,-23.0],[-49.5,-14.0]]] } },
            { type: 'Feature', properties: { codarea: '32', nome: 'Espírito Santo', sigla: 'ES' }, geometry: { type: 'Polygon', coordinates: [[[-41.5,-17.5],[-40.0,-17.5],[-40.0,-21.5],[-41.5,-21.5],[-41.5,-17.5]]] } },
            { type: 'Feature', properties: { codarea: '33', nome: 'Rio de Janeiro', sigla: 'RJ' }, geometry: { type: 'Polygon', coordinates: [[[-44.5,-20.5],[-41.0,-20.5],[-41.0,-23.5],[-44.5,-23.5],[-44.5,-20.5]]] } },
            { type: 'Feature', properties: { codarea: '35', nome: 'São Paulo', sigla: 'SP' }, geometry: { type: 'Polygon', coordinates: [[[-53.5,-19.5],[-44.0,-19.5],[-44.0,-25.5],[-53.5,-25.5],[-53.5,-19.5]]] } },
            { type: 'Feature', properties: { codarea: '41', nome: 'Paraná', sigla: 'PR' }, geometry: { type: 'Polygon', coordinates: [[[-54.5,-22.5],[-50.5,-22.5],[-50.5,-26.5],[-54.5,-26.5],[-54.5,-22.5]]] } },
            { type: 'Feature', properties: { codarea: '42', nome: 'Santa Catarina', sigla: 'SC' }, geometry: { type: 'Polygon', coordinates: [[[-53.5,-26.0],[-48.5,-26.0],[-48.5,-29.5],[-53.5,-29.5],[-53.5,-26.0]]] } },
            { type: 'Feature', properties: { codarea: '43', nome: 'Rio Grande do Sul', sigla: 'RS' }, geometry: { type: 'Polygon', coordinates: [[[-57.5,-27.0],[-49.5,-27.0],[-49.5,-33.5],[-57.5,-33.5],[-57.5,-27.0]]] } },
            { type: 'Feature', properties: { codarea: '50', nome: 'Mato Grosso do Sul', sigla: 'MS' }, geometry: { type: 'Polygon', coordinates: [[[-58.0,-13.5],[-52.5,-13.5],[-52.5,-23.0],[-58.0,-23.0],[-58.0,-13.5]]] } },
            { type: 'Feature', properties: { codarea: '51', nome: 'Mato Grosso', sigla: 'MT' }, geometry: { type: 'Polygon', coordinates: [[[-62.0,-7.0],[-51.5,-7.0],[-51.5,-18.0],[-62.0,-18.0],[-62.0,-7.0]]] } },
            { type: 'Feature', properties: { codarea: '52', nome: 'Goiás', sigla: 'GO' }, geometry: { type: 'Polygon', coordinates: [[[-53.5,-12.5],[-46.0,-12.5],[-46.0,-19.5],[-53.5,-19.5],[-53.5,-12.5]]] } },
            { type: 'Feature', properties: { codarea: '53', nome: 'Distrito Federal', sigla: 'DF' }, geometry: { type: 'Polygon', coordinates: [[[-48.3,-15.5],[-47.5,-15.5],[-47.5,-16.2],[-48.3,-16.2],[-48.3,-15.5]]] } }
          ]
        };
        console.log('[ibge] usando fallback estático com', fallbackMalha.features.length, 'estados');
        return jsonResponse(200, fallbackMalha, origin, { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400', 'X-Stale': '1', 'X-Stale-Source': 'static-fallback-simplificado' });
      }
      data = JSON.parse(result.buf.toString('utf8'));
      console.log('[ibge] malhas estados features:', data.features?.length);
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (result.stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(result.idadeSeg);
      return new Response(JSON.stringify(data), { status: result.upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': result.contentType }) });

} else if (path.startsWith('/malhas/estados/') && path.length > 16) {
      const uf = validarUF(path.slice(16));
      if (!uf) return jsonResponse(400, { erro: 'UF inválida na malha.' }, origin);
      console.log('[ibge] fetching malhas estado:', uf);
      origemId = 'ibge';
      upstreamUrl = `${IBGE_MALHAS_BASE}/estados/${uf}?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima`;
      let result;
      try {
        result = await buscarOrigemComFallback({
          parsed: new URL(upstreamUrl),
          origemId,
          timeoutMs: 15000,
          maxBytes: 10 * 1024 * 1024,
        });
        console.log('[ibge] malhas estado result:', uf, result.upstream?.status, result.upstream?.ok);
        if (!result.upstream.ok) throw new Error('Upstream returned ' + result.upstream.status);
      } catch (e) {
        console.error('[ibge] malhas estado error:', uf, e.message);
        // Último recurso: só MT tem um recorte simplificado embutido.
        // Para as demais UFs, devolve erro explícito (o front usa o
        // snapshot estático /geo/malhas e não depende deste fallback).
        if (uf !== '51') {
          return jsonResponse(502, { erro: 'IBGE indisponível para a malha municipal.', uf }, origin, { 'Cache-Control': 'no-store' });
        }
        const fallbackMun = {
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: { codarea: '5103403', nome: 'Cuiabá' }, geometry: { type: 'Polygon', coordinates: [[[-56.2,-15.7],[-55.8,-15.7],[-55.8,-15.4],[-56.2,-15.4],[-56.2,-15.7]]] } },
            { type: 'Feature', properties: { codarea: '5108402', nome: 'Várzea Grande' }, geometry: { type: 'Polygon', coordinates: [[[-56.3,-15.8],[-55.9,-15.8],[-55.9,-15.5],[-56.3,-15.5],[-56.3,-15.8]]] } },
            { type: 'Feature', properties: { codarea: '5107602', nome: 'Rondonópolis' }, geometry: { type: 'Polygon', coordinates: [[[-54.8,-16.6],[-54.5,-16.6],[-54.5,-16.3],[-54.8,-16.3],[-54.8,-16.6]]] } }
          ]
        };
        console.log('[ibge] usando fallback estático de municipios para', uf, 'com', fallbackMun.features.length, 'features');
        return jsonResponse(200, fallbackMun, origin, { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400', 'X-Stale': '1', 'X-Stale-Source': 'static-fallback-municipios' });
      }
      data = JSON.parse(result.buf.toString('utf8'));
      console.log('[ibge] malhas estado features:', uf, data.features?.length);
      ttlSeg = 86400; staleSeg = 86400;
      const resHeaders = { 'Cache-Control': cacheHeaders(ttlSeg, staleSeg)['Cache-Control'] };
      if (result.stale) resHeaders['X-Stale'] = '1', resHeaders['X-Stale-Age-Seg'] = String(result.idadeSeg);
      return new Response(JSON.stringify(data), { status: result.upstream.status, headers: Object.assign({}, headers, resHeaders, { 'Content-Type': result.contentType }) });

    } else {
      return jsonResponse(404, { erro: 'Endpoint não encontrado.' }, origin);
    }
  } catch (e) {
    console.error('[ibge] handler error:', e.message, e.stack);
    return jsonResponse(500, { erro: 'Erro interno no proxy IBGE.', detalhe: e.message }, origin);
  }
});