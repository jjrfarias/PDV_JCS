CREATE TABLE sale_cancellations (
  tenant_id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  cash_session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,sale_id),
  FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,actor_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
);

ALTER TABLE sale_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_cancellations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_cancellations_tenant_isolation ON sale_cancellations;
CREATE POLICY sale_cancellations_tenant_isolation ON sale_cancellations
  USING (tenant_id = pdv_current_tenant() OR current_user = 'pdv_auth_lookup')
  WITH CHECK (tenant_id = pdv_current_tenant());

DROP TRIGGER IF EXISTS sale_cancellations_block_update ON sale_cancellations;
DROP TRIGGER IF EXISTS sale_cancellations_block_delete ON sale_cancellations;
CREATE TRIGGER sale_cancellations_block_update
  BEFORE UPDATE ON sale_cancellations
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();
CREATE TRIGGER sale_cancellations_block_delete
  BEFORE DELETE ON sale_cancellations
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();

GRANT SELECT, INSERT, UPDATE, DELETE ON sale_cancellations TO pdv_runtime;
