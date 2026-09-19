import pg from 'pg';

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
