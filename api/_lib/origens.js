/* ============================================================
   Registro central de fontes externas do proxy (/api/proxy).
   Cada fonte tem TTL de CDN, janela stale, timeout e teto de bytes
   próprios — ver docs/fontes.md.
   Como adicionar uma fonte: acrescente uma entrada abaixo
   (hosts + ttlSeg) e um caso em test/proxy-cache.test.js.
   Hosts fora do registro usam o DEFAULT (seguro, sem quebrar).
   O allowlist de segurança continua sendo PROXY_HOSTS
   (ver api/_routes/proxy.js) — este arquivo só ajusta
   cache/timeout/fallback por fonte.
   ============================================================ */

const DEFAULT = {
  id: 'default',
  ttlSeg: 300,
  staleSeg: 600,
  timeoutMs: 10000,
  maxBytes: 10 * 1024 * 1024,
};

const FONTES = [
  { id: 'rainviewer', hosts: ['api.rainviewer.com'], ttlSeg: 300, staleSeg: 300, timeoutMs: 8000 },
  { id: 'inpe-csv', hosts: ['dataserver-coids.inpe.br'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 15000 },
  { id: 'inpe-terrabrasilis', hosts: ['terrabrasilis.dpi.inpe.br'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 15000 },
  { id: 'inpe-portal', hosts: ['data.inpe.br'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'censipam', hosts: ['panorama.sipam.gov.br'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 15000 },
  { id: 'inmet-estacoes', hosts: ['apitempo.inmet.gov.br'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 15000 },
  { id: 'inmet-avisos', hosts: ['apiprevmet3.inmet.gov.br'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 15000 },
  { id: 'inmet-graficos', hosts: ['tempo.inmet.gov.br'], ttlSeg: 3600, staleSeg: 7200, timeoutMs: 10000 },
  { id: 'open-meteo', hosts: ['api.open-meteo.com'], ttlSeg: 600, staleSeg: 1800, timeoutMs: 8000 },
  { id: 'open-meteo-aq', hosts: ['air-quality-api.open-meteo.com'], ttlSeg: 1800, staleSeg: 3600, timeoutMs: 8000 },
  { id: 'ibge', hosts: ['servicodados.ibge.gov.br', 'www.ibge.gov.br'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'msn', hosts: ['assets.msn.com'], ttlSeg: 900, staleSeg: 3600, timeoutMs: 10000 },
  { id: 'brasilapi', hosts: ['brasilapi.com.br'], ttlSeg: 1800, staleSeg: 3600, timeoutMs: 10000 },
  { id: 'nominatim', hosts: ['nominatim.openstreetmap.org'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'overpass', hosts: ['overpass-api.de'], ttlSeg: 3600, staleSeg: 7200, timeoutMs: 20000 },
  { id: 'noaa', hosts: ['cpc.ncep.noaa.gov', 'www.cpc.ncep.noaa.gov'], ttlSeg: 3600, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'snirh', hosts: ['www.snirh.gov.br'], ttlSeg: 900, staleSeg: 3600, timeoutMs: 15000 },
  { id: 'sinfra', hosts: ['mapas.sinfra.mt.gov.br', 'obrasaovivo.sinfra.mt.gov.br'], ttlSeg: 900, staleSeg: 3600, timeoutMs: 15000 },
  { id: 'sesp', hosts: ['www.sesp.mt.gov.br'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'inde', hosts: ['geoservicos.inde.gov.br'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 25000 },
  { id: 'arcgis', hosts: ['server.arcgisonline.com'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
  { id: 'govbr', hosts: ['www.gov.br'], ttlSeg: 86400, staleSeg: 86400, timeoutMs: 10000 },
];

/** Localiza a config da fonte pelo hostname (exato ou subdomínio). */
function origemPara(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const f of FONTES) {
    if ((f.hosts || []).some((h) => host === h || host.endsWith('.' + h))) {
      return { ...DEFAULT, ...f };
    }
  }
  return { ...DEFAULT };
}

module.exports = { FONTES, DEFAULT, origemPara };
