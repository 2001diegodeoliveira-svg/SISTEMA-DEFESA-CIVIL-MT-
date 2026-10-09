-- Base multi-organizational data model. Subsequent structural changes get new versions.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE UNIQUE INDEX IF NOT EXISTS municipios_codigo_ibge_unique
  ON municipios (codigo_ibge)
  WHERE codigo_ibge IS NOT NULL;

CREATE TABLE organizacoes (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  sigla TEXT,
  nivel TEXT NOT NULL CHECK (nivel IN ('nacional', 'estadual', 'regional', 'municipal')),
  parent_id TEXT REFERENCES organizacoes(id),
  codigo_ibge TEXT,
  municipio_id INTEGER REFERENCES municipios(id),
  configuracao JSONB NOT NULL DEFAULT '{}'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (nivel = 'nacional' AND codigo_ibge IS NULL AND parent_id IS NULL) OR
    (nivel = 'estadual' AND codigo_ibge IS NOT NULL AND codigo_ibge ~ '^[0-9]{2}$') OR
    (nivel = 'regional' AND codigo_ibge IS NULL AND parent_id IS NOT NULL) OR
    (nivel = 'municipal' AND codigo_ibge IS NOT NULL AND codigo_ibge ~ '^[0-9]{7}$')
  )
);
CREATE UNIQUE INDEX organizacoes_codigo_ibge_unique
  ON organizacoes (codigo_ibge)
  WHERE codigo_ibge IS NOT NULL;
CREATE INDEX organizacoes_parent_idx ON organizacoes (parent_id);

CREATE TABLE papeis (
  codigo TEXT PRIMARY KEY CHECK (codigo IN (
    'administrador_orgao', 'coordenador', 'analista', 'operador_campo',
    'voluntario', 'leitura', 'publico'
  )),
  nome TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL DEFAULT ''
);

CREATE TABLE usuario_organizacao_papel (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id) ON DELETE CASCADE,
  papel_codigo TEXT NOT NULL REFERENCES papeis(codigo),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  concedido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  concedido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, organizacao_id, papel_codigo)
);
CREATE INDEX usuario_organizacao_papel_org_idx
  ON usuario_organizacao_papel (organizacao_id, papel_codigo)
  WHERE ativo;

CREATE TABLE territorios (
  id TEXT PRIMARY KEY,
  codigo_ibge TEXT UNIQUE,
  nome TEXT NOT NULL,
  nivel TEXT NOT NULL CHECK (nivel IN ('nacional', 'estadual', 'municipal')),
  parent_id TEXT REFERENCES territorios(id),
  organizacao_id TEXT REFERENCES organizacoes(id),
  limite geometry(MultiPolygon, 4326),
  propriedades JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX territorios_limite_gist ON territorios USING GIST (limite);
CREATE INDEX territorios_parent_idx ON territorios (parent_id);

CREATE TYPE ocorrencia_status AS ENUM (
  'aberta', 'em_atendimento', 'escalada', 'apoio_solicitado', 'encerrada'
);

CREATE TABLE ocorrencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  territorio_id TEXT REFERENCES territorios(id),
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL,
  status ocorrencia_status NOT NULL DEFAULT 'aberta',
  localizacao geometry(Point, 4326),
  dados_restritos JSONB NOT NULL DEFAULT '{}'::jsonb,
  criada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrada_em TIMESTAMPTZ
);
CREATE INDEX ocorrencias_org_status_idx ON ocorrencias (organizacao_id, status, criada_em DESC);
CREATE INDEX ocorrencias_localizacao_gist ON ocorrencias USING GIST (localizacao);

CREATE TABLE ocorrencia_historico (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ocorrencia_id UUID NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  status_anterior ocorrencia_status,
  status_novo ocorrencia_status NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  nota TEXT,
  alterado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ocorrencia_historico_ocorrencia_idx
  ON ocorrencia_historico (ocorrencia_id, alterado_em);

CREATE FUNCTION registrar_historico_status_ocorrencia()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ocorrencia_historico (ocorrencia_id, status_novo)
    VALUES (NEW.id, NEW.status);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO ocorrencia_historico (
      ocorrencia_id, status_anterior, status_novo, usuario_id
    ) VALUES (
      NEW.id, OLD.status, NEW.status,
      NULLIF(current_setting('app.user_id', TRUE), '')::integer
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ocorrencias_status_historico
  AFTER INSERT OR UPDATE OF status ON ocorrencias
  FOR EACH ROW EXECUTE FUNCTION registrar_historico_status_ocorrencia();

CREATE TABLE alertas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  identificador_cap TEXT UNIQUE,
  emissor TEXT,
  enviado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  inicio_vigencia TIMESTAMPTZ,
  fim_vigencia TIMESTAMPTZ,
  categoria TEXT,
  evento TEXT,
  urgencia TEXT,
  severidade TEXT,
  certeza TEXT,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  instrucao TEXT NOT NULL DEFAULT '',
  area geometry(MultiPolygon, 4326),
  dados_origem JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alertas_org_vigencia_idx ON alertas (organizacao_id, fim_vigencia);
CREATE INDEX alertas_area_gist ON alertas USING GIST (area);

CREATE TABLE alerta_territorios (
  alerta_id UUID NOT NULL REFERENCES alertas(id) ON DELETE CASCADE,
  territorio_id TEXT NOT NULL REFERENCES territorios(id),
  PRIMARY KEY (alerta_id, territorio_id)
);

CREATE TABLE alerta_ciente (
  alerta_id UUID NOT NULL REFERENCES alertas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  ciente_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  acao_tomada TEXT,
  PRIMARY KEY (alerta_id, usuario_id)
);

CREATE TABLE eventos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  territorio_id TEXT REFERENCES territorios(id),
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'encerrado')),
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrado_em TIMESTAMPTZ,
  relatorio JSONB,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE INDEX eventos_org_status_idx ON eventos (organizacao_id, status);

