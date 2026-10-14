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

Malhas territoriais (`js/organizacao.js`): estados por UF e municípios
por UF funcionam; **a malha nacional usava `/malhas/estados` sem id,
que retorna 404** (a API exige `{id}`) — corrigido para
`/malhas/paises/BR?intrarregiao=UF` com retry (3 tentativas, backoff),
validado com as 27 UFs. Documentação oficial: `/api/docs/malhas`.
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
requisição); **em produção sem `PROXY_HOSTS`, o proxy recusa tudo
com 503** (nunca opera aberto). Anti-SSRF em todas as chamadas:
nega IPs literais/internos (incluindo formas numéricas tipo
`http://2130706433/`), nomes locais (`localhost`, `.local`,
`.internal` etc.) e hostnames que resolvem para faixa privada,
link-local ou metadata cloud; DNS irresolúvel nega (fail closed).
Risco residual conhecido: TOCTOU entre checagem DNS e fetch
(sem pin de IP; redirects já são negados). Fallback "último válido" em `system_config`
(`proxy-fallback:<host><path>`), teto de 256 KB por corpo.
`?raw=1` (ou omitido): passthrough binário exato da origem,
refletido em `X-Proxy-Raw` (compatível com `js/proxy.js`,
que sempre envia o parâmetro).

## Direto do navegador (tiles — adequado, sem proxy)

- Base/rótulos: `server.arcgisonline.com` (Canvas Dark Gray).
- Radar/nuvens: tiles do host devolvido por `weather-maps.json`.
- WMS TerraBrasilis (`focos_48h_br_todosats`) e WMS CNUC/INDE.

## Rotas próprias (não usam o proxy genérico)

- `GET /api/ana-hidrologia` — cadastro MT da ANA.
- `GET /api/inmet-chuva` — chuva INMET.
- `GET /api/enso`, `/api/enso/avaliar` — módulo ENOS.
- `GET /api/pluv-alerta`, `/api/pluv-alerta/avaliar` — limiar de chuva.

## Cobertura nacional (visão Brasil = sem filtro; UF selecionada = filtro)

- Focos CSV/WFS, INMET (estações + chuva + pluviômetro), ANA,
  barragens, avisos CAP, DETER, qualidade do ar, previsão e contador:
  nacionais. Boot sem `?uf=` mostra o Brasil (antes: MT fixo).
- Exceções honestas (fontes intrinsecamente regionais): CENSIPAM
  (Amazônia Legal; pede UF), SESP-MT/VigiaMais e SINFRA/câmeras
  (só MT), abrigos (`js/abrigos_mt.json`, sem fonte nacional
  verificada), monitor climático por cidade (lista base MT +
  município selecionado).

- `GET /api/ana-hidrologia?uf=` — mesmo XML nacional
  (`telemetriaws1.ana.gov.br`), filtro por UF no servidor
  (`BR` = todas ativas). Níveis não incluídos (outro serviço).
- `GET /api/inmet-chuva?uf=` — mesmo zip anual BDMEP (91 MB);
  extrai arquivos `_UF_` (mesmo custo de MT por UF).
- `GET /api/avisos` + `GET /api/avisos?id=` — RSS nacional +
  detalhe CAP 1.2 com `<polygon>`, severidade e vigência.
- `GET /api/barragens?uf=&bbox=&limit=&offset=` — ArcGIS REST
  oficial do SNISB (`portal1.snirh.gov.br/.../Barragens_SNISB`),
  paginado (MaxRecordCount 2000), cache 24h.
- Previsão por município: BrasilAPI CPTEC **fora do ar (HTTP 500)** —
  substituída por Open-Meteo por coordenada (nacional, verificada).
- Focos 48h WFS: filtro por UF + `bbox` da viewport (WFS 1.1.0,
  ordem lat,lon em EPSG:4326).

## Fase 4 — novas camadas de risco (verificado ao vivo em 2026-10-13)

- **DETER (desmatamento)** ✅ — WMS raster nacional sem chave:
  `.../geoserver/deter-amz/wms` (`deter-amz:deter_amz`) e
  `.../geoserver/deter-cerrado-nb/wms` (`deter-cerrado-nb:deter_cerrado`),
  ambos HTTP 200. Tiles diretos (só baixa a área visível).
  Detalhe vetorial (WFS) fica para fase futura.
