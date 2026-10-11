ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;

ALTER TABLE solicitacoes_usuarios
  ADD COLUMN IF NOT EXISTS organizacao_id TEXT REFERENCES organizacoes(id);
ALTER TABLE solicitacoes_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitacoes_usuarios FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS solicitacoes_usuarios_org_status_idx
  ON solicitacoes_usuarios (organizacao_id, status, criado_em DESC);

CREATE TABLE usuario_mfa (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  enabled_at TIMESTAMPTZ,
  last_verified_step BIGINT NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE convites_usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  organizacao_id TEXT NOT NULL REFERENCES organizacoes(id),
  papel_codigo TEXT NOT NULL REFERENCES papeis(codigo),
  email TEXT NOT NULL,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id),
  aprovado_por INTEGER REFERENCES usuarios(id),
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'aprovado', 'utilizado', 'revogado', 'expirado')),
  expira_em TIMESTAMPTZ NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  utilizado_em TIMESTAMPTZ,
  CHECK (expira_em > criado_em)
);
CREATE INDEX convites_usuarios_org_status_idx
  ON convites_usuarios (organizacao_id, status, expira_em);

ALTER TABLE usuario_mfa ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_mfa FORCE ROW LEVEL SECURITY;
ALTER TABLE convites_usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE convites_usuarios FORCE ROW LEVEL SECURITY;

ALTER TABLE solicitacoes_usuarios
  ADD COLUMN IF NOT EXISTS convite_id UUID REFERENCES convites_usuarios(id);
ALTER TABLE solicitacoes_usuarios
  ADD COLUMN IF NOT EXISTS papel_codigo TEXT REFERENCES papeis(codigo);

CREATE OR REPLACE FUNCTION app_has_org_scope(target_org TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    target_org = ANY(string_to_array(
      NULLIF(current_setting('app.organization_ids', TRUE), ''), ','
    )),
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION app_can_write_org(target_org TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    target_org = ANY(string_to_array(
      NULLIF(current_setting('app.writable_organization_ids', TRUE), ''), ','
    )),
    FALSE
  );
$$;

CREATE OR REPLACE FUNCTION app_is_service()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.operation', TRUE) = 'service', FALSE);
$$;

CREATE OR REPLACE FUNCTION app_can_manage_target(target_org TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT app_is_service()
      OR app_can_write_org(target_org)
      OR EXISTS (
        SELECT 1 FROM organizacoes target
        WHERE target.id = target_org AND app_can_write_org(target.parent_id)
      );
$$;

CREATE POLICY usuarios_read_self_or_auth ON usuarios
  FOR SELECT USING (
    app_is_service()
    OR id::text = NULLIF(current_setting('app.user_id', TRUE), '')
    OR current_setting('app.operation', TRUE) IN (
      'authentication', 'public_registration', 'registration_approval'
    )
    OR EXISTS (
      SELECT 1
      FROM municipios m
      JOIN organizacoes o ON o.municipio_id = m.id
      WHERE m.id = usuarios.municipio_id
        AND app_has_org_scope(o.id)
    )
  );

CREATE POLICY usuarios_create_on_approval ON usuarios
  FOR INSERT WITH CHECK (
    app_is_service()
    OR current_setting('app.operation', TRUE) IN ('authentication', 'registration_approval')
  );
CREATE POLICY usuarios_update_self_or_auth ON usuarios
  FOR UPDATE USING (
    app_is_service()
    OR id::text = NULLIF(current_setting('app.user_id', TRUE), '')
    OR current_setting('app.operation', TRUE) IN ('authentication', 'registration_approval')
  ) WITH CHECK (
    app_is_service()
    OR id::text = NULLIF(current_setting('app.user_id', TRUE), '')
    OR current_setting('app.operation', TRUE) IN ('authentication', 'registration_approval')
  );
CREATE POLICY usuarios_delete_service_only ON usuarios
  FOR DELETE USING (app_is_service());

CREATE POLICY solicitacoes_public_create ON solicitacoes_usuarios
  FOR INSERT WITH CHECK (
    app_is_service() OR
    current_setting('app.operation', TRUE) = 'public_registration'
  );
CREATE POLICY solicitacoes_scope_read ON solicitacoes_usuarios
  FOR SELECT USING (
    app_is_service()
    OR current_setting('app.operation', TRUE) = 'public_registration'
    OR app_has_org_scope(organizacao_id)
  );
CREATE POLICY solicitacoes_scope_update ON solicitacoes_usuarios
  FOR UPDATE USING (app_can_manage_target(organizacao_id))
  WITH CHECK (app_can_manage_target(organizacao_id));
CREATE POLICY solicitacoes_scope_delete ON solicitacoes_usuarios
  FOR DELETE USING (app_can_manage_target(organizacao_id));

CREATE POLICY usuario_mfa_owner ON usuario_mfa
  FOR ALL USING (
    app_is_service()
    OR usuario_id::text = NULLIF(current_setting('app.user_id', TRUE), '')
  ) WITH CHECK (
    app_is_service()
    OR usuario_id::text = NULLIF(current_setting('app.user_id', TRUE), '')
  );

CREATE POLICY convites_scope_read ON convites_usuarios
  FOR SELECT USING (
    app_is_service()
    OR current_setting('app.operation', TRUE) = 'public_registration'
    OR app_has_org_scope(organizacao_id)
  );
CREATE POLICY convites_scope_write ON convites_usuarios
  FOR INSERT WITH CHECK (
    app_is_service()
    OR app_can_write_org(organizacao_id)
    OR EXISTS (
      SELECT 1 FROM organizacoes target
      WHERE target.id = organizacao_id AND app_can_write_org(target.parent_id)
    )
  );
CREATE POLICY convites_scope_update ON convites_usuarios
  FOR UPDATE USING (app_can_manage_target(organizacao_id))
  WITH CHECK (app_can_manage_target(organizacao_id));
CREATE POLICY convites_scope_delete ON convites_usuarios
  FOR DELETE USING (app_can_manage_target(organizacao_id));
CREATE POLICY convites_public_claim ON convites_usuarios
  FOR UPDATE USING (
    current_setting('app.operation', TRUE) = 'public_registration'
    AND status = 'pendente'
  )
  WITH CHECK (
    current_setting('app.operation', TRUE) = 'public_registration'
    AND status = 'utilizado'
  );

ALTER TABLE usuario_organizacao_papel ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuario_organizacao_papel FORCE ROW LEVEL SECURITY;
CREATE POLICY usuario_organizacao_papel_read ON usuario_organizacao_papel
  FOR SELECT USING (
    app_is_service()
    OR usuario_id::text = NULLIF(current_setting('app.user_id', TRUE), '')
    OR app_has_org_scope(organizacao_id)
  );
CREATE POLICY usuario_organizacao_papel_write ON usuario_organizacao_papel
  FOR ALL USING (app_is_service() OR app_can_manage_target(organizacao_id))
  WITH CHECK (app_is_service() OR app_can_manage_target(organizacao_id));

DO $$
DECLARE
  table_name TEXT;
  org_column TEXT;
BEGIN
  FOR table_name, org_column IN
    SELECT * FROM (VALUES
      ('ocorrencias', 'organizacao_id'),
      ('alertas', 'organizacao_id'),
      ('alerta_ciente', 'organizacao_id'),
      ('eventos', 'organizacao_id'),
      ('evento_participantes', 'organizacao_id'),
      ('recursos', 'organizacao_id'),
      ('pedidos_apoio', 'organizacao_solicitante_id')
    ) AS scoped(table_name, org_column)
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app_is_service() OR app_has_org_scope(%I))',
      table_name || '_scope_read', table_name, org_column
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_is_service() OR app_can_write_org(%I))',
      table_name || '_scope_insert', table_name, org_column
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (app_is_service() OR app_can_write_org(%I)) WITH CHECK (app_is_service() OR app_can_write_org(%I))',
      table_name || '_scope_update', table_name, org_column, org_column
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (app_is_service() OR app_can_write_org(%I))',
      table_name || '_scope_delete', table_name, org_column
    );
  END LOOP;