CREATE TABLE evento_participantes (
  evento_id UUID NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  participante_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  entrou_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (evento_id, organizacao_id)
);

CREATE TABLE eventos_diario_bordo (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento_id UUID NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  texto TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE recursos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  territorio_id TEXT REFERENCES territorios(id),
  tipo TEXT NOT NULL,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disponivel'
    CHECK (status IN ('disponivel', 'em_uso', 'compartilhavel')),
  visibilidade TEXT NOT NULL DEFAULT 'organizacao'
    CHECK (visibilidade IN ('organizacao', 'estado', 'publica')),
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
);
CREATE INDEX recursos_org_status_idx ON recursos (organizacao_id, status, tipo);

CREATE TABLE pedidos_apoio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_solicitante_id TEXT NOT NULL REFERENCES organizacoes(id),
  organizacao_destino_id TEXT REFERENCES organizacoes(id),
  territorio_id TEXT REFERENCES territorios(id),
  tipo_recurso TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  descricao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'aberto'
    CHECK (status IN ('aberto', 'aceito', 'recusado', 'atendido', 'cancelado')),
  solicitado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  solicitado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  respondido_em TIMESTAMPTZ
);
CREATE INDEX pedidos_apoio_org_status_idx
  ON pedidos_apoio (organizacao_solicitante_id, status, solicitado_em DESC);

CREATE TABLE fontes_dados (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  url TEXT,
  tipo_acesso TEXT NOT NULL DEFAULT 'api',
  licenca_termos TEXT,
  frequencia_segundos INTEGER CHECK (frequencia_segundos IS NULL OR frequencia_segundos > 0),
  nivel_minimo_acesso TEXT NOT NULL DEFAULT 'publico',
  ultima_leitura_valida TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('online', 'desatualizada', 'offline', 'pendente')),
  metadados JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizacao_id TEXT REFERENCES organizacoes(id),
  territorio_id TEXT REFERENCES territorios(id),
  fonte_id TEXT REFERENCES fontes_dados(id),
  nome TEXT NOT NULL,
  url TEXT NOT NULL,
  tipo_acesso TEXT NOT NULL CHECK (tipo_acesso IN ('api', 'iframe', 'snapshot', 'hls')),
  tipo TEXT NOT NULL DEFAULT 'outro',
  licenca_termos TEXT,
  responsavel_fonte TEXT,
  visibilidade TEXT NOT NULL DEFAULT 'publica'
    CHECK (visibilidade IN ('organizacao', 'estado', 'publica')),
  referencia_credencial TEXT,
  localizacao geometry(Point, 4326),
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('online', 'offline', 'pendente')),
  verificada_em TIMESTAMPTZ,
  metadados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criada_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX cameras_localizacao_gist ON cameras USING GIST (localizacao);
CREATE INDEX cameras_territorio_status_idx ON cameras (territorio_id, status);

CREATE TABLE auditoria_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  organizacao_id TEXT REFERENCES organizacoes(id) ON DELETE SET NULL,
  acao TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT,
  endereco_ip INET,
  detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ocorrido_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_log_org_data_idx ON auditoria_log (organizacao_id, ocorrido_em DESC);

INSERT INTO papeis (codigo, nome, descricao) VALUES
  ('administrador_orgao', 'Administrador do órgão', 'Administra a organização vinculada.'),
  ('coordenador', 'Coordenador', 'Coordena operações no escopo autorizado.'),
  ('analista', 'Analista', 'Analisa ocorrências, alertas e dados operacionais.'),
  ('operador_campo', 'Operador de campo', 'Registra e atualiza atividades em campo.'),
  ('voluntario', 'Voluntário', 'Acessa as funções destinadas a voluntários.'),
  ('leitura', 'Leitura', 'Consulta dados permitidos sem alterá-los.'),
  ('publico', 'Público', 'Acessa informações explicitamente públicas.')
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao;

INSERT INTO fontes_dados (id, nome, url, tipo_acesso, licenca_termos, status)
VALUES (
  'ibge-localidades',
  'IBGE — API de localidades',
  'https://servicodados.ibge.gov.br/api/v1/localidades',
  'api',
  'Confirmar condições oficiais de licença e redistribuição antes de republicar os dados.',
  'pendente'
)
ON CONFLICT (id) DO UPDATE SET
  nome = EXCLUDED.nome,
  url = EXCLUDED.url,
  licenca_termos = EXCLUDED.licenca_termos;
