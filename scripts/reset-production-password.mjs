import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../src/security.mjs';

const { Pool } = pg;

const databaseUrl = process.env.PG_MIGRATION_DATABASE_URL;
const tenant = process.env.PDV_RESET_TENANT?.trim().toLowerCase();
const email = process.env.PDV_RESET_EMAIL?.trim().toLowerCase();
const newPassword = process.env.PDV_RESET_NEW_PASSWORD;
const confirm = process.env.PDV_RESET_CONFIRM;

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} e obrigatoria.`);
}

requireEnv('PG_MIGRATION_DATABASE_URL', databaseUrl);
requireEnv('PDV_RESET_TENANT', tenant);
requireEnv('PDV_RESET_EMAIL', email);
requireEnv('PDV_RESET_NEW_PASSWORD', newPassword);
requireEnv('PDV_RESET_CONFIRM', confirm);

if (confirm !== 'RESET_PASSWORD') {
  throw new Error('PDV_RESET_CONFIRM deve ser exatamente RESET_PASSWORD.');
}
if (newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
  throw new Error('A nova senha deve ter 12 caracteres, com letras maiusculas, minusculas e numero.');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('pdv-jcs-password-reset',0))`);

  const role = await client.query(`SELECT current_user AS name, rolsuper, rolbypassrls
    FROM pg_roles WHERE rolname = current_user`);
  if (!role.rows[0]?.rolsuper && !role.rows[0]?.rolbypassrls) {
    const owned = await client.query(`SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','p')
        AND pg_get_userbyid(c.relowner) = current_user
        AND c.relname = 'users'
      LIMIT 1`);
    if (owned.rowCount === 0) {
      throw new Error('Use uma conexao administrativa/migration, nao a DATABASE_URL runtime.');
    }
  }

  const user = await client.query(`SELECT u.tenant_id, u.id, u.email, u.name
    FROM tenants t
    JOIN users u ON u.tenant_id = t.id
    WHERE t.slug = $1 AND u.email = $2 AND u.active = 1
    FOR UPDATE`, [tenant, email]);
  if (user.rowCount !== 1) throw new Error('Usuario ativo nao encontrado para empresa/e-mail informados.');

  const membership = await client.query(`SELECT store_id
    FROM memberships
    WHERE tenant_id = $1 AND user_id = $2
    ORDER BY store_id
    LIMIT 1`, [user.rows[0].tenant_id, user.rows[0].id]);
  if (membership.rowCount !== 1) throw new Error('Usuario sem loja vinculada; reset bloqueado para manter auditoria valida.');

  await client.query('UPDATE users SET password_hash = $1 WHERE tenant_id = $2 AND id = $3',
    [hashPassword(newPassword), user.rows[0].tenant_id, user.rows[0].id]);
  await client.query('DELETE FROM sessions WHERE tenant_id = $1 AND user_id = $2',
    [user.rows[0].tenant_id, user.rows[0].id]);
  await client.query(`INSERT INTO audit_events
    (tenant_id,id,user_id,store_id,action,entity_id,details_json,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [
    user.rows[0].tenant_id,
    randomUUID(),
    user.rows[0].id,
    membership.rows[0].store_id,
    'PASSWORD_RESET_ADMIN',
    user.rows[0].id,
    JSON.stringify({ email: user.rows[0].email }),
    new Date().toISOString()
  ]);

  await client.query('COMMIT');
  console.log(`Senha redefinida e sessoes invalidadas para ${user.rows[0].email}.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
