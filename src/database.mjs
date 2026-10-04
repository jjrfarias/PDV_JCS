import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const IMMUTABLE_TABLES = ['platform_operations','platform_audit_events','sales','sale_items','payments','sale_cancellations','sale_returns','sale_return_items','stock_movements','cash_movements','operations','audit_events'];

export function connect(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 15) { db.close(); throw new Error('Banco de uma versao mais nova. Nao faca downgrade.'); }
  if (version === 0) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 0) return;
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      createImmutableTriggers(db);
      db.exec('PRAGMA user_version=15;');
    });
  }
  if (version === 1) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) return;
      db.exec(`DROP TRIGGER IF EXISTS payments_no_update;
        DROP TRIGGER IF EXISTS payments_no_delete;
        ALTER TABLE payments RENAME TO payments_old;
        CREATE TABLE payments (
          tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN('CASH','PIX','CARD')),
          status TEXT NOT NULL CHECK(status='CONFIRMED'), amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
          tendered_cents INTEGER NOT NULL, change_cents INTEGER NOT NULL CHECK(change_cents>=0),
          PRIMARY KEY(tenant_id,sale_id), CHECK(tendered_cents-change_cents=amount_cents),
          FOREIGN KEY(tenant_id,sale_id) REFERENCES sales(tenant_id,id)
        ) STRICT;
        INSERT INTO payments SELECT * FROM payments_old;
        DROP TABLE payments_old;`);
      createImmutableTriggers(db, ['payments']);
      db.exec('PRAGMA user_version=2;');
    });
  }
  if (version <= 2) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 2) return;
      db.exec(`DROP TRIGGER IF EXISTS cash_movements_no_update;
        DROP TRIGGER IF EXISTS cash_movements_no_delete;
        DROP INDEX IF EXISTS one_opening;
        ALTER TABLE cash_movements RENAME TO cash_movements_old;
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
        INSERT INTO cash_movements
          SELECT tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,
            CASE kind WHEN 'OPENING' THEN 'Fundo inicial' ELSE 'Venda em dinheiro' END,
            actor_id,created_at
          FROM cash_movements_old;
        DROP TABLE cash_movements_old;
        CREATE UNIQUE INDEX one_opening ON cash_movements(tenant_id,cash_session_id) WHERE kind='OPENING';`);
      createImmutableTriggers(db, ['cash_movements']);
      db.exec('PRAGMA user_version=3;');
    });
  }
  if (version <= 3) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 3) return;
      db.exec(`DROP TRIGGER IF EXISTS stock_movements_no_update;
        DROP TRIGGER IF EXISTS stock_movements_no_delete;
        ALTER TABLE stock_movements RENAME TO stock_movements_old;
        CREATE TABLE stock_movements (
          tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, product_id TEXT NOT NULL,
          sale_id TEXT, quantity INTEGER NOT NULL CHECK(quantity<>0),
          kind TEXT NOT NULL CHECK(kind IN('INITIAL','SALE','ADJUSTMENT')), reason TEXT NOT NULL,
          actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id,id),
          UNIQUE(tenant_id,sale_id,product_id),
          CHECK((kind='SALE' AND quantity<0 AND sale_id IS NOT NULL)
             OR (kind='INITIAL' AND quantity>0 AND sale_id IS NULL)
             OR (kind='ADJUSTMENT' AND sale_id IS NULL)),
          FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES stock(tenant_id,store_id,product_id),
          FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
          FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
        ) STRICT;
        INSERT INTO stock_movements SELECT * FROM stock_movements_old;
        DROP TABLE stock_movements_old;`);
      createImmutableTriggers(db, ['stock_movements']);
      db.exec('PRAGMA user_version=4;');
    });
  }
  if (version <= 4) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 4) return;
      db.exec(`CREATE TABLE sale_cancellations (
          tenant_id TEXT NOT NULL, sale_id TEXT NOT NULL, store_id TEXT NOT NULL,
          cash_session_id TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,sale_id),
          FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
          FOREIGN KEY(tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
          FOREIGN KEY(tenant_id,actor_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
        ) STRICT;`);
      createImmutableTriggers(db, ['sale_cancellations']);
      db.exec('PRAGMA user_version=5;');
    });
  }
  if (version <= 5) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 5) return;
      db.exec(`CREATE TABLE customers (
          tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL,
          name_enc TEXT NOT NULL, document_hash TEXT, document_enc TEXT,
          phone_hash TEXT, phone_enc TEXT, email_hash TEXT, email_enc TEXT,
          note_enc TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,id),
          FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id)
        ) STRICT;
        CREATE UNIQUE INDEX customer_document_unique ON customers(tenant_id,document_hash) WHERE document_hash IS NOT NULL;
        CREATE INDEX customer_store_list ON customers(tenant_id,store_id,active,updated_at);`);
      db.exec('PRAGMA user_version=6;');
    });
  }
  if (version <= 6) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 6) return;
      db.exec('ALTER TABLE sales ADD COLUMN customer_id TEXT;');
      db.exec('PRAGMA user_version=7;');
    });
  }
  if (version <= 7) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 7) return;
      db.exec(`CREATE TABLE sale_returns (
          tenant_id TEXT NOT NULL, id TEXT NOT NULL, store_id TEXT NOT NULL, sale_id TEXT NOT NULL,
          cash_session_id TEXT NOT NULL, actor_id TEXT NOT NULL, payment_method TEXT NOT NULL CHECK(payment_method IN('CASH','PIX','CARD')),
          total_cents INTEGER NOT NULL CHECK(total_cents>0), reason TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id,id),
          FOREIGN KEY(tenant_id,store_id,sale_id) REFERENCES sales(tenant_id,store_id,id),
          FOREIGN KEY(tenant_id,store_id,cash_session_id) REFERENCES cash_sessions(tenant_id,store_id,id),
          FOREIGN KEY(tenant_id,actor_id,store_id) REFERENCES memberships(tenant_id,user_id,store_id)
        ) STRICT;
        CREATE TABLE sale_return_items (
          tenant_id TEXT NOT NULL, return_id TEXT NOT NULL, sale_id TEXT NOT NULL, product_id TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
          amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
          PRIMARY KEY(tenant_id,return_id,product_id),
          FOREIGN KEY(tenant_id,return_id) REFERENCES sale_returns(tenant_id,id),
          FOREIGN KEY(tenant_id,sale_id,product_id) REFERENCES sale_items(tenant_id,sale_id,product_id)
        ) STRICT;
        CREATE INDEX sale_return_history ON sale_returns(tenant_id,store_id,created_at);`);
      createImmutableTriggers(db, ['sale_returns','sale_return_items']);
      db.exec('PRAGMA user_version=8;');
    });
  }
  if (version <= 8) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 8) return;
      db.exec(`CREATE TABLE password_resets (
          tenant_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL,
          PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
        ) STRICT;
        CREATE INDEX password_reset_open ON password_resets(tenant_id,user_id) WHERE used_at IS NULL;`);
      db.exec('PRAGMA user_version=9;');
    });
  }
  if (version <= 9) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 9) return;
      db.exec(`ALTER TABLE tenants ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1));
        CREATE TABLE platform_admins (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE platform_sessions (
          token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES platform_admins(id),
          csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE platform_password_resets (
          id TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES platform_admins(id), token_hash TEXT NOT NULL UNIQUE,
          expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX platform_password_reset_open ON platform_password_resets(admin_id) WHERE used_at IS NULL;
        CREATE TABLE platform_operations (
          key TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES platform_admins(id), kind TEXT NOT NULL,
          payload_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE platform_audit_events (
          id TEXT PRIMARY KEY, admin_id TEXT REFERENCES platform_admins(id), action TEXT NOT NULL,
          entity_id TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL
        ) STRICT;`);
      createImmutableTriggers(db, ['platform_operations','platform_audit_events']);
      db.exec('PRAGMA user_version=10;');
    });
  }
  if (version <= 10) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 10) return;
      db.exec(`ALTER TABLE platform_admins ADD COLUMN mfa_secret_enc TEXT;
        ALTER TABLE platform_admins ADD COLUMN mfa_pending_secret_enc TEXT;
        ALTER TABLE platform_admins ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1));
        PRAGMA user_version=11;`);
    });
  }
  if (version <= 11) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 11) return;
      const columns=new Set(db.prepare('PRAGMA table_info(users)').all().map(column=>column.name));
      if(!columns.has('mfa_secret_enc'))db.exec('ALTER TABLE users ADD COLUMN mfa_secret_enc TEXT');
      if(!columns.has('mfa_pending_secret_enc'))db.exec('ALTER TABLE users ADD COLUMN mfa_pending_secret_enc TEXT');
      if(!columns.has('mfa_enabled'))db.exec('ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0 CHECK(mfa_enabled IN (0,1))');
      db.exec('PRAGMA user_version=12;');
    });
  }
  if (version <= 12) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 12) return;
      db.exec(`CREATE TABLE access_events (
          tenant_id TEXT NOT NULL REFERENCES tenants(id), id TEXT NOT NULL, user_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('LOGIN_SUCCEEDED','LOGIN_FAILED','LOGOUT')), ip TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
        ) STRICT;
        CREATE INDEX access_events_history ON access_events(tenant_id,created_at);
        CREATE INDEX access_events_user ON access_events(tenant_id,user_id,created_at);`);
      db.exec('PRAGMA user_version=13;');
    });
  }
  if (version <= 13) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 13) return;
      for (const table of ['users', 'platform_admins']) {
        const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
        if (!columns.has('mfa_last_step')) db.exec(`ALTER TABLE ${table} ADD COLUMN mfa_last_step INTEGER`);
      }
      db.exec('PRAGMA user_version=14;');
    });
  }
  if (version <= 14) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 14) return;
      const columns=new Set(db.prepare('PRAGMA table_info(users)').all().map(column=>column.name));
      if(!columns.has('company_admin')) db.exec('ALTER TABLE users ADD COLUMN company_admin INTEGER NOT NULL DEFAULT 0 CHECK(company_admin IN (0,1));');
      db.exec(`UPDATE users SET company_admin=1 WHERE id IN (
        SELECT u.id FROM users u WHERE u.role='MANAGER' AND u.active=1
          AND NOT EXISTS (SELECT 1 FROM users a WHERE a.tenant_id=u.tenant_id AND a.company_admin=1)
          AND u.id=(SELECT u2.id FROM users u2 LEFT JOIN memberships m ON m.tenant_id=u2.tenant_id AND m.user_id=u2.id
            WHERE u2.tenant_id=u.tenant_id AND u2.role='MANAGER' AND u2.active=1
            GROUP BY u2.id ORDER BY COUNT(m.store_id) DESC,u2.id LIMIT 1)
      );`);
      db.exec('PRAGMA user_version=15;');
    });
  }
  return db;
}

function createImmutableTriggers(db, tables = IMMUTABLE_TABLES) {
  for (const table of tables) {
    db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
      CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
  }
}

// Exclusivamente sincrona: nenhuma chamada de rede nem await nesta transacao.
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw new Error('A transacao nao aceita funcao assincrona.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve o erro original. */ }
    throw error;
  }
}
