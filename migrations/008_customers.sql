CREATE TABLE customers (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  name_enc TEXT NOT NULL,
  document_hash TEXT,
  document_enc TEXT,
  phone_hash TEXT,
  phone_enc TEXT,
  email_hash TEXT,
  email_enc TEXT,
  note_enc TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id)
);

CREATE UNIQUE INDEX customer_document_unique ON customers(tenant_id,document_hash) WHERE document_hash IS NOT NULL;
CREATE INDEX customer_store_list ON customers(tenant_id,store_id,active,updated_at);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_tenant_isolation ON customers;
CREATE POLICY customers_tenant_isolation ON customers
  USING (tenant_id = pdv_current_tenant())
  WITH CHECK (tenant_id = pdv_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON customers TO pdv_runtime;
