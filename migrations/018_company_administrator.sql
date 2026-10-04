-- Um responsável por tenant administra filiais e convida o gerente de cada nova loja.
ALTER TABLE users ADD COLUMN company_admin integer NOT NULL DEFAULT 0 CHECK(company_admin IN (0,1));

WITH ranked AS (
  SELECT u.tenant_id,u.id,
    row_number() OVER (PARTITION BY u.tenant_id ORDER BY count(m.store_id) DESC,u.id) AS position
  FROM users u
  LEFT JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
  WHERE u.role='MANAGER' AND u.active=1
  GROUP BY u.tenant_id,u.id
)
UPDATE users u SET company_admin=1
FROM ranked r
WHERE u.tenant_id=r.tenant_id AND u.id=r.id AND r.position=1
  AND NOT EXISTS (SELECT 1 FROM users a WHERE a.tenant_id=u.tenant_id AND a.company_admin=1);
