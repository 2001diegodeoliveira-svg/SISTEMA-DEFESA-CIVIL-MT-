-- Central de Ocorrências de Defesa Civil (Fase 1).
-- Evolui a tabela `ocorrencias` criada na migração 001 (escopo organizacional,
-- PostGIS e histórico por trigger) em vez de criar um modelo paralelo.
--
-- Requer PostgreSQL >= 12 (ALTER TYPE ... ADD VALUE dentro de transação, sem
-- uso do valor novo no mesmo arquivo). O executor aplica este arquivo em uma
-- transação única.

-- ---------------------------------------------------------------------------
-- 1. Domínios novos
-- ---------------------------------------------------------------------------

CREATE TYPE ocorrencia_prioridade AS ENUM ('BAIXA', 'MODERADA', 'ALTA', 'CRITICA');

-- Distingue alerta/previsão de ocorrência efetivamente relatada ou confirmada.
CREATE TYPE ocorrencia_verificacao AS ENUM ('ALERTA', 'SUSPEITA', 'RELATADA', 'CONFIRMADA');

CREATE TYPE mobilizacao_status AS ENUM (
  'mobilizada', 'em_deslocamento', 'no_local', 'retornando', 'encerrada'
);

-- Situação operacional (9 estados do fluxo da Central). Os valores legados
-- 'em_atendimento' e 'escalada' permanecem aceitos para leitura de registros
-- antigos, mas não são usados na criação de novas ocorrências.
ALTER TYPE ocorrencia_status RENAME VALUE 'aberta' TO 'registrada';
ALTER TYPE ocorrencia_status RENAME VALUE 'apoio_solicitado' TO 'aguardando_mobilizacao';
ALTER TYPE ocorrencia_status RENAME VALUE 'encerrada' TO 'concluida';
ALTER TYPE ocorrencia_status ADD VALUE IF NOT EXISTS 'em_triagem';
ALTER TYPE ocorrencia_status ADD VALUE IF NOT EXISTS 'em_avaliacao';
ALTER TYPE ocorrencia_status ADD VALUE IF NOT EXISTS 'equipe_mobilizada';
ALTER TYPE ocorrencia_status ADD VALUE IF NOT EXISTS 'monitoramento';
ALTER TYPE ocorrencia_status ADD VALUE IF NOT EXISTS 'arquivada';

ALTER TABLE ocorrencias ALTER COLUMN status SET DEFAULT 'registrada';

-- ---------------------------------------------------------------------------
-- 2. Catálogo de tipos (editável sem alterar código-fonte)
-- ---------------------------------------------------------------------------

