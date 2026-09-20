CREATE TABLE sale_returns (
  tenant_id text NOT NULL,
  id text NOT NULL,
  store_id text NOT NULL,
  sale_id text NOT NULL,
  cash_session_id text NOT NULL,
  actor_id text NOT NULL,
  payment_method text NOT NULL CHECK(payment_method IN ('CASH','PIX','CARD')),
  total_cents integer NOT NULL CHECK(total_cents > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
  FOREIGN KEY (tenant_id,actor_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
);

CREATE TABLE sale_return_items (
  tenant_id text NOT NULL,
  return_id text NOT NULL,
  sale_id text NOT NULL,
  product_id text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
  amount_cents integer NOT NULL CHECK(amount_cents > 0),
  PRIMARY KEY (tenant_id,return_id,product_id),
  FOREIGN KEY (tenant_id,return_id) REFERENCES sale_returns(tenant_id,id),
  FOREIGN KEY (tenant_id,sale_id,product_id) REFERENCES sale_items(tenant_id,sale_id,product_id)
);

CREATE INDEX sale_return_history ON sale_returns(tenant_id,store_id,created_at);

ALTER TABLE sale_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_return_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_sale_returns ON sale_returns
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation_sale_return_items ON sale_return_items
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TRIGGER sale_returns_immutable_update BEFORE UPDATE ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();
CREATE TRIGGER sale_returns_immutable_delete BEFORE DELETE ON sale_returns
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();
CREATE TRIGGER sale_return_items_immutable_update BEFORE UPDATE ON sale_return_items
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();
CREATE TRIGGER sale_return_items_immutable_delete BEFORE DELETE ON sale_return_items
  FOR EACH ROW EXECUTE FUNCTION pdv_block_immutable();

GRANT SELECT, INSERT, UPDATE, DELETE ON sale_returns, sale_return_items TO pdv_runtime;
