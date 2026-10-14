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
| `GET /api/alertas[?inmet=0]` | alertas curados + INMET ao vivo | RSS INMET (10s timeout) |
| `GET /api/areas` | áreas desenhadas | store |
| `GET /api/occurrences[?source=&type=&priority=&status=&period=][?view=map\|stats\|waze]` | ocorrências (coords arredondadas) | store |
| `GET /api/occurrences/:id` | detalhe (404 se ausente) | store |
| `GET /api/reports` | reportes públicos | store |
| `GET /api/proxy?url=` | proxy CORS genérico; `X-Fonte/X-Upstream-*`, `X-Stale` em fallback | origem externa; `s-maxage` por fonte (ver `api/_lib/origens.js`); allowlist `PROXY_HOSTS` |
| `GET /api/fontes` ou `/api/fontes/saude` | saúde das 22 fontes (ok/lento/fora, último sucesso/falha, latência) | `system_config` (`fonte-saude`) |
| `GET /api/barragens?uf=&bbox=&limit=&offset=` | SNISB normalizado (+`parcial`) | ArcGIS REST SNISB; `s-maxage=24h` |
| `GET /api/avisos` / `?id=` | RSS nacional / detalhe CAP+polígono | INMET; `s-maxage` 10min/1h |
| `GET /api/areas-monitoradas` | áreas + regras | store |
| `GET /api/alertas-motor/eventos?uf=&tipo=&desde=&limit=` | fila de eventos (novos primeiro) | store |
| `GET /api/push/config` | `{ativo, vapidPublicKey\|null}` | env |
| `GET /api/gestao?municipio=` / `?visao=geral` | gestão municipal / panorama 142 municípios | store (+`MUNICIPIOS_MT`) |
| `GET /api/noticias[?q=][?n=]` | RSS Google Notícias filtrado | Google (sem chave) |
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

## Notas operacionais

- Produção sem config completa → **503** com `detalhes` (ver `validateProductionConfig`).
- Persistência: coleções do store (`system_config` id-chaveado funciona em file/memory/kv/**pg**); `audit_logs` para trilhas.
- Jobs contínuos só no `server.js` persistente (`waze/tomtom startJob`); na Vercel use agendador externo (`POST ...?action=sync`, workflow `alertas-cron.yml`).
- `GET /` (raiz) não é API; `sw.js` tem rota explícita no `server.js`.
