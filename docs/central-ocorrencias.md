# Central de Ocorrências de Defesa Civil (Etapa 1)

## Decisões de arquitetura

- **Reaproveita a tabela `ocorrencias`** (migração 001): escopo organizacional, PostGIS, RLS e histórico por trigger.
  Não foi criado um modelo paralelo (evita duplicação).
- **Frontend permanece HTML/JS vanilla** no padrão do repositório
  (`central-ocorrencias.html` + `js/central.js`), com o tema institucional do painel.
  A preferência por React/Next do prompt foi descartada por ser uma reescrita
  completa sem justificativa técnica (AGENTS.md §"Arquitetura").
- **Autenticação removida** da Central a pedido do supervisor: rotas públicas,
  execução como service (RLS bypassada) para a Central. Dados restritos (LGPD)
  permanecem ocultos nas respostas públicas.

## Entregue nesta etapa

1. **Banco (migração `000000000003_central_ocorrencias.sql`)**:
   - catálogo editável `tipos_ocorrencia` (17 tipos iniciais);
   - campos operacionais em `ocorrencias` (protocolo, prioridade BAIXA/MODERADA/ALTA/CRÍTICA,
     verificação ALERTA/SUSPEITA/RELATADA/CONFIRMADA, município, endereço, causa, clima,
     pessoas afetadas, necessidades, fonte, alerta de origem, responsável);
   - 9 estados operacionais (registrada, em triagem, em avaliação, aguardando mobilização,
     equipe mobilizada, em atendimento, monitoramento, concluída, arquivada) — valores
     legados permanecem legíveis;
   - `ocorrencia_danos`, `equipes`, `equipe_mobilizacoes`, `ocorrencia_anexos`,
     `ocorrencia_protocolos` + função `proximo_protocolo_ocorrencia`;
   - RLS nas novas tabelas; histórico com justificativa via `app.historico_nota`;
   - prioridade sugerida por heurística determinística (nunca afirma dano sem evidência).
2. **API `/api/central/*`** (rotas listadas em `docs/APIs.md`).
3. **Tela operacional** `central-ocorrencias.html`: KPIs, filtros, tabela, detalhe com
   danos/histórico, ações, mapa Leaflet, gráficos, formulário de cadastro, anexos,
   mobilização de equipes, login com MFA.
4. **Testes** `test/central-ocorrencias.test.js` (3 cenários, 15+ asserções) e
   `test/database-migrations.test.js` atualizado.

## Pendências (etapas seguintes)

- Armazenamento binário de fotografias (hoje apenas metadados + URL).
- Integração automática com alertas meteorológicos (sugestão preventiva, sem criar
  ocorrência confirmada).
- Assistente de IA real (hoje a sugestão é heurística determinística).
- Relatórios PDF/Excel e exportação.
- Mapas de camadas meteorológicas/hidrológicas na Central.
- Testes end-to-end no navegador (aqui validado por console limpo em
  `http://localhost:3000/central-ocorrencias.html`).
- Validação em PostgreSQL/Neon (migração não aplicada: sem `DATABASE_URL` local).
