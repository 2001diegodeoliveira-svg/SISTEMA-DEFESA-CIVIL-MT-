# APIs do SGI PROTEGE — referência por rota

Roteador único serverless: `api/index.js` (todas `/api/*` → `_routes/*`).
Padrões: `OPTIONS` → 204; erros em `{erro}` (+`detalhes`); auth via
`Authorization: Bearer <JWT>` (perfis `admin/avancado/municipal/comum`);
portão global em `api/_lib/access-control.js` + checagem no handler.

## Leitura pública (sem login)

| Rota | O que devolve | Fonte/cache |
|---|---|---|
| `GET /api/` | índice da API | — |
| `GET /api/demo` | janela de demonstração | store |
| `GET /api/alertas[?inmet=0]` | alertas curados + INMET ao vivo (avisos nacionais, sem recorte por UF) | RSS INMET (10s timeout) |
| `GET /api/areas` | áreas desenhadas | store |
| `GET /api/occurrences[?source=&type=&priority=&status=&period=][?view=map\|stats\|waze]` | ocorrências (coords arredondadas) | store |
| `GET /api/occurrences/:id` | detalhe (404 se ausente) | store |
| `GET /api/reports` | reportes públicos | store |
| `GET /api/proxy?url=` | proxy CORS genérico; `X-Fonte/X-Upstream-*`, `X-Stale` em fallback | origem externa; `s-maxage` por fonte (ver `api/_lib/origens.js`); allowlist `PROXY_HOSTS` |
| `GET\|POST /api/fontes/vigilancia` | re-resolve hosts e audita quem aponta p/ faixa privada (mitigação TOCTOU; Vercel Cron a cada 5min ou `VIGILANCIA_INTERVAL_MIN` no standalone; exige Bearer/`?secret=` se `VIGILANCIA_SECRET` setado) | `system_config` (`fonte-vigilancia`) + `audit_logs` |
| `GET /api/fontes` ou `/api/fontes/saude` | saúde das 22 fontes (ok/lento/fora, último sucesso/falha, latência) | `system_config` (`fonte-saude`) |
| `GET /api/barragens?uf=&bbox=&limit=&offset=` | SNISB normalizado (+`parcial`) | ArcGIS REST SNISB; `s-maxage=24h` |
| `GET /api/firms?dias=1..5&fonte=&bbox=` | Focos NASA FIRMS (Area API, NRT) normalizados; `fonte` = VIIRS_SNPP/NOAA20/NOAA21_NRT ou MODIS_NRT. MAP_KEY só no servidor (`FIRMS_MAP_KEY`). 503 sem chave; 502 se a NASA recusar | NASA FIRMS; `s-maxage=1800`, cache em memória 30 min |
| `GET /api/pantanal-mt?refresh=` | Delimitação oficial do Pantanal-MT (IBGE: bioma ∩ malha MT 2022, 11 municípios) + monitoramento: focos INPE 48 h, risco climático Open-Meteo, estações ANA, chuva INMET, UCs/autos ICMBio e embargos IBAMA. Seções isoladas (`status`/`avisos`); 502 só se todas falharem | Região: snapshot `api/_lib/pantanal-mt.json`; nomes via API IBGE (24 h); resposta em memória 15 min; `s-maxage=900` |
| `GET /api/ambiental-pantanal?bbox=&camadas=&max=&refresh=` | UCs federais + autos de infração (ICMBio) e embargos (IBAMA) em GeoJSON, recortados por bbox (padrão Pantanal); omite autuado/CPF-CNPJ | WFS ICMBio/INDE + CSV de coordenadas do IBAMA; `s-maxage=1h`, cache em memória 24h (embargos) |
| `GET /api/avisos` / `?id=` | RSS nacional / detalhe CAP+polígono | INMET; `s-maxage` 10min/1h |
| `GET /api/areas-monitoradas` | áreas + regras | store |
| `GET /api/alertas-motor/eventos?uf=&tipo=&desde=&limit=` | fila de eventos (novos primeiro) | store |
| `GET /api/push/config` | `{ativo, vapidPublicKey\|null}` | env |
| `GET /api/gestao?municipio=` / `?visao=geral` | gestão municipal / panorama 142 municípios | store (+`MUNICIPIOS_MT`) |
| `GET /api/ibge/estados` | 27 UFs (código IBGE, sigla, nome, região) | snapshot `api/_lib/ibge-localidades.json`; `s-maxage=24h` |
| `GET /api/ibge/municipios?uf=XX\|todos` | municípios com código IBGE, nome, micro/meso | snapshot local; `s-maxage=24h` |
| `GET /api/ibge/indicadores?cod=` | população, área, densidade, urbanização, PIB total/per capita | SIDRA/Censo 2022 + PIB 2023; `s-maxage=7d` |
| `GET /api/ibge/malhas/estados[/XX]` | GeoJSON de UFs/municípios (fallback do upstream) | front usa `geo/malhas/*.geojson` estático |
| `GET /api/noticias[?q=][?n=][?fresco=1]` | RSS Google Notícias filtrado (defesa civil, clima extremo, desastres e queimadas em MT); `fresco=1` ignora cache | Google (sem chave); `s-maxage=300` |
| `GET /api/inmet-chuva?ano=&uf=` | chuva 24h/7d por estação (zip BDMEP via Range) | INMET; `s-maxage=6h` |
| `GET /api/ana-hidrologia?uf=` | estações telemétricas ativas | ANA XML; cache 6h em memória |
| `GET /api/pluv-alerta[?estacoes=]` | limiar servidor + avaliação | store/env |
| `GET /api/enso` | estado ENOS + config + disclaimer | store |
| `GET /api/enso?visao=auditoria\|pendentes` | **gestores** | store/`audit_logs` |
| `GET /api/auth/me` | sessão (ou anônima liberada) | JWT/demo |

