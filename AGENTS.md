# Regras obrigatórias do projeto (SGI PROTEGE)

Este arquivo vale para **todos os agentes** que trabalham neste repositório.
Ele não é sugestão: o descumprimento bloqueia o commit.

## 1. Fluxo de trabalho

1. Antes de editar, rode `git status` e `git diff` para ver o que outro agente já alterou.
   Nunca sobrescreva trabalho alheio sem investigar.
2. Faça mudanças pequenas e coesas. Não misture frentes diferentes no mesmo lote
   (ex.: refatorar mapa + alterar autorização de API + apagar páginas).
3. Antes de commitar, rode `npm run audit:guard`. O hook `pre-commit` executa a mesma
   verificação e bloqueia violações CRITICAL/HIGH.
4. Ao finalizar, informe: arquivos alterados, comandos executados, saída dos testes e
   o que **não** foi possível verificar. Afirmação sem evidência não conta.

## 2. Segurança (não negociável)

- **Nunca** remova autenticação, autorização ou escopo (RBAC) para fazer um teste passar
  ou para "facilitar" o front-end.
- `GET /api/gestao` é leitura pública. `POST/PUT/DELETE /api/gestao` exigem token de
  gestor municipal e só podem alterar o próprio município (ver `docs/APIs.md:53`).
- Não adicione `podeEscrever`/`podeEditar` que retornem `ok: true` incondicionalmente.
- Não coloque segredos, tokens, connection strings com senha ou chaves em código,
  logs, testes ou no repositório. `.env*` é proibido, exceto `.env.example` com placeholders.
- Não confie em dados de entrada: valide tipo, tamanho e faixa antes de persistir.
- Toda escrita em rota pública é vetor de abuso: exija autenticação ou limite explicitamente.

## 3. Testes

- **É proibido afrouxar teste para acomodar regressão.** Trocar `assert 401/403/503`
  por `assert 200` exige justificativa de requisito e aprovação do supervisor.
- Teste que passa por motivo errado não é evidência (ex.: escrita bloqueada pelo lockout
  global de manutenção, não pela regra da rota).
- Bug corrigido deve vir com teste de regressão que falha antes da correção.
- Mudança de front-end só é "verificada" com evidência de execução no navegador
  (screenshot, console, rede) ou teste automatizado equivalente.

## 4. Navegação e arquivos

- Não apague página HTML sem remover **todos** os links para ela (index, alertas,
  amazonia, el-nino, mapa, menus e `api/_lib/access-control.js`).
- Não commite `__test_*`, `*.html.html`, `*.bak`, `*.orig`, logs ou dumps.
- Código morto deve ser removido no mesmo commit que o tornou morto.

## 5. API e banco

- Respeite o contrato documentado em `docs/APIs.md`. Mudança de contrato atualiza o doc.
- Não introduza consulta N+1, `SELECT *` desnecessário ou migração destrutiva sem plano.
- Erros devem retornar status HTTP correto e corpo `{ erro }`, sem vazar stack/segredo.

## 6. Convivência entre agentes

- Um agente = uma frente. Se precisar tocar arquivo de outra frente, avise no resumo.
- Se encontrar alteração não commitada que você não fez, **não reverta**: registre e siga.
- Em caso de conflito de requisito, pare e pergunte ao supervisor antes de "decidir sozinho".

## 7. Gate automático

- `npm run audit:guard` → audita o working tree.
- `npm run audit:guard:staged` → audita o stage (usado pelo hook).
- `npm run audit:watch` → vigilância contínua (log em `%TEMP%\opencode\supervisor\alerts.log`).
- Bypass consciente: `SUPERVISOR_BYPASS="motivo" git commit ...`. Fica registrado no log.
