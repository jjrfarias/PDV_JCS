ALTER TABLE sales ADD COLUMN customer_id TEXT;

ALTER TABLE sales
  ADD CONSTRAINT sales_customer_fk
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id);
