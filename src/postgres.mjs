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