- **Qualidade do ar / fumaça** ✅ — `air-quality-api.open-meteo.com`
  (PM2.5/PM10/AQI, sem chave, HTTP 200). Camada nos pontos das
  estações INMET; **é modelo CAMS, não medição** (popup declara).
- **Raios** ❌ — GOES GLM é netCDF em buckets (exige deps nativas +
  pipeline próprio, fora do stack); Blitzortung é só para operadores
  e proíbe uso comercial/proteção; BrasilDAT restrito. Adiado com
  alternativas documentadas (parceria Blitzortung ou pipeline GLM).
- **MapBiomas Alerta** ❌ — API GraphQL exige conta + Bearer token
  pessoal (SignIn, sem conta de serviço). Viável com `MAPBIOMAS_TOKEN`
  futuro; sem token, sem camada (regra: sem mock em produção).
- **S2iD ocorrências** ❌ — portal JSF com login, sem API aberta;
  alternativa é espelho Base dos Dados (exige cadastro). Mantido
  fora; revisitar com credencial.
- **CEMADEN / Terras Indígenas**: vereditos da Fase 3 mantidos
  (sem API legível por máquina / geoserver FUNAI com TLS inválido).

## Fontes com problema conhecido

- **CPTEC via BrasilAPI** (`/cptec/v1/clima/previsao/226/6`): HTTP 500
  em 2026-10-13. **Trocado na Fase 3** por Open-Meteo por coordenada;
  aviso no painel MSN lembra a dependência.
- **MSN/Foreca** (`assets.msn.com/...` com token fixo no código):
  API não-oficial, sem termos verificados; risco de quebra sem aviso
  (avisado no próprio painel, Fase 9).
- **CNUC/INDE**: GetCapabilities instável/lento daqui (>60s);
  timeout do proxy é 25s + fallback stale.
- **SNISB**: era snapshot estático `js/barragens_mt.json`
  (sem frescor) — **nacionalizado na Fase 3** (`GET /api/barragens`).

## Fase 5 — alertas ativos (motor no servidor)

- Áreas em `system_config` doc `areas-monitoradas`; eventos em
  `alertas-eventos` (teto 500); snapshots em `motor-snapshots`;
  auditoria em `audit_logs`; push subscriptions em
  `push-subscriptions`; chats Telegram em `telegram-chats`.
- Avaliação: `POST /api/alertas-motor/avaliar` com
  `Authorization: Bearer <ALERTAS_CRON_SECRET>` (ou JWT
  admin/avancado). Agendador: `.github/workflows/alertas-cron.yml`
  (15 min; secrets `PROD_URL` + `ALERTAS_CRON_SECRET`).
- Regras por área: `foco_novo` (INPE CSV do dia), `chuva_24h`
  (open-meteo no centroide; default = limiar global do
  pluv-alerta), `aviso_inmet` (CAP vigente com polígono),
  `estacao_pane` (INMET). Dedup por área+regra+dia; níveis altos
  do ENOS continuam exigindo confirmação humana.
- Canais: Web Push (VAPID: `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`;
  chave pública em `GET /api/push/config`; SW em `/sw.js`) e
  Telegram outbound (`TELEGRAM_BOT_TOKEN`; webhook
  `/api/telegram/webhook` com `/start` e `/status`;
  `TELEGRAM_WEBHOOK_SECRET` valida a origem).
- Fila: `GET /api/alertas-motor/eventos?uf=&tipo=&desde=&limit=`;
  reconhecer exige login (`POST .../reconhecer {id}`).
- Mapa: botão sino por área salva no servidor, fila lateral com
  filtros, banner + som, botão Ativar notificações.

## Como adicionar uma fonte

1. Acrescente a entrada em `api/_lib/origens.js` (hosts + TTL).
2. Garanta o host em `PROXY_HOSTS` (dev: vazio libera tudo).
3. Use `dcProxyFetch(url)` no front; leia `response._stale`
   para exibir "dado antigo".
4. Acrescente um caso em `test/proxy-cache.test.js`.
