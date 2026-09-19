import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function connect(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('Banco de uma versão mais nova. Não faça downgrade.'); }
  if (version === 0) {
    transaction(db, () => {
      // Outra instância pode ter criado o esquema enquanto aguardávamos a trava.
      if (db.prepare('PRAGMA user_version').get().user_version !== 0) return;
      db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      // Registros confirmados e livro de movimentos são append-only pela aplicação.
      for (const table of ['sales','sale_items','payments','stock_movements','cash_movements','operations','audit_events']) {
        db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;
          CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
      }
      db.exec('PRAGMA user_version=1;');
    });
  }
  return db;
}

// Exclusivamente síncrona: nenhuma chamada de rede nem await nesta transação.
export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw new Error('A transação não aceita função assíncrona.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve o erro original. */ }
    throw error;
  }
}
