# Banco de dados e migrações

O SGI PROTEGE continua usando PostgreSQL com o driver `pg`. O schema legado
`db/schema.sql` permanece como bootstrap compatível com os fluxos existentes;
novas alterações estruturais devem ser acrescentadas como arquivos SQL
versionados em `db/migrations/`, sem editar migrações já aplicadas.

## Aplicação

1. Configure `DATABASE_URL` no ambiente local (ou em `.env`, nunca no frontend).
2. Crie uma branch/banco de desenvolvimento e faça backup antes de migrar.
3. Execute `npm run db:migrate`.

O comando aplica o schema legado, as migrações SQL ainda não registradas e
carrega os nomes e códigos IBGE da API oficial de localidades para o seed
nacional, as 27 UFs e os municípios de Mato Grosso. A máquina que executa o seed
precisa acessar `servicodados.ibge.gov.br`. Se a resposta estiver indisponível
ou inválida, uma execução usa somente o catálogo oficial completo previamente
gravado no banco e marca a fonte como desatualizada. Se ainda não houver esse
catálogo, o erro é explícito; a migração de schema poderá já estar registrada,
e uma nova execução tentará novamente o seed quando o IBGE estiver acessível.

`npm run db:migrate -- --schema-only` também aplica as migrações versionadas e
o seed organizacional, mas não importa as coleções JSON legadas.

O executor guarda versão e SHA-256 de cada arquivo em `schema_migrations`,
serializa execuções concorrentes e aplica cada arquivo em uma transação. Nunca
altere um arquivo já aplicado: crie outro com a próxima versão numérica de 12
dígitos (`000000000002_nome.sql`). Se o checksum divergir, o executor para com
erro em vez de aceitar a alteração silenciosamente.

O PostGIS é habilitado pela primeira migração com
`CREATE EXTENSION IF NOT EXISTS postgis`. A instalação precisa permitir essa
extensão. O seed inicial registra a origem IBGE, mas deixa explícito que seus
termos de redistribuição precisam ser confirmados antes de republicar os dados.

## Escopo desta migração

Inclui organizações, papéis/vínculos, territórios geográficos, ocorrências com
histórico automático de status, alertas e ciência, eventos, recursos,
solicitações de apoio, fontes de dados, câmeras e auditoria. O seed mantém as
27 UFs e cria organizações municipais apenas para MT; códigos de municípios
vêm da API oficial, não de nomes presumidos. Geometrias territoriais não são
carregadas por este seed.

RLS, autorização multi-organização nas rotas, MFA, ingestão periódica e cadastro
de fontes/câmeras não fazem parte desta etapa; permanecem para as fases
seguintes. O trigger de histórico reconhece o usuário da conexão quando o
backend definir `app.user_id`; até a integração de RBAC, o identificador pode
ficar nulo, sem perder o registro da mudança de status.
