-- Recuperação de senha por link de uso único enviado por e-mail.
-- O token nunca é armazenado em claro: somente o SHA-256 dele.
CREATE TABLE password_resets (
  tenant_id text NOT NULL,
  id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at bigint NOT NULL,
  used_at bigint,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

CREATE INDEX password_reset_open ON password_resets(tenant_id, user_id) WHERE used_at IS NULL;

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS password_resets_tenant_isolation ON password_resets;
CREATE POLICY password_resets_tenant_isolation ON password_resets
  USING (tenant_id = pdv_current_tenant() OR current_user = 'pdv_auth_lookup')
  WITH CHECK (tenant_id = pdv_current_tenant());

-- Antes do login não existe tenant na sessão. Esta função só devolve o vínculo do token válido.
CREATE OR REPLACE FUNCTION public.pdv_password_reset_lookup(p_token_hash text)
RETURNS TABLE (tenant_id text, id text, user_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT r.tenant_id, r.id, r.user_id
  FROM public.password_resets r
  JOIN public.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
  WHERE r.token_hash = p_token_hash
    AND r.used_at IS NULL
    AND r.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
    AND u.active = 1
$$;

GRANT SELECT ON password_resets TO pdv_auth_lookup;
ALTER FUNCTION public.pdv_password_reset_lookup(text) OWNER TO pdv_auth_lookup;
REVOKE ALL ON FUNCTION public.pdv_password_reset_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pdv_password_reset_lookup(text) TO pdv_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_resets TO pdv_runtime;
