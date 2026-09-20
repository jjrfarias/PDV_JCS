import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const IMMUTABLE_TABLES = ['sales','sale_items','payments','stock_movements','cash_movements','operations','audit_events'];

export function connect(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 4) { db.close(); throw new Error('Banco de uma versao mais nova. Nao faca downgrade.'); }
  if (version === 0) {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 0) return;
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      createImmutableTriggers(db);
      db.exec('PRAGMA user_version=4;');
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
