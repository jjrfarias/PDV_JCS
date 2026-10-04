import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

const { Pool } = pg;

export function createPostgresPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL é obrigatória para PostgreSQL.');
  return new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined
  });
}

// Recusa subir quando o código espera migrations que o banco não tem, ou quando uma migration aplicada foi editada.
// Com a verificação de saúde da Railway, a versão antiga continua no ar até as migrations serem aplicadas.
export async function assertMigrationsApplied(pool, dir = new URL('../migrations/', import.meta.url)) {
  const files = (await readdir(dir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  const applied = new Map((await pool.query('SELECT version, checksum FROM schema_migrations')).rows.map(row => [row.version, row.checksum]));
  const pending = [], changed = [];
  for (const file of files) {
    const version = file.slice(0, -4);
    if (!applied.has(version)) { pending.push(version); continue; }
    const expected = applied.get(version);
    const actual = createHash('sha256').update((await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n')).digest('hex');
    if (expected && expected !== actual) changed.push(version);
  }
  if (pending.length) throw new Error(`Migrations pendentes no banco: ${pending.join(', ')}. Aplique com npm run migrate:postgres antes do deploy.`);
  if (changed.length) throw new Error(`Migrations aplicadas foram editadas no código: ${changed.join(', ')}. Restaure o conteúdo aplicado e crie uma migration nova.`);
  return files.length;
}

export async function validatePostgresRuntime(pool) {
  const client = await pool.connect();
  try {
    const role = await one(client, `SELECT current_user AS name, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`);
    if (role?.rolsuper || role?.rolbypassrls) {
      throw new Error('DATABASE_URL deve usar role runtime sem SUPERUSER/BYPASSRLS.');
    }
    const owned = await one(client, `SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p')
        AND pg_get_userbyid(c.relowner) = current_user
        AND c.relname <> 'schema_migrations'
      LIMIT 1`);
    if (owned) throw new Error(`Role runtime não pode ser dona da tabela ${owned.relname}.`);
    await client.query(`SELECT set_config('app.tenant_id','__runtime_check__',true)`);
    await client.query('SELECT 1 FROM tenants LIMIT 1');
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction(pool, work, scope = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (scope.readOnly) await client.query('SET TRANSACTION READ ONLY');
    if (scope.tenantId) {
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [scope.tenantId]);
    }
    if (scope.userId) {
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [scope.userId]);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export const one = async (client, text, values = []) => {
  const result = await client.query(text, values);
  return result.rows[0] ?? null;
};

export const all = async (client, text, values = []) => {
  const result = await client.query(text, values);
  return result.rows;
};

export const run = async (client, text, values = []) => {
  const result = await client.query(text, values);
  return { changes: result.rowCount, rows: result.rows };
};
