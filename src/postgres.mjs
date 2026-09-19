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

export async function withPostgresTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