CREATE TABLE tipos_ocorrencia (
  codigo     TEXT PRIMARY KEY CHECK (codigo ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  nome       TEXT NOT NULL UNIQUE CHECK (length(trim(nome)) BETWEEN 3 AND 120),
  grupo      TEXT NOT NULL DEFAULT 'outros'
             CHECK (grupo IN ('hidrologico', 'geologico', 'meteorologico', 'biologico',
                              'tecnologico', 'estrutural', 'outros')),
  descricao  TEXT NOT NULL DEFAULT '',
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  ordem      INTEGER NOT NULL DEFAULT 100,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tipos_ocorrencia (codigo, nome, grupo, ordem) VALUES
  ('ALAGAMENTO',          'Alagamento',              'hidrologico',   10),
  ('INUNDACAO',           'Inundação',               'hidrologico',   20),
  ('ENXURRADA',           'Enxurrada',               'hidrologico',   30),
  ('DESLIZAMENTO',        'Deslizamento',            'geologico',     40),
  ('DESMORONAMENTO',      'Desmoronamento',          'geologico',     50),
  ('VENDAVAL',            'Vendaval',                'meteorologico', 60),
  ('TEMPESTADE_SEVERA',   'Tempestade severa',       'meteorologico', 70),
  ('GRANIZO',             'Granizo',                 'meteorologico', 80),
  ('ESTIAGEM',            'Estiagem',                'meteorologico', 90),
  ('SECA',                'Seca',                    'meteorologico', 100),
  ('INCENDIO_FLORESTAL',  'Incêndio florestal',      'biologico',     110),
  ('QUEIMADA',            'Queimada',                'biologico',     120),
  ('ROMPIMENTO_ESTRUTURA','Rompimento de estrutura', 'tecnologico',   130),
  ('QUEDA_ARVORE',        'Queda de árvore',         'outros',        140),
  ('DANOS_ESTRUTURAIS',   'Danos estruturais',       'estrutural',    150),
  ('EROSAO',              'Erosão',                  'geologico',     160),
  ('OUTROS',              'Outros eventos adversos', 'outros',        999)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Campos operacionais da ocorrência
-- ---------------------------------------------------------------------------

ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS protocolo TEXT;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prioridade ocorrencia_prioridade;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prioridade_sugerida ocorrencia_prioridade;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prioridade_sugerida_motivos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prioridade_revisada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS prioridade_revisada_em TIMESTAMPTZ;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS verificacao ocorrencia_verificacao NOT NULL DEFAULT 'RELATADA';
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS municipio_id INTEGER REFERENCES municipios(id) ON DELETE SET NULL;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS bairro TEXT;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS causa_provavel TEXT;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS condicoes_meteorologicas JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS pessoas_afetadas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS necessidades TEXT;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS fonte TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS origem_alerta_id UUID REFERENCES alertas(id) ON DELETE SET NULL;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS responsavel_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE ocorrencias ADD COLUMN IF NOT EXISTS atualizada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE ocorrencias ADD CONSTRAINT ocorrencias_pessoas_afetadas_check
  CHECK (pessoas_afetadas >= 0) NOT VALID;

-- O catálogo é a fonte da verdade do tipo. NOT VALID preserva eventuais
-- registros legados fora do catálogo, mas exige o código em novas gravações.
ALTER TABLE ocorrencias ADD CONSTRAINT ocorrencias_tipo_catalogo_fk
  FOREIGN KEY (tipo) REFERENCES tipos_ocorrencia(codigo) NOT VALID;

CREATE UNIQUE INDEX ocorrencias_protocolo_unique
  ON ocorrencias (protocolo) WHERE protocolo IS NOT NULL;
CREATE INDEX ocorrencias_org_status_criada_idx
  ON ocorrencias (organizacao_id, status, criada_em DESC);
CREATE INDEX ocorrencias_prioridade_idx
  ON ocorrencias (prioridade) WHERE prioridade IS NOT NULL;
CREATE INDEX ocorrencias_municipio_idx
  ON ocorrencias (municipio_id, criada_em DESC);

-- ---------------------------------------------------------------------------
-- 4. Protocolo sequencial por ano
-- ---------------------------------------------------------------------------

CREATE TABLE ocorrencia_protocolos (
  ano    INTEGER PRIMARY KEY CHECK (ano BETWEEN 2000 AND 2200),
  ultimo INTEGER NOT NULL DEFAULT 0 CHECK (ultimo >= 0)
);

CREATE OR REPLACE FUNCTION proximo_protocolo_ocorrencia(p_ano INTEGER)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  INSERT INTO ocorrencia_protocolos (ano, ultimo)
  VALUES (p_ano, 1)
  ON CONFLICT (ano) DO UPDATE SET ultimo = ocorrencia_protocolos.ultimo + 1
  RETURNING ultimo INTO n;
  RETURN 'OC-' || p_ano::text || '-' || lpad(n::text, 6, '0');
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Avaliação de danos (humano, material e econômico no mesmo registro)
-- ---------------------------------------------------------------------------

CREATE TABLE ocorrencia_danos (
  ocorrencia_id           UUID PRIMARY KEY REFERENCES ocorrencias(id) ON DELETE CASCADE,
  residencias_atingidas   INTEGER NOT NULL DEFAULT 0 CHECK (residencias_atingidas >= 0),
  edificacoes_danificadas INTEGER NOT NULL DEFAULT 0 CHECK (edificacoes_danificadas >= 0),
  infraestrutura_publica  INTEGER NOT NULL DEFAULT 0 CHECK (infraestrutura_publica >= 0),
  pontes_estradas         INTEGER NOT NULL DEFAULT 0 CHECK (pontes_estradas >= 0),
  equipamentos_publicos   INTEGER NOT NULL DEFAULT 0 CHECK (equipamentos_publicos >= 0),
  agricultura_pecuaria    INTEGER NOT NULL DEFAULT 0 CHECK (agricultura_pecuaria >= 0),
  pessoas_afetadas        INTEGER NOT NULL DEFAULT 0 CHECK (pessoas_afetadas >= 0),
  pessoas_feridas         INTEGER NOT NULL DEFAULT 0 CHECK (pessoas_feridas >= 0),
  obitos                  INTEGER NOT NULL DEFAULT 0 CHECK (obitos >= 0),
  desabrigados            INTEGER NOT NULL DEFAULT 0 CHECK (desabrigados >= 0),
  desalojados             INTEGER NOT NULL DEFAULT 0 CHECK (desalojados >= 0),
  prejuizo_estimado       NUMERIC(14, 2) CHECK (prejuizo_estimado >= 0),
  observacoes             TEXT NOT NULL DEFAULT '',
  atualizado_em           TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- 6. Equipes e mobilizações
-- ---------------------------------------------------------------------------

CREATE TABLE equipes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  territorio_id  TEXT REFERENCES territorios(id),
  nome           TEXT NOT NULL CHECK (length(trim(nome)) BETWEEN 3 AND 120),
  tipo           TEXT NOT NULL DEFAULT 'operacional',
  responsavel    TEXT NOT NULL DEFAULT '',
  contato        TEXT,
  ativa          BOOLEAN NOT NULL DEFAULT TRUE,
  criada_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criada_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX equipes_org_ativa_idx ON equipes (organizacao_id, ativa, nome);

CREATE TABLE equipe_mobilizacoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  equipe_id       UUID NOT NULL REFERENCES equipes(id) ON DELETE CASCADE,
  ocorrencia_id   UUID NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  organizacao_id  TEXT NOT NULL REFERENCES organizacoes(id),
  status          mobilizacao_status NOT NULL DEFAULT 'mobilizada',
  mobilizada_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  chegada_em      TIMESTAMPTZ,
  encerrada_em    TIMESTAMPTZ,
  atividades      TEXT NOT NULL DEFAULT '',
  recursos        JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizada_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  CHECK (chegada_em IS NULL OR chegada_em >= mobilizada_em),
  CHECK (encerrada_em IS NULL OR encerrada_em >= mobilizada_em)
);
CREATE INDEX equipe_mobilizacoes_ocorrencia_idx
  ON equipe_mobilizacoes (ocorrencia_id, mobilizada_em DESC);
CREATE INDEX equipe_mobilizacoes_org_status_idx
  ON equipe_mobilizacoes (organizacao_id, status);

-- ---------------------------------------------------------------------------
-- 7. Anexos (metadados; o binário fica em armazenamento externo)
-- ---------------------------------------------------------------------------

CREATE TABLE ocorrencia_anexos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ocorrencia_id UUID NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL CHECK (length(trim(nome)) BETWEEN 1 AND 200),
  mime_type     TEXT NOT NULL,
  tamanho_bytes BIGINT CHECK (tamanho_bytes IS NULL OR tamanho_bytes >= 0),
  url           TEXT NOT NULL,
  hash_sha256   TEXT,
  criado_por    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ocorrencia_anexos_ocorrencia_idx ON ocorrencia_anexos (ocorrencia_id, criado_em);

-- ---------------------------------------------------------------------------
-- 8. Histórico com justificativa
-- ---------------------------------------------------------------------------

-- A justificativa da mudança de situação é transportada por
-- app.historico_nota (set_config local à transação), mantendo a trilha
-- automática criada na migração 001.
CREATE OR REPLACE FUNCTION registrar_historico_status_ocorrencia()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ocorrencia_historico (ocorrencia_id, status_novo, usuario_id, nota)
    VALUES (
      NEW.id,
      NEW.status,
      NULLIF(current_setting('app.user_id', TRUE), '')::integer,
      NULLIF(current_setting('app.historico_nota', TRUE), '')
    );
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO ocorrencia_historico (
      ocorrencia_id, status_anterior, status_novo, usuario_id, nota
    ) VALUES (
      NEW.id, OLD.status, NEW.status,
      NULLIF(current_setting('app.user_id', TRUE), '')::integer,
      NULLIF(current_setting('app.historico_nota', TRUE), '')
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. RLS das novas tabelas
-- ---------------------------------------------------------------------------

ALTER TABLE tipos_ocorrencia ENABLE ROW LEVEL SECURITY;
ALTER TABLE tipos_ocorrencia FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app_can_manage_catalogo()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    app_is_service()
    OR EXISTS (
      SELECT 1 FROM usuarios u
      WHERE u.id = NULLIF(current_setting('app.user_id', TRUE), '')::integer
        AND u.ativo
        AND u.perfil IN ('admin', 'avancado')
    )
    OR EXISTS (
      SELECT 1 FROM usuario_organizacao_papel p
      WHERE p.usuario_id = NULLIF(current_setting('app.user_id', TRUE), '')::integer
        AND p.ativo
        AND p.papel_codigo IN ('administrador_orgao', 'coordenador', 'analista')
    ),
    FALSE
  );
$$;

CREATE POLICY tipos_ocorrencia_read ON tipos_ocorrencia
  FOR SELECT USING (TRUE);
CREATE POLICY tipos_ocorrencia_write ON tipos_ocorrencia
  FOR ALL USING (app_can_manage_catalogo())
  WITH CHECK (app_can_manage_catalogo());

ALTER TABLE ocorrencia_danos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocorrencia_danos FORCE ROW LEVEL SECURITY;
CREATE POLICY ocorrencia_danos_select ON ocorrencia_danos
  FOR SELECT USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_danos.ocorrencia_id AND app_has_org_scope(o.organizacao_id)
    )
  );
