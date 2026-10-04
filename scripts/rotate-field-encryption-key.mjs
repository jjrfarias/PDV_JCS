import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { decryptFieldWithKey, encryptFieldWithKey, fieldDigestWithKey, fieldKeyId, parseFieldKey } from '../src/security.mjs';

const {Pool}=pg;
const databaseUrl=process.env.PG_MIGRATION_DATABASE_URL;
const oldKey=parseFieldKey(process.env.JCS_OLD_FIELD_ENCRYPTION_KEY);
const newKey=parseFieldKey(process.env.JCS_NEW_FIELD_ENCRYPTION_KEY);
if(!databaseUrl||!oldKey||!newKey)throw new Error('PG_MIGRATION_DATABASE_URL e chaves antiga/nova válidas são obrigatórias.');
if(fieldKeyId(oldKey)===fieldKeyId(newKey))throw new Error('A chave nova deve ser diferente da chave atual.');
if(process.env.PDV_ROTATION_MAINTENANCE!=='CONFIRM_APP_STOPPED')throw new Error('Pare a aplicação e defina PDV_ROTATION_MAINTENANCE=CONFIRM_APP_STOPPED.');
if(process.env.PDV_ROTATION_CONFIRM!=='ROTATE_FIELD_KEY')throw new Error('PDV_ROTATION_CONFIRM deve ser exatamente ROTATE_FIELD_KEY.');

const pool=new Pool({connectionString:databaseUrl,max:1}),client=await pool.connect();
const encrypted=value=>value?encryptFieldWithKey(decryptFieldWithKey(value,oldKey),newKey):null;
try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='10s'");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pdv-jcs-field-key-rotation',0))");
  const role=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if(!role.rows[0]?.rolsuper&&!role.rows[0]?.rolbypassrls)throw new Error('Use uma conexão administrativa/migration, nunca a DATABASE_URL runtime.');
  await client.query('LOCK TABLE customers, users, platform_admins IN ACCESS EXCLUSIVE MODE');

  const customers=await client.query('SELECT * FROM customers FOR UPDATE');
  for(const row of customers.rows){
    const document=decryptFieldWithKey(row.document_enc,oldKey),phone=decryptFieldWithKey(row.phone_enc,oldKey),email=decryptFieldWithKey(row.email_enc,oldKey);
    await client.query(`UPDATE customers SET name_enc=$1,document_hash=$2,document_enc=$3,phone_hash=$4,phone_enc=$5,email_hash=$6,email_enc=$7,note_enc=$8 WHERE tenant_id=$9 AND id=$10`,
      [encrypted(row.name_enc),fieldDigestWithKey(document,newKey),document?encryptFieldWithKey(document,newKey):null,
        fieldDigestWithKey(phone,newKey),phone?encryptFieldWithKey(phone,newKey):null,
        fieldDigestWithKey(email,newKey),email?encryptFieldWithKey(email,newKey):null,encrypted(row.note_enc),row.tenant_id,row.id]);
  }
  const users=await client.query('SELECT tenant_id,id,mfa_secret_enc,mfa_pending_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL OR mfa_pending_secret_enc IS NOT NULL FOR UPDATE');
  for(const row of users.rows)await client.query('UPDATE users SET mfa_secret_enc=$1,mfa_pending_secret_enc=$2 WHERE tenant_id=$3 AND id=$4',
    [encrypted(row.mfa_secret_enc),encrypted(row.mfa_pending_secret_enc),row.tenant_id,row.id]);
  const admins=await client.query('SELECT id,mfa_secret_enc,mfa_pending_secret_enc FROM platform_admins WHERE mfa_secret_enc IS NOT NULL OR mfa_pending_secret_enc IS NOT NULL FOR UPDATE');
  for(const row of admins.rows)await client.query('UPDATE platform_admins SET mfa_secret_enc=$1,mfa_pending_secret_enc=$2 WHERE id=$3',
    [encrypted(row.mfa_secret_enc),encrypted(row.mfa_pending_secret_enc),row.id]);
  const details={fromKeyId:fieldKeyId(oldKey),toKeyId:fieldKeyId(newKey),customers:customers.rowCount,users:users.rowCount,platformAdmins:admins.rowCount};
  await client.query("INSERT INTO security_maintenance_events(id,action,details_json,created_at) VALUES($1,'FIELD_KEY_ROTATED',$2,$3)",
    [randomUUID(),JSON.stringify(details),new Date().toISOString()]);
  await client.query('COMMIT');
  console.log(`Rotação concluída: ${customers.rowCount} clientes, ${users.rowCount} usuários MFA e ${admins.rowCount} administradores MFA.`);
}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();await pool.end();}