END;
$$;

ALTER TABLE auditoria_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria_log FORCE ROW LEVEL SECURITY;
CREATE POLICY auditoria_log_scope_read ON auditoria_log
  FOR SELECT USING (app_is_service() OR app_has_org_scope(organizacao_id));
CREATE POLICY auditoria_log_immutable_insert ON auditoria_log
  FOR INSERT WITH CHECK (
    app_is_service()
    OR app_can_manage_target(organizacao_id)
    OR (
      current_setting('app.operation', TRUE) = 'public_registration'
      AND EXISTS (
        SELECT 1 FROM solicitacoes_usuarios
        WHERE solicitacoes_usuarios.id::text = auditoria_log.entidade_id
          AND solicitacoes_usuarios.organizacao_id = auditoria_log.organizacao_id
      )
    )
  );

ALTER TABLE territorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE territorios FORCE ROW LEVEL SECURITY;
CREATE POLICY territorios_catalog_read ON territorios
  FOR SELECT USING (TRUE);
CREATE POLICY territorios_admin_write ON territorios
  FOR ALL USING (app_is_service() OR app_can_write_org(organizacao_id))
  WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));

ALTER TABLE cameras ENABLE ROW LEVEL SECURITY;
ALTER TABLE cameras FORCE ROW LEVEL SECURITY;
CREATE POLICY cameras_visibility_read ON cameras
  FOR SELECT USING (
    app_is_service()
    OR visibilidade = 'publica'
    OR app_has_org_scope(organizacao_id)
  );
CREATE POLICY cameras_scope_insert ON cameras
  FOR INSERT WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY cameras_scope_update ON cameras
  FOR UPDATE USING (app_is_service() OR app_can_write_org(organizacao_id))
  WITH CHECK (app_is_service() OR app_can_write_org(organizacao_id));
CREATE POLICY cameras_scope_delete ON cameras
  FOR DELETE USING (app_is_service() OR app_can_write_org(organizacao_id));

ALTER TABLE alerta_territorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerta_territorios FORCE ROW LEVEL SECURITY;
CREATE POLICY alerta_territorios_scope_read ON alerta_territorios
  FOR SELECT USING (app_is_service() OR app_has_org_scope(territorio_id));
CREATE POLICY alerta_territorios_scope_write ON alerta_territorios
  FOR ALL USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM territorios
      WHERE territorios.id = territorio_id
        AND app_can_write_org(territorios.organizacao_id)
    )
  )
  WITH CHECK (
    app_is_service() OR EXISTS (
      SELECT 1 FROM territorios
      WHERE territorios.id = territorio_id
        AND app_can_write_org(territorios.organizacao_id)
    )
  );

ALTER TABLE eventos_diario_bordo ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_diario_bordo FORCE ROW LEVEL SECURITY;
CREATE POLICY eventos_diario_bordo_scope ON eventos_diario_bordo
  FOR ALL USING (
    app_is_service() OR EXISTS (
      SELECT 1 FROM eventos
      WHERE eventos.id = evento_id
        AND app_has_org_scope(eventos.organizacao_id)
    )
  )
  WITH CHECK (
    app_is_service() OR EXISTS (
      SELECT 1 FROM eventos
      WHERE eventos.id = evento_id
        AND app_can_write_org(eventos.organizacao_id)
    )
  );
