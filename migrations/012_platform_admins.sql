-- Administração do sistema, acima dos tenants.
-- O administrador gere contratantes (criar, listar, ativar/desativar) e NÃO lê dados operacionais
-- de nenhum tenant. As gravações em tabelas de tenant continuam passando pela RLS existente,
-- com app.tenant_id definido para o tenant alvo dentro da transação.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1));

CREATE TABLE platform_admins (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  active integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at bigint NOT NULL
);

CREATE TABLE platform_sessions (
  token_hash text PRIMARY KEY,
  admin_id text NOT NULL REFERENCES platform_admins(id),
  csrf_token text NOT NULL,
  expires_at bigint NOT NULL
);

CREATE TABLE platform_password_resets (
  id text PRIMARY KEY,
  admin_id text NOT NULL REFERENCES platform_admins(id),
  token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  used_at bigint,
  created_at bigint NOT NULL
);
CREATE INDEX platform_password_reset_open ON platform_password_resets(admin_id) WHERE used_at IS NULL;

CREATE TABLE platform_operations (
  key text PRIMARY KEY,
  admin_id text NOT NULL REFERENCES platform_admins(id),
  kind text NOT NULL,
  payload_hash text NOT NULL,
  response_json text NOT NULL,
  created_at bigint NOT NULL
);

CREATE TABLE platform_audit_events (
  id text PRIMARY KEY,
  admin_id text REFERENCES platform_admins(id),
  action text NOT NULL,
  entity_id text NOT NULL,
  details_json text NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX platform_audit_history ON platform_audit_events(created_at);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['platform_operations','platform_audit_events']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_block_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_block_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable()', table_name, table_name);
  END LOOP;
END $$;

-- Tenant desativado não entra, não mantém sessão e não recupera senha.
CREATE OR REPLACE FUNCTION public.pdv_login_user(p_tenant_slug text, p_email text)
RETURNS TABLE (tenant_id text, id text, email text, name text, role text, active integer, password_hash text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u.tenant_id, u.id, u.email, u.name, u.role, u.active, u.password_hash
  FROM public.tenants t
  JOIN public.users u ON u.tenant_id = t.id
  WHERE t.slug = lower(p_tenant_slug)
    AND u.email = lower(p_email)
    AND u.active = 1
    AND t.active = 1
$$;

CREATE OR REPLACE FUNCTION public.pdv_resolve_session(p_token_hash text)
RETURNS TABLE (token_hash text, tenant_id text, user_id text, csrf_token text, expires_at bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.token_hash, s.tenant_id, s.user_id, s.csrf_token, s.expires_at
  FROM public.sessions s
  JOIN public.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
    AND u.active = 1
    AND t.active = 1
$$;

CREATE OR REPLACE FUNCTION public.pdv_password_reset_lookup(p_token_hash text)
RETURNS TABLE (tenant_id text, id text, user_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.tenant_id, r.id, r.user_id
  FROM public.password_resets r
  JOIN public.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
  JOIN public.tenants t ON t.id = r.tenant_id
  WHERE r.token_hash = p_token_hash
    AND r.used_at IS NULL
    AND r.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
    AND u.active = 1
    AND t.active = 1
$$;

-- Listagem para o painel: somente dados cadastrais do tenant e contagem de usuários.
CREATE OR REPLACE FUNCTION public.pdv_platform_tenants()
RETURNS TABLE (id text, slug text, name text, active integer, user_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.slug, t.name, t.active, (SELECT count(*) FROM public.users u WHERE u.tenant_id = t.id)
  FROM public.tenants t
  ORDER BY t.name
$$;

ALTER FUNCTION public.pdv_login_user(text, text) OWNER TO pdv_auth_lookup;
ALTER FUNCTION public.pdv_resolve_session(text) OWNER TO pdv_auth_lookup;
ALTER FUNCTION public.pdv_password_reset_lookup(text) OWNER TO pdv_auth_lookup;
ALTER FUNCTION public.pdv_platform_tenants() OWNER TO pdv_auth_lookup;
REVOKE ALL ON FUNCTION public.pdv_platform_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pdv_platform_tenants() TO pdv_runtime;

REVOKE ALL ON platform_admins, platform_sessions, platform_password_resets, platform_operations, platform_audit_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_admins, platform_sessions, platform_password_resets TO pdv_runtime;
GRANT SELECT, INSERT ON platform_operations, platform_audit_events TO pdv_runtime;
