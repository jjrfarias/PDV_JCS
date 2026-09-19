-- PostgreSQL production hardening for the PDV runtime.
-- The application role must not be table owner, superuser, or BYPASSRLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pdv_runtime') THEN
    CREATE ROLE pdv_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pdv_auth_lookup') THEN
    CREATE ROLE pdv_auth_lookup NOLOGIN;
  END IF;
END $$;

ALTER TABLE products ALTER COLUMN price_cents TYPE BIGINT;
ALTER TABLE cash_sessions
  ALTER COLUMN opening_cents TYPE BIGINT,
  ALTER COLUMN counted_cents TYPE BIGINT,
  ALTER COLUMN expected_cents TYPE BIGINT,
  ALTER COLUMN difference_cents TYPE BIGINT,
  ALTER COLUMN opened_at TYPE TIMESTAMPTZ USING opened_at::timestamptz,
  ALTER COLUMN closed_at TYPE TIMESTAMPTZ USING closed_at::timestamptz;
ALTER TABLE sales
  ALTER COLUMN subtotal_cents TYPE BIGINT,
  ALTER COLUMN discount_cents TYPE BIGINT,
  ALTER COLUMN total_cents TYPE BIGINT,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;
ALTER TABLE sale_items
  ALTER COLUMN price_cents TYPE BIGINT,
  ALTER COLUMN line_cents TYPE BIGINT;
ALTER TABLE payments
  ALTER COLUMN amount_cents TYPE BIGINT,
  ALTER COLUMN tendered_cents TYPE BIGINT,
  ALTER COLUMN change_cents TYPE BIGINT;
ALTER TABLE stock_movements ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;
ALTER TABLE cash_movements
  ALTER COLUMN amount_cents TYPE BIGINT,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;
ALTER TABLE operations ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;
ALTER TABLE audit_events ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

CREATE OR REPLACE FUNCTION pdv_current_tenant()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION pdv_current_user_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION pdv_block_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable_record' USING ERRCODE = '45000';
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sales','sale_items','payments','stock_movements','cash_movements','operations','audit_events'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_block_update ON %I', table_name, table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_block_delete ON %I', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_block_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable()', table_name, table_name);
    EXECUTE format('CREATE TRIGGER %I_block_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable()', table_name, table_name);
  END LOOP;
END $$;

DO $$
DECLARE
  table_name text;
  tenant_column text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants','companies','stores','users','memberships','sessions','terminals','products','stock',
    'cash_sessions','sales','sale_items','payments','stock_movements','cash_movements','operations','audit_events'
  ]
  LOOP
    tenant_column := CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_isolation ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_tenant_isolation ON %I
       USING (%I = pdv_current_tenant() OR current_user = ''pdv_auth_lookup'')
       WITH CHECK (%I = pdv_current_tenant())',
      table_name, table_name, tenant_column, tenant_column
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.pdv_login_user(p_tenant_slug text, p_email text)
RETURNS TABLE (
  tenant_id text,
  id text,
  email text,
  name text,
  role text,
  active integer,
  password_hash text
)
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
$$;

CREATE OR REPLACE FUNCTION public.pdv_resolve_session(p_token_hash text)
RETURNS TABLE (
  token_hash text,
  tenant_id text,
  user_id text,
  csrf_token text,
  expires_at bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.token_hash, s.tenant_id, s.user_id, s.csrf_token, s.expires_at
  FROM public.sessions s
  JOIN public.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
    AND u.active = 1
$$;

ALTER FUNCTION public.pdv_login_user(text, text) OWNER TO pdv_auth_lookup;
ALTER FUNCTION public.pdv_resolve_session(text) OWNER TO pdv_auth_lookup;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pdv_runtime, pdv_auth_lookup;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pdv_runtime;
GRANT SELECT ON tenants, users, sessions TO pdv_auth_lookup;
GRANT EXECUTE ON FUNCTION public.pdv_current_tenant() TO pdv_runtime, pdv_auth_lookup;
GRANT EXECUTE ON FUNCTION public.pdv_current_user_id() TO pdv_runtime, pdv_auth_lookup;
GRANT EXECUTE ON FUNCTION public.pdv_login_user(text, text) TO pdv_runtime;
GRANT EXECUTE ON FUNCTION public.pdv_resolve_session(text) TO pdv_runtime;
