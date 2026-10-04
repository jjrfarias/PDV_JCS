CREATE OR REPLACE FUNCTION public.pdv_resolve_session_context(p_token_hash text)
RETURNS TABLE (
  token_hash text,
  tenant_id text,
  user_id text,
  csrf_token text,
  expires_at bigint,
  role text,
  mfa_enabled integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.token_hash, s.tenant_id, s.user_id, s.csrf_token, s.expires_at,
    u.role, u.mfa_enabled
  FROM public.sessions s
  JOIN public.users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
  JOIN public.tenants t ON t.id = s.tenant_id
  WHERE s.token_hash = p_token_hash
    AND s.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
    AND u.active = 1
    AND t.active = 1
$$;

ALTER FUNCTION public.pdv_resolve_session_context(text) OWNER TO pdv_auth_lookup;
REVOKE ALL ON FUNCTION public.pdv_resolve_session_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pdv_resolve_session_context(text) TO pdv_runtime;
