# Módulo ENOS / El Niño (Fase 1)

Monitoramento do El Niño–Oscilação Sul: classifica intensidade,
acompanha estado, avalia regras de alerta com histerese e
deduplicação, exige confirmação humana em níveis altos e mantém
trilha de auditoria completa. Interface em `el-nino.html`;
API em `/api/enso` e `/api/enso/avaliar`.

## Arquitetura

```
el-nino.html (UI: estado, níveis, fontes, auditoria)
  └─ GET /api/enso · POST /api/enso · POST /api/enso/avaliar
api/_routes/enso.js · api/_routes/enso-avaliar.js
api/_lib/enso.js (núcleo: classificar, avaliarRegras,
  registrarAlertas/confirmarAlerta, auditar, canais, coletores)
store → system_config (docs id-chaveados) + audit_logs
```

Persistência adaptada ao banco existente: nenhum DDL novo.
`system_config` (tabela `system_config` no PostgreSQL) guarda os
docs `enso-config`, `enso-regras`, `enso-estado`, `enso-alertas`,
`enso-indice`, `enso-fonte-status` e `enso-outbox`; a auditoria
vai para a coleção `audit_logs` (tabela `audit_logs` no pg).
Tabelas dedicadas (`enso_indice`, `enso_estado`, …) ficam para
fase futura, se o volume justificar.

## Configuração (tudo via ambiente; nada fixo no código)

| Variável | Padrão | Descrição |
|---|---|---|
| `ENSO_NEUTRO_BANDA` | `0.5` | Neutro se \|anomalia\| < banda |
| `ENSO_FRACO` / `MODERADO` / `FORTE` / `MUITO_FORTE` | `0.5/1.0/1.5/2.0` | Limiares de intensidade (°C, simétricos p/ La Niña) |
| `ENSO_HISTERESE` | `0.1` | Margem anti-ruído na saída de nível |
| `ENSO_REAVISO_HORAS` | `24` | Janela de deduplicação de envios |
| `ENSO_RULES_JSON` | (4 regras padrão) | Regras declarativas (ver abaixo) |
| `ENSO_DRY_RUN` | `1` | `1` = nenhum envio real (dev/teste); `0` + `ENSO_WEBHOOK_URL` = webhook real |
| `ENSO_WEBHOOK_URL` | vazio | Destino do canal webhook |
| `ENSO_EMAIL_DESTINO` | vazio | Destino padrão do canal e-mail (via outbox p/ MTA externo) |
| `ENSO_NOAA_ENABLED` | `1` | `0` desliga o coletor real (só MOCK) |
| `ENSO_NOAA_ONI_URL` | `https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt` | ONI (verificado ao vivo em 2026-10-11) |
| `ENSO_NOAA_SST_URL` | `https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices` | Niño 1+2/3/4/3.4 (verificado ao vivo em 2026-10-11) |
| `ENSO_COLETA_INTERVALO_MIN` | `10` | Intervalo mínimo entre coletas manuais (a coleta manual `POST /api/enso {acao:"coletar"}` **dispensa login**; o intervalo evita abuso contra a fonte oficial) |
| `ENSO_FONTE_STALE_HORAS` | `72` | Idade máxima de fonte saudável |
| `ENSO_FONTES_JSON` | (6 fontes oficiais) | Links exibidos na UI (configuráveis) |

Overrides persistentes (rota autenticada `POST /api/enso`
`{limiares, regras}`) valem sobre env; `DELETE /api/enso` limpa.

Regra declarativa:

```json
{ "id": "enso-alerta", "nivel": "ALERTA",
  "descricao": "Anomalia forte: preparar resposta.",
  "condicao": { "indice": "ONI", "operador": ">=", "limiarAbs": 1.5 },
  "exigeConfirmacao": true, "canais": ["email", "webhook"] }
```

Níveis: `OBSERVACAO → ATENCAO → ALERTA → EMERGENCIA`.
Níveis `ALERTA`/`EMERGENCIA` (ou regra com `exigeConfirmacao`)
criam alerta `PENDENTE` — sem envio externo até confirmação
humana (`POST /api/enso/avaliar {acao:"confirmar", alertaId}`).

## Canais

Interface: `canais = { email, webhook, telegram, sms, whatsapp }`.
`email` implementado como outbox (`enso-outbox` p/ MTA externo)
+ dry-run; `webhook` faz POST real com timeout quando
configurado; `telegram`/`sms`/`whatsapp` são stubs que retornam
erro explícito. Todo envio (ou tentativa) gera `alerta_envio`
em auditoria com regra, gatilho, canal, horário e resultado.

## Coletores

`executarColeta({usarMock})` roda cada coletor isolado
(try/catch por fonte), com retentativa + backoff + timeout, e
atualiza `fonte_status` (com flag `stale`). Upsert idempotente
por `(fonte, observadoEm)` (teto de 500 no doc `enso-indice`).
Coletor NOAA/CPC com URLs **verificadas ao vivo em 2026-10-11**:
`oni.ascii.txt` (linhas `SEAS YR TOTAL ANOM`; coleta os últimos
24 trimestres) e `sstoi.indices` (Niño 1+2/3/4/3.4 mensais;
coleta a última de cada região). `ENSO_NOAA_ENABLED=0` desliga o
coletor real. Sem dado real, o módulo opera com MOCK claramente
marcado (`mock: true`).

## Como adicionar um coletor

1. Crie `coletorX()` em `api/_lib/enso.js` retornando
   `{id, nome, coletar({timeoutMs})}` que resolve
   `{indice, valor, unidade, observadoEm, fonte, mock}`.
2. Inclua-o na lista de `executarColeta`.
3. Respeite robots/termos da fonte; sem credencial no código.
4. Adicione teste com mock em `test/enso.test.js`.

## Como adicionar um canal

1. Adicione `canalX()` em `canais` retornando
   `{ok, canal, ...}` e **nunca lançando**.
2. Liste-o nas regras (`canais: [...]`).
3. Em dry-run, apenas registre em log (não envie).
4. Adicione teste (seco + falha simulada).

## Fora do escopo (arquitetura preparada)

Impacto por município, CEMADEN/ANA/INMET/ONS, mapas, PDF,
assistente conversacional, IA, parser tabular NOAA e
transporte SMTP próprio (hoje: outbox p/ MTA externo).

## Produção

Defina `ENSO_WEBHOOK_URL`, `ENSO_EMAIL_DESTINO`,
`ENSO_DRY_RUN=0` e valide `ENSO_NOAA_ONI_URL` antes de ativar.
Sem webhook configurado, o módulo classifica e audita, mas
não envia nada para fora (falha segura).
