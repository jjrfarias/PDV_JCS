ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT;
ALTER TABLE users ADD COLUMN mfa_pending_secret_enc TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1));

DROP FUNCTION public.pdv_login_user(text, text);
CREATE FUNCTION public.pdv_login_user(p_tenant_slug text, p_email text)
RETURNS TABLE (tenant_id text,id text,email text,name text,role text,active integer,password_hash text,mfa_secret_enc text,mfa_enabled integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.tenant_id,u.id,u.email,u.name,u.role,u.active,u.password_hash,u.mfa_secret_enc,u.mfa_enabled
  FROM public.tenants t JOIN public.users u ON u.tenant_id=t.id
  WHERE t.slug=lower(p_tenant_slug) AND u.email=lower(p_email) AND u.active=1 AND t.active=1
$$;
ALTER FUNCTION public.pdv_login_user(text,text) OWNER TO pdv_auth_lookup;
REVOKE ALL ON FUNCTION public.pdv_login_user(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pdv_login_user(text,text) TO pdv_runtime;
