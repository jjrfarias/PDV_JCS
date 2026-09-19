import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
// DATABASE_URL é privada dentro da rede Railway; DATABASE_PUBLIC_URL permite
// executar migrations a partir do terminal local de staging.
const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória para aplicar migrations PostgreSQL.');

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const version = '001_initial';
  const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
  if (existing.rowCount === 0) {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(join(here, '..', 'migrations', `${version}.sql`), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
    console.log(`Migration ${version} aplicada.`);
  } else {
    console.log(`Migration ${version} já aplicada.`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