CREATE POLICY ocorrencia_danos_write ON ocorrencia_danos
  FOR ALL USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_danos.ocorrencia_id AND app_can_write_org(o.organizacao_id)
    )
  )
  WITH CHECK (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_danos.ocorrencia_id AND app_can_write_org(o.organizacao_id)
    )
  );

ALTER TABLE equipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipes FORCE ROW LEVEL SECURITY;
CREATE POLICY equipes_scope_read ON equipes
  FOR SELECT USING (app_is_service() OR app_has_org_scope(organizacao_id));
CREATE POLICY equipes_scope_insert ON equipes
  FOR INSERT WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY equipes_scope_update ON equipes
  FOR UPDATE USING (app_is_service() OR app_can_write_org(organizacao_id))
  WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY equipes_scope_delete ON equipes
  FOR DELETE USING (app_is_service() OR app_can_write_org(organizacao_id));

ALTER TABLE equipe_mobilizacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipe_mobilizacoes FORCE ROW LEVEL SECURITY;
CREATE POLICY equipe_mobilizacoes_scope_read ON equipe_mobilizacoes
  FOR SELECT USING (app_is_service() OR app_has_org_scope(organizacao_id));
CREATE POLICY equipe_mobilizacoes_scope_insert ON equipe_mobilizacoes
  FOR INSERT WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY equipe_mobilizacoes_scope_update ON equipe_mobilizacoes
  FOR UPDATE USING (app_is_service() OR app_can_write_org(organizacao_id))
  WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY equipe_mobilizacoes_scope_delete ON equipe_mobilizacoes
  FOR DELETE USING (app_is_service() OR app_can_write_org(organizacao_id));

ALTER TABLE ocorrencia_anexos ENABLE ROW LEVEL SECURITY;
ALTER TABLE ocorrencia_anexos FORCE ROW LEVEL SECURITY;
CREATE POLICY ocorrencia_anexos_select ON ocorrencia_anexos
  FOR SELECT USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_anexos.ocorrencia_id AND app_has_org_scope(o.organizacao_id)
    )
  );
CREATE POLICY ocorrencia_anexos_write ON ocorrencia_anexos
  FOR ALL USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_anexos.ocorrencia_id AND app_can_write_org(o.organizacao_id)
    )
  )
  WITH CHECK (
    app_is_service() OR EXISTS (
      SELECT 1 FROM ocorrencias o
      WHERE o.id = ocorrencia_anexos.ocorrencia_id AND app_can_write_org(o.organizacao_id)
    )
  );
