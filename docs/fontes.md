# Fontes de dados do Mapa Integrado

Como cada fonte externa é consumida, com que cache e como adicionar uma nova.
Verificação ao vivo em 2026-10-13: INPE CSV 200, INMET estações 200,
CENSIPAM 200, RainViewer 200, INMET RSS 200, TerraBrasilis WMS 200,
BrasilAPI CPTEC 500 (quebrado — ver abaixo), INDE WMS instável.

## Via proxy (`GET /api/proxy?url=`)

O navegador nunca chama a fonte direto quando o backend responde:
`js/proxy.js` (`dcProxyFetch`) usa o proxy e só cai para fetch direto
se o próprio `/api` estiver inalcançável. Respostas de erro do proxy
(403/502 com JSON) **não** disparam fallback direto.

Headers de resposta: `X-Fonte` (id do registro), `X-Upstream-Status`,
`X-Upstream-Latency-Ms`, e `X-Stale: 1` + `X-Stale-Age-Seg` quando for
o último dado válido (origem fora do ar). HIT/MISS real aparece em
`x-vercel-cache` no deploy.

## Tabela de cache por fonte (ver `api/_lib/origens.js`)

| Fonte | Hosts | s-maxage | stale | Timeout |
|---|---|---|---|---|
| rainviewer | api.rainviewer.com | 300s | 300s | 8s |
| inpe-csv | dataserver-coids.inpe.br | 600s | 1800s | 15s |
| inpe-terrabrasilis | terrabrasilis.dpi.inpe.br | 600s | 1800s | 15s |
| inpe-portal | data.inpe.br | 24h | 24h | 10s |
| censipam | panorama.sipam.gov.br | 600s | 1800s | 15s |
| inmet-estacoes | apitempo.inmet.gov.br | 600s | 1800s | 15s |
| inmet-avisos | apiprevmet3.inmet.gov.br | 600s | 1800s | 15s |
| inmet-graficos | tempo.inmet.gov.br | 1h | 2h | 10s |
| open-meteo | api.open-meteo.com | 600s | 1800s | 8s |
| ibge | servicodados.ibge.gov.br, www.ibge.gov.br | 24h | 24h | 10s |
| msn | assets.msn.com | 15min | 1h | 10s |
| brasilapi | brasilapi.com.br | 30min | 1h | 10s |
| nominatim | nominatim.openstreetmap.org | 24h | 24h | 10s |
| overpass | overpass-api.de | 1h | 2h | 20s |
| noaa | cpc.ncep.noaa.gov (+www) | 1h | 24h | 10s |
| snirh | www.snirh.gov.br | 15min | 1h | 15s |
| sinfra | mapas/obrasaovivo.sinfra.mt.gov.br | 15min | 1h | 15s |
| sesp | www.sesp.mt.gov.br | 24h | 24h | 10s |
| inde (CNUC) | geoservicos.inde.gov.br | 24h | 24h | 25s |
| arcgis | server.arcgisonline.com | 24h | 24h | 10s |
| govbr | www.gov.br | 24h | 24h | 10s |
| default | qualquer outro host permitido | 300s | 600s | 10s |

Segurança: o allowlist continua sendo `PROXY_HOSTS` (lido por
requisição). Fallback "último válido" em `system_config`
(`proxy-fallback:<host><path>`), teto de 256 KB por corpo.

## Direto do navegador (tiles — adequado, sem proxy)

- Base/rótulos: `server.arcgisonline.com` (Canvas Dark Gray).
- Radar/nuvens: tiles do host devolvido por `weather-maps.json`.
- WMS TerraBrasilis (`focos_48h_br_todosats`) e WMS CNUC/INDE.

## Rotas próprias (não usam o proxy genérico)

- `GET /api/ana-hidrologia` — cadastro MT da ANA.
- `GET /api/inmet-chuva` — chuva INMET.
- `GET /api/enso`, `/api/enso/avaliar` — módulo ENOS.
- `GET /api/pluv-alerta`, `/api/pluv-alerta/avaliar` — limiar de chuva.

## Fontes com problema conhecido

- **CPTEC via BrasilAPI** (`/cptec/v1/clima/previsao/226/6`): HTTP 500
  em 2026-10-13. Previsão nacional (Fase 3) deve trocar por fonte
  verificada.
- **MSN/Foreca** (`assets.msn.com/...` com token fixo no código):
  API não-oficial, sem termos verificados; risco de quebra sem aviso.
- **CNUC/INDE**: GetCapabilities instável/lento daqui (>60s);
  timeout do proxy é 25s + fallback stale.
- **SNISB**: hoje é snapshot estático `js/barragens_mt.json`
  (sem frescor) — nacionalizar na Fase 3.

## Como adicionar uma fonte

1. Acrescente a entrada em `api/_lib/origens.js` (hosts + TTL).
2. Garanta o host em `PROXY_HOSTS` (dev: vazio libera tudo).
3. Use `dcProxyFetch(url)` no front; leia `response._stale`
   para exibir "dado antigo".
4. Acrescente um caso em `test/proxy-cache.test.js`.
