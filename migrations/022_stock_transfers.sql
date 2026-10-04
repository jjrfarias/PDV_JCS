CREATE TABLE stock_transfers (
  tenant_id text NOT NULL, id text NOT NULL, origin_store_id text NOT NULL, destination_store_id text NOT NULL,
  product_id text NOT NULL, quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
  status text NOT NULL CHECK(status IN('REQUESTED','APPROVED','IN_TRANSIT','RECEIVED','CANCELED')),
  note text, requested_by text NOT NULL, approved_by text, shipped_by text, received_by text, canceled_by text,
  created_at timestamptz NOT NULL, approved_at timestamptz, shipped_at timestamptz, received_at timestamptz, canceled_at timestamptz,
  PRIMARY KEY(tenant_id,id), CHECK(origin_store_id<>destination_store_id),
  FOREIGN KEY(tenant_id,origin_store_id,product_id) REFERENCES stock(tenant_id,store_id,product_id),
  FOREIGN KEY(tenant_id,destination_store_id,product_id) REFERENCES stock(tenant_id,store_id,product_id),
  FOREIGN KEY(tenant_id,requested_by) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,approved_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,shipped_by) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,received_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,canceled_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX stock_transfer_history ON stock_transfers(tenant_id,created_at DESC);
ALTER TABLE stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_transfers_tenant_isolation ON stock_transfers
  USING (tenant_id=pdv_current_tenant()) WITH CHECK (tenant_id=pdv_current_tenant());
GRANT SELECT,INSERT,UPDATE ON stock_transfers TO pdv_runtime;
