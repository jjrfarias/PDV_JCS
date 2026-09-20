-- Esquema LOCAL de laboratório, não é a migração PostgreSQL da futura nuvem.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL
) STRICT;
CREATE TABLE companies (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) STRICT;
CREATE TABLE stores (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, company_id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id,company_id) REFERENCES companies(tenant_id,id)
) STRICT;
CREATE TABLE users (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('MANAGER','CASHIER')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,email), FOREIGN KEY(tenant_id) REFERENCES tenants(id)
) STRICT;
CREATE TABLE memberships (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, store_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,store_id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id)
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
) STRICT;
CREATE TABLE terminals (
  tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id)
) STRICT;
CREATE TABLE products (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, sku TEXT NOT NULL, barcode TEXT,
  name TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 1 AND 100000000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,sku), UNIQUE(tenant_id,barcode),
  FOREIGN KEY(tenant_id) REFERENCES tenants(id)
) STRICT;
CREATE TABLE stock (
  tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),
  PRIMARY KEY(tenant_id,store_id,product_id),
  FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
) STRICT;
CREATE TABLE cash_sessions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
  operator_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('OPEN','CLOSED')),
  opening_cents INTEGER NOT NULL CHECK(opening_cents BETWEEN 0 AND 100000000),
  counted_cents INTEGER, expected_cents INTEGER, difference_cents INTEGER,
  close_reason TEXT, opened_at TEXT NOT NULL, closed_at TEXT,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,terminal_id) REFERENCES terminals(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,operator_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id),
  CHECK ((status='OPEN' AND closed_at IS NULL AND counted_cents IS NULL AND expected_cents IS NULL AND difference_cents IS NULL)
     OR (status='CLOSED' AND closed_at IS NOT NULL AND counted_cents IS NOT NULL AND expected_cents IS NOT NULL
         AND difference_cents=counted_cents-expected_cents))
) STRICT;
CREATE UNIQUE INDEX one_open_cash ON cash_sessions(tenant_id,terminal_id) WHERE status='OPEN';
CREATE TABLE sales (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, cash_session_id TEXT NOT NULL,
  operator_id TEXT NOT NULL, subtotal_cents INTEGER NOT NULL CHECK(subtotal_cents BETWEEN 1 AND 100000000),
  discount_cents INTEGER NOT NULL CHECK(discount_cents>=0), discount_reason TEXT,
  discount_author_id TEXT, total_cents INTEGER NOT NULL CHECK(total_cents>0),
  status TEXT NOT NULL CHECK(status='CONFIRMED'),
  fiscal_status TEXT NOT NULL CHECK(fiscal_status='TEST_NOT_ISSUED'), created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,store_id,id),
  CHECK(total_cents=subtotal_cents-discount_cents),
  CHECK((discount_cents=0 AND discount_author_id IS NULL) OR (discount_cents>0 AND discount_author_id IS NOT NULL AND length(discount_reason)>=3)),
  FOREIGN KEY(tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,operator_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,discount_author_id) REFERENCES users(tenant_id,id)
) STRICT;
CREATE TABLE sale_items (
  tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
  sku_snapshot TEXT NOT NULL, name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
  price_cents INTEGER NOT NULL CHECK(price_cents>0), line_cents INTEGER NOT NULL CHECK(line_cents=quantity*price_cents),
  PRIMARY KEY(tenant_id,sale_id,product_id),
  FOREIGN KEY(tenant_id,sale_id) REFERENCES sales(tenant_id,id),
  FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
) STRICT;
CREATE TABLE payments (
  tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN('CASH','PIX','CARD')),
  status TEXT NOT NULL CHECK(status='CONFIRMED'), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  tendered_cents INTEGER NOT NULL, change_cents INTEGER NOT NULL CHECK(change_cents>=0),
  PRIMARY KEY(tenant_id,sale_id), CHECK(tendered_cents-change_cents=amount_cents),
  FOREIGN KEY(tenant_id,sale_id) REFERENCES sales(tenant_id,id)
) STRICT;
CREATE TABLE stock_movements (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, product_id TEXT NOT NULL,
  sale_id TEXT, quantity INTEGER NOT NULL CHECK(quantity<>0),
  kind TEXT NOT NULL CHECK(kind IN('INITIAL','SALE')), reason TEXT NOT NULL,
  actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,sale_id,product_id),
  CHECK((kind='SALE' AND quantity<0 AND sale_id IS NOT NULL) OR (kind='INITIAL' AND quantity>0 AND sale_id IS NULL)),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES stock(tenant_id,store_id,product_id),
  FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
) STRICT;
CREATE TABLE cash_movements (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, cash_session_id TEXT NOT NULL,
  sale_id TEXT, kind TEXT NOT NULL CHECK(kind IN('OPENING','SALE','SUPPLY','WITHDRAWAL')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN -100000000 AND 100000000),
  reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,sale_id),
  CHECK((kind='SALE' AND sale_id IS NOT NULL AND amount_cents>0)
     OR (kind='OPENING' AND sale_id IS NULL AND amount_cents>=0)
     OR (kind='SUPPLY' AND sale_id IS NULL AND amount_cents>0)
     OR (kind='WITHDRAWAL' AND sale_id IS NULL AND amount_cents<0)),
  FOREIGN KEY(tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
) STRICT;
CREATE UNIQUE INDEX one_opening ON cash_movements(tenant_id,cash_session_id) WHERE kind='OPENING';
CREATE TABLE operations (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, user_id TEXT NOT NULL, store_id TEXT NOT NULL,
  kind TEXT NOT NULL, payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,key),
  FOREIGN KEY(tenant_id,user_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
) STRICT;
CREATE TABLE audit_events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, store_id TEXT NOT NULL,
  action TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
) STRICT;
CREATE INDEX sale_history ON sales(tenant_id,store_id,created_at);
CREATE INDEX stock_history ON stock_movements(tenant_id,store_id,created_at);
