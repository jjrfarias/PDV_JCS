import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const databaseUrl = process.env.PG_MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL é obrigatória para aplicar migrations PostgreSQL.');

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('pdv-jcs-migrations',0))`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, '..', 'migrations');
  const files = (await readdir(dir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  for (const file of files) {
    const version = file.slice(0, -4);
    const sql = await readFile(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]);
    if (existing.rowCount > 0) {
      if (existing.rows[0].checksum && existing.rows[0].checksum !== checksum) {
        throw new Error(`Checksum diferente para migration já aplicada: ${version}`);
      }
      console.log(`Migration ${version} já aplicada.`);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    console.log(`Migration ${version} aplicada.`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
