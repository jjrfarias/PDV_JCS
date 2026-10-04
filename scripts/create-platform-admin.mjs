// Cria um administrador do sistema (acima dos tenants). Uso operacional, com conexão admin ao banco.
// A conta nasce com senha inutilizável: o administrador define a própria senha por "Esqueci minha senha" em /admin.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword, randomToken } from '../src/security.mjs';

const { Pool } = pg;
const databaseUrl = process.env.PG_MIGRATION_DATABASE_URL;
const email = process.env.PDV_ADMIN_EMAIL?.trim().toLowerCase();
const name = process.env.PDV_ADMIN_NAME?.trim();
const confirm = process.env.PDV_ADMIN_CONFIRM;

for (const [key, value] of Object.entries({ PG_MIGRATION_DATABASE_URL: databaseUrl, PDV_ADMIN_EMAIL: email, PDV_ADMIN_NAME: name, PDV_ADMIN_CONFIRM: confirm })) {
  if (!value) throw new Error(`${key} e obrigatoria.`);
}
if (confirm !== 'CREATE_PLATFORM_ADMIN') throw new Error('PDV_ADMIN_CONFIRM deve ser exatamente CREATE_PLATFORM_ADMIN.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('PDV_ADMIN_EMAIL invalido.');

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT id, active FROM platform_admins WHERE email=$1', [email]);
  if (existing.rowCount) {
    console.log(`Administrador ja existe (ativo=${existing.rows[0].active}). Nada alterado.`);
  } else {
    const id = `admin-${randomUUID()}`;
    const now = Date.now();
    await client.query('INSERT INTO platform_admins(id,email,name,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [id, email, name, hashPassword(randomToken()), now]);
    await client.query(`INSERT INTO platform_audit_events(id,admin_id,action,entity_id,details_json,created_at)
      VALUES($1,NULL,'PLATFORM_ADMIN_CREATED',$2,'{"source":"script"}',$3)`, [randomUUID(), id, now]);
    console.log('Administrador criado. Defina a senha em /admin pelo link "Esqueci minha senha".');
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
