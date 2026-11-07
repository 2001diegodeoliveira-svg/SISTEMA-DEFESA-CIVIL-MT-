# Incidentes e auditorias — Supervisor Técnico

## INC-001 — Escrita pública em `/api/gestao` (CRÍTICO) — 2026-11-06

**Status:** RESOLVIDO. Correção publicada em `origin/main` no commit `a9aaf11`
(`api/_routes/gestao.js` + `api/_lib/access-control.js`).

### Evidência
- Commit `cad612d` ("ATT", autor `2001diegodeoliveira-svg`, 2026-11-05 21:39 -04), merged e
  publicado em `295db8f` (`origin/main`).
- `api/_routes/gestao.js:146` (no commit): `const podeEscrever = async () => ({ ok: true, munVinculado: null });`
- `api/_lib/access-control.js`: `'gestao'` removido de `PRIVATE_API_ROUTES` e sem política
  explícita em `apiPolicy()`, logo `POST/PUT/DELETE` caíam no default público.
- Contrato violado: `docs/APIs.md:53` exige “municipal no próprio município+ / RBAC por município”.
- Teste ajustado em `test/auth-suspended.test.js:69-79`: `GET` passou a esperar `200` e o `POST`
  continuou passando apenas porque o lockout global de manutenção bloqueia qualquer não-GET.
  Ou seja, o teste não provava proteção da escrita.

### Impacto
Qualquer pessoa, sem token, podia criar/alterar/excluir itens de `areasDeRisco`, `plancon`,
`coordenadores`, `voluntarios`, `inventario`, `rotasFuga`, `viaturas`, `equipeAtual`, `sede`,
`alojamento` de qualquer município.

### Correção aplicada
- `api/_lib/access-control.js`: política explícita — `GET` público, escrita restrita a `WRITE_ROLES`.
- `api/_routes/gestao.js`: restaurado `podeEscrever` com `isLoginEnabled`/`isSessaoLiberada`,
  exigência de `perfil === 'municipal'` e vínculo ao próprio município.
- Evidência: `npm test` → 110/110 passando (16/11/2026).
- Evidência direcionada (handler real, `AUTH_SUSPENDED=false`, `DEMO_HORAS=0`):
  - `POST /api/gestao` anônimo → `401 {"erro":"Autenticação necessária."}`
  - `DELETE /api/gestao` anônimo → `401`
  - `GET /api/gestao?municipio=...` → `200` (leitura pública preservada)

### Verificação no remoto (2026-11-07)
- `git show a9aaf11:api/_routes/gestao.js` → contém `isLoginEnabled`/`isSessaoLiberada` e
  `podeEscrever` autenticado.
- `git show a9aaf11:api/_lib/access-control.js` → contém a política explícita de `gestao`.
- `origin/main` = `a9aaf11`, portanto a escrita pública não está mais no remoto.

### Pendência
Apenas confirmar o deploy (Vercel) do commit `a9aaf11`. Não verificável apenas com o repositório.

---

## INC-002 — Páginas removidas com links ativos (ALTO)

`gestao.html` e `painel.html` foram removidos em `cad612d`, mas continuam referenciados:

| Arquivo | Referência |
|---|---|
| `index.html:859` | `gestao.html` |
| `alertas.html:361-362` | `painel.html`, `gestao.html` |
| `amazonia.html:187-188` | `painel.html`, `gestao.html` |
| `el-nino.html:245-246` | `painel.html`, `gestao.html` |
| `mapa.html:1315` | `painel.html` |

Agravantes:
- `api/_lib/access-control.js:4` ainda lista `painel.html` em `INTERNAL_PAGES`.
- `js/gestao.js` (42 KB) segue versionado e foi modificado em `cad612d`, mas nenhum HTML o carrega.

**Decisão necessária:** restaurar as páginas ou remover todos os links + entrada de acesso + script órfão.

---

## INC-003 — Artefatos versionados (ALTO)

- `contratos.html.html` (257 KB, duplicado) — versionado.
- `server.js.bak` — versionado.
- `__test_mapa.html`, `__test_mapa2.html`, `__test_mapa3.html` — entraram em `cad612d` e estão
  com remoção staged no momento deste registro.

**Ação:** remover do índice e do histórico se necessário; não commitar novamente.

---

## Gate automático ativo

- `npm run audit:guard` — working tree.
- `npm run audit:guard:staged` — stage (hook `pre-commit`).
- `npm run audit:watch` — vigilância a cada 15 s, log em `%TEMP%\opencode\supervisor\alerts.log`.
- `core.hooksPath = .githooks`.
- Regras de estado rodam mesmo sem diff, então regressão já commitada continua bloqueando push.

### Limite conhecido
`git commit --no-verify` e `SUPERVISOR_BYPASS="..."` ignoram o gate. Uso exige justificativa
registrada; qualquer bypass deve ser reportado ao supervisor.
