CREATE TABLE stock_reservations (
  tenant_id text NOT NULL, id text NOT NULL, requesting_store_id text NOT NULL, pickup_store_id text NOT NULL,
  product_id text NOT NULL, customer_id text NOT NULL, quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100),
  status text NOT NULL CHECK(status IN('REQUESTED','CONFIRMED','COLLECTED','CANCELED')),
  requested_by text NOT NULL, confirmed_by text, collected_by text, canceled_by text,
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, confirmed_at timestamptz, collected_at timestamptz, canceled_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,requesting_store_id) REFERENCES stores(tenant_id,id),
  FOREIGN KEY(tenant_id,pickup_store_id,product_id) REFERENCES stock(tenant_id,store_id,product_id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id), FOREIGN KEY(tenant_id,customer_id) REFERENCES customers(tenant_id,id),
  FOREIGN KEY(tenant_id,requested_by) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,confirmed_by) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,collected_by) REFERENCES users(tenant_id,id), FOREIGN KEY(tenant_id,canceled_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX stock_reservation_history ON stock_reservations(tenant_id,created_at DESC);
CREATE INDEX stock_reservation_hold ON stock_reservations(tenant_id,pickup_store_id,product_id,status,expires_at);
ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_reservations_tenant_isolation ON stock_reservations USING (tenant_id=pdv_current_tenant()) WITH CHECK (tenant_id=pdv_current_tenant());
GRANT SELECT,INSERT,UPDATE ON stock_reservations TO pdv_runtime;
