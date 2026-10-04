-- Registros de acesso (Marco Civil da Internet, art. 15): quem entrou, saiu ou errou a senha, de qual IP e quando.
-- Separado de audit_events porque não depende de loja e guarda endereço de rede.
-- A aplicação só insere e lê. Apagar no fim do prazo de retenção é tarefa administrativa.
CREATE TABLE access_events (
  tenant_id text NOT NULL REFERENCES tenants(id),
  id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('LOGIN_SUCCEEDED','LOGIN_FAILED','LOGOUT')),
  ip text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX access_events_history ON access_events(tenant_id, created_at);
CREATE INDEX access_events_user ON access_events(tenant_id, user_id, created_at);

ALTER TABLE access_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_events_tenant_isolation ON access_events;
CREATE POLICY access_events_tenant_isolation ON access_events
  USING (tenant_id = pdv_current_tenant())
  WITH CHECK (tenant_id = pdv_current_tenant());

REVOKE ALL ON access_events FROM PUBLIC;
GRANT SELECT, INSERT ON access_events TO pdv_runtime;