## Escrita (método + exigência)

| Rota | Auth | Observação |
|---|---|---|
| `POST /api/auth/login` | — (rate-limit 8/10min) | 503 se login desligado; MFA p/ coordenadores |
| `POST /api/auth/logout`, `POST /api/areas`, `POST /api/reports` | token | validações de campos (400) |
| `DELETE /api/areas/:id` | dono ou admin | 403 fora do dono |
| `PATCH /api/occurrences/:id` | token | status/prioridade/atribuição; audita |
| `POST /api/user-registrations` | pública | cadastro com declaração |
| `PUT/PATCH/DELETE /api/user-registrations/:id`, `POST ...?acao=convite|organizacoes` | gestor/org | RBAC organizacional |
| `POST|DELETE /api/enso` (limiares/regras) | admin/avancado | `POST /api/enso {acao:coletar}` é **público** (cooldown 10 min) |
| `POST /api/enso/avaliar` | admin/avancado | avaliar + confirmar/dispensar |
| `POST /api/areas-monitoradas`, `PUT/DELETE ?id=` | token | valida bbox/regras |
| `POST /api/alertas-motor/avaliar` | `ALERTAS_CRON_SECRET` ou gestor | motor + push/telegram + auditoria |
| `POST /api/alertas-motor/reconhecer {id}` | token | marca reconhecido |
| `POST /api/push/subscrever\|remover` | — | valida endpoint https; remove expiradas |
| `POST /api/telegram/webhook` | `TELEGRAM_WEBHOOK_SECRET` | `/start` registra, `/status` resume |
| `POST /api/gestao`, `DELETE /api/gestao` | municipal no próprio município+ | RBAC por município |
| `POST|DELETE /api/pluv-alerta` | admin/avancado | fonte da verdade do limiar |
| `POST /api/waze|tomtom?action=sync` | token | exige feed/key (405 sem ação válida) |

## Central de Ocorrências (pública — sem autenticação)

<|channel|> Rota | Observação |
|---|---|
| `GET /api/central/tipos[?incluirInativos=1]` | catálogo editável (17 tipos iniciais) |
| `POST /api/central/tipos` | cria tipo sem alterar código |
| `GET /api/central/ocorrencias?...` | filtros: protocolo, tipo, prioridade, status, verificacao, municipioId, responsavelId, de, ate, q |
| `POST /api/central/ocorrencias` | protocolo automático `OC-AAAA-NNNNNN`, prioridade sugerida por heurística |
| `GET /api/central/ocorrencias/:id` | detalhe + danos + histórico + mobilizações + anexos |
| `PATCH /api/central/ocorrencias/:id` | status (justificativa obrigatória para concluir/arquivar), prioridade, danos, etc. |
| `GET /api/central/dashboard` | indicadores operacionais + distribuição + evolução |
| `GET /api/central/equipes` | |
| `POST /api/central/equipes` | |
| `GET /api/central/mobilizacoes?ocorrenciaId=&equipeId=&status=` | |
| `POST /api/central/mobilizacoes` | |
| `PATCH /api/central/mobilizacoes/:id` | |
| `GET /api/central/ocorrencias/:id/anexos` | metadados (binário em armazenamento externo) |
| `POST /api/central/ocorrencias/:id/anexos` | |

**Atenção:** a autenticação foi removida da Central a pedido do supervisor. Dados restritos (LGPD) permanecem ocultos nas respostas públicas, mas as demais informações operacionais e de danos são acessíveis publicamente. Escopo por organização/município não é mais aplicado.

- Produção sem config completa → **503** com `detalhes` (ver `validateProductionConfig`).
- Persistência: coleções do store (`system_config` id-chaveado funciona em file/memory/kv/**pg**); `audit_logs` para trilhas.
- Jobs contínuos só no `server.js` persistente (`waze/tomtom startJob`); na Vercel use agendador externo (`POST ...?action=sync`, workflow `alertas-cron.yml`).
- `GET /` (raiz) não é API; `sw.js` tem rota explícita no `server.js`.
