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

## Fase 3: autenticação, escopo e convites

A migração `000000000002_rbac_mfa_rls.sql` habilita RLS forçada nas tabelas
organizacionais e de acesso que ela protege, cria persistência de MFA e convites
e adiciona o vínculo organizacional e o papel às solicitações de cadastro. O
backend estabelece o escopo por transação PostgreSQL. As rotas de solicitação
de cadastro validam a organização e a análise pelo nível imediatamente superior.
As coleções legadas ainda precisam ser migradas e ligadas às novas tabelas antes
de todo o conjunto de endpoints operacionais herdar o mesmo escopo.

Papéis de coordenação e administração exigem TOTP. Em produção com login
habilitado, configure `MFA_ENCRYPTION_KEY` como 64 caracteres hexadecimais
(32 bytes) em variável de ambiente do servidor. Gere e guarde esse segredo
fora do repositório, por exemplo com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
Não reutilize a chave JWT. Perder ou trocar a chave impede a descriptografia
dos autenticadores registrados; faça rotação coordenada e redefina o MFA dos
usuários afetados.

Organizações autorizadas emitem convites de uso único vinculados ao papel e
e-mail, com validade de sete dias. O token aparece apenas na emissão; compartilhe
por canal institucional e não o grave em tickets ou logs. O cadastro público
exige esse convite quando usa PostgreSQL. O código IBGE do município e a UF
precisam corresponder à organização do convite.

Antes de migrar, valide a execução em banco/branch de desenvolvimento e
confirme suporte a PostGIS. `npm run db:migrate` aplica também a migração da
Fase 3; não execute contra produção sem aprovação e backup. Esta entrega não
migra dados reais nem verifica RLS em um banco remoto, e o fluxo de autenticação
gov.br permanece pendente.
