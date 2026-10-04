// Recuperação operacional quando uma conta privilegiada perde o autenticador.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const {Pool}=pg;
const databaseUrl=process.env.PG_MIGRATION_DATABASE_URL;
const target=process.env.PDV_MFA_TARGET?.trim().toLowerCase();
const email=process.env.PDV_MFA_EMAIL?.trim().toLowerCase();
const tenant=process.env.PDV_MFA_TENANT?.trim().toLowerCase();
if(!databaseUrl||!target||!email)throw new Error('PG_MIGRATION_DATABASE_URL, PDV_MFA_TARGET e PDV_MFA_EMAIL sao obrigatorias.');
if(!['platform','manager'].includes(target))throw new Error('PDV_MFA_TARGET deve ser platform ou manager.');
if(target==='manager'&&!tenant)throw new Error('PDV_MFA_TENANT e obrigatoria para gerente.');
if(process.env.PDV_MFA_CONFIRM!=='RESET_MFA')throw new Error('PDV_MFA_CONFIRM deve ser exatamente RESET_MFA.');
const pool=new Pool({connectionString:databaseUrl,max:1}),client=await pool.connect();
try{
  await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pdv-jcs-mfa-reset',0))");
  const role=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if(!role.rows[0]?.rolsuper&&!role.rows[0]?.rolbypassrls)throw new Error('Use uma conexao administrativa/migration, nao a DATABASE_URL runtime.');
  if(target==='platform'){
    const found=await client.query('SELECT id FROM platform_admins WHERE email=$1 AND active=1 FOR UPDATE',[email]);
    if(found.rowCount!==1)throw new Error('Administrador ativo nao encontrado.');const id=found.rows[0].id;
    await client.query('UPDATE platform_admins SET mfa_secret_enc=NULL,mfa_pending_secret_enc=NULL,mfa_enabled=0 WHERE id=$1',[id]);
    await client.query('DELETE FROM platform_sessions WHERE admin_id=$1',[id]);
    await client.query("INSERT INTO platform_audit_events(id,admin_id,action,entity_id,details_json,created_at) VALUES($1,$2,'PLATFORM_MFA_RESET',$2,$3,$4)",[randomUUID(),id,JSON.stringify({source:'operational-recovery'}),Date.now()]);
  }else{
    const found=await client.query("SELECT u.tenant_id,u.id FROM tenants t JOIN users u ON u.tenant_id=t.id WHERE t.slug=$1 AND u.email=$2 AND u.role='MANAGER' AND u.active=1 FOR UPDATE",[tenant,email]);
    if(found.rowCount!==1)throw new Error('Gerente ativo nao encontrado.');const user=found.rows[0];
    const store=await client.query('SELECT store_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 ORDER BY store_id LIMIT 1',[user.tenant_id,user.id]);
    if(store.rowCount!==1)throw new Error('Gerente sem loja vinculada; recuperacao bloqueada.');
    await client.query('UPDATE users SET mfa_secret_enc=NULL,mfa_pending_secret_enc=NULL,mfa_enabled=0 WHERE tenant_id=$1 AND id=$2',[user.tenant_id,user.id]);
    await client.query('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2',[user.tenant_id,user.id]);
    await client.query("INSERT INTO audit_events(tenant_id,id,user_id,store_id,action,entity_id,details_json,created_at) VALUES($1,$2,$3,$4,'MFA_RESET_ADMIN',$3,$5,$6)",[user.tenant_id,randomUUID(),user.id,store.rows[0].store_id,JSON.stringify({source:'operational-recovery'}),new Date().toISOString()]);
  }
  await client.query('COMMIT');console.log('MFA removido, sessoes encerradas e recuperacao auditada. A conta deve ativar o MFA novamente no proximo acesso.');
}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();await pool.end();}
