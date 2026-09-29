-- ============================================================
-- Schema PostgreSQL — Sistema Defesa Civil MT (Neon)
-- Idempotente: pode ser executado repetidamente.
-- Uso:  psql "$DATABASE_URL" -f db/schema.sql
--       (ou: node db/migrate.js  — aplica este arquivo + migra os JSONs)
-- ============================================================

BEGIN;

-- ---------------- ENUMs ----------------
DO $$ BEGIN
  CREATE TYPE perfil_usuario AS ENUM ('admin','avancado','municipal','comum');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tipo_ocorrencia AS ENUM
    ('ACIDENTE','ENGARRAFAMENTO','PERIGO','CLIMA','INTERDICAO','OBRA','OUTROS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE prioridade_ocorrencia AS ENUM ('BAIXA','MEDIA','ALTA','CRITICA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE status_ocorrencia AS ENUM
    ('NOVA','EM_ANALISE','EM_ATENDIMENTO','ENCAMINHADA','RESOLVIDA','ENCERRADA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE secao_gestao AS ENUM
    ('areasDeRisco','plancon','coordenadores','voluntarios','inventario','rotasFuga',
     'viaturas','rastreadorRadio','equipeAtual','sede','alojamento');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------- Tabelas ----------------

-- Dimensão: os 142 municípios de MT (estado 51). Semanticamente é a chave
-- que amarra gestão, usuários municipais e ocorrências a uma cidade única.
CREATE TABLE IF NOT EXISTS municipios (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL UNIQUE,
  codigo_ibge TEXT,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Usuários espelham o seed antigo (admin/avancado/municipal/comum) + auto-provisão.
CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  usuario     TEXT NOT NULL UNIQUE,
  senha_hash  TEXT NOT NULL,
  nome        TEXT NOT NULL DEFAULT '',
  perfil      perfil_usuario NOT NULL DEFAULT 'comum',
  municipio_id INTEGER REFERENCES municipios(id),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  cadastro_id TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cadastro_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usuarios_municipio ON usuarios(municipio_id);

-- Solicitações de acesso enviadas pelo cadastro público. A senha fica somente
-- como hash e só vira conta em usuarios após aprovação administrativa.
CREATE TABLE IF NOT EXISTS solicitacoes_usuarios (
  id             TEXT PRIMARY KEY,
  usuario        TEXT NOT NULL,
  senha_hash     TEXT NOT NULL,
  email          TEXT NOT NULL,
  cpf            TEXT NOT NULL,
  dados          JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Pendente'
                 CHECK (status IN ('Pendente','Aprovado','Recusado')),
  situacao       TEXT NOT NULL DEFAULT 'Ativo'
                 CHECK (situacao IN ('Ativo','Inativo')),
  parecer        TEXT NOT NULL DEFAULT '',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  avaliado_em    TIMESTAMPTZ,
  avaliado_por   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitacoes_usuario_ativo
  ON solicitacoes_usuarios (lower(usuario)) WHERE status <> 'Recusado';
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitacoes_email_ativo
  ON solicitacoes_usuarios (lower(email)) WHERE status <> 'Recusado';
CREATE UNIQUE INDEX IF NOT EXISTS uq_solicitacoes_cpf_ativo
  ON solicitacoes_usuarios (cpf) WHERE status <> 'Recusado';
CREATE INDEX IF NOT EXISTS idx_solicitacoes_status_criado
  ON solicitacoes_usuarios (status, criado_em DESC);
DO $$ BEGIN
  ALTER TABLE usuarios ADD CONSTRAINT fk_usuarios_cadastro
    FOREIGN KEY (cadastro_id) REFERENCES solicitacoes_usuarios(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_cadastro ON usuarios(cadastro_id) WHERE cadastro_id IS NOT NULL;

-- Ocorrências da Integração Waze. id preserva o formato antigo
-- "<SOURCE>-<externalId>" para continuidade com a API atual.
CREATE TABLE IF NOT EXISTS occurrences (
  id          TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'WAZE',
  type        tipo_ocorrencia NOT NULL,
  subtype     TEXT,
  description TEXT NOT NULL DEFAULT '',
  latitude    DOUBLE PRECISION,
  longitude   DOUBLE PRECISION,
  street      TEXT,
  city        TEXT,
  state       TEXT,
  country     TEXT,
  direction   TEXT,
  magnitude   NUMERIC,
  reliability NUMERIC,
  confidence  NUMERIC,
  reported_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  status      status_ocorrencia NOT NULL DEFAULT 'NOVA',
  priority    prioridade_ocorrencia,
  raw_data    JSONB,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_occurrences_reported ON occurrences(reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_occurrences_status   ON occurrences(status);
CREATE INDEX IF NOT EXISTS idx_occurrences_priority ON occurrences(priority);
CREATE INDEX IF NOT EXISTS idx_occurrences_source   ON occurrences(source);
CREATE INDEX IF NOT EXISTS idx_occurrences_city     ON occurrences(city);

-- Reportes manuais (público pode ler; criação requer autenticação).
CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',
  location    TEXT NOT NULL,
  description TEXT NOT NULL,
  reporter    TEXT NOT NULL DEFAULT 'Anônimo',
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  authored_by INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);

-- Áreas de interesse desenhadas no mapa (polígono em coords).
CREATE TABLE IF NOT EXISTS areas (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  coords      JSONB NOT NULL,
  area_km2    NUMERIC,
  estacoes    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL,
  authored_by INTEGER REFERENCES usuarios(id)
);

-- Itens das 11 seções da Gestão por município. Os campos livres do item
-- viram JSONB (dado); id_origem é o id gerado pela aplicação (Date.now()).
CREATE TABLE IF NOT EXISTS gestao_itens (
  id             BIGSERIAL PRIMARY KEY,
  municipio_id   INTEGER NOT NULL REFERENCES municipios(id),
  secao          secao_gestao NOT NULL,
  id_origem      TEXT NOT NULL,
  dado           JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em      TIMESTAMPTZ,
  criado_por     TEXT,
  atualizado_em  TIMESTAMPTZ,
  atualizado_por TEXT,
  UNIQUE (municipio_id, secao, id_origem)
);
CREATE INDEX IF NOT EXISTS idx_gestao_itens_mun_sec ON gestao_itens(municipio_id, secao);

-- Metadados do documento de gestão por município (updatedAt do JSON original).
CREATE TABLE IF NOT EXISTS gestao_docs (
  municipio_id INTEGER PRIMARY KEY REFERENCES municipios(id),
  updated_at   TIMESTAMPTZ
);

-- Configuração do alerta de pluviômetro (linha única, id sempre 1).
CREATE TABLE IF NOT EXISTS pluv_alerta_config (
  id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  limite_mm   NUMERIC NOT NULL DEFAULT 100,
  percentual  NUMERIC NOT NULL DEFAULT 30,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ,
  updated_by  INTEGER REFERENCES usuarios(id)
);

-- Trilha de auditoria (ex.: ciclos de sincronização Waze).
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

COMMIT;