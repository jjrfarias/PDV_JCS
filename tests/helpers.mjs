import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from '../src/database.mjs';
import { seedDemo, DEMO } from '../src/demo.mjs';
import { Pos } from '../src/pos.mjs';
import { encryptField } from '../src/security.mjs';
import { totpCode } from '../src/totp.mjs';
export {DEMO};
process.env.JCS_FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
export const PASSWORD='Tests-only-password-2026!';
export const key=()=>randomUUID();
// Chave TOTP fixa, usada só nos testes. Gerentes e administradores precisam de MFA ativo para operar.
export const TEST_MFA_SECRET='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export function enableTestMfa(db,table='users',where="role='MANAGER'"){db.prepare(`UPDATE ${table} SET mfa_enabled=1,mfa_secret_enc=? WHERE ${where}`).run(encryptField(TEST_MFA_SECRET));}
// Código válido para a próxima tentativa de login. Zera o último intervalo usado para o teste poder entrar várias vezes.
export function testMfaCode(db,table,email){
  const address=String(email??'').toLowerCase();
  const row=db.prepare(`SELECT mfa_enabled FROM ${table} WHERE email=?`).get(address);
  if(row?.mfa_enabled!==1)return undefined;
  db.prepare(`UPDATE ${table} SET mfa_last_step=NULL WHERE email=?`).run(address);
  return totpCode(TEST_MFA_SECRET);
}
export function fixture(t,{file=false,hooks={},mfa=true}={}) {
  const dir=file?mkdtempSync(join(tmpdir(),'jcs-pdv-test-')):null;
  const filename=dir?join(dir,'test.sqlite'):':memory:';
  const db=connect(filename);seedDemo(db,PASSWORD);if(mfa)enableTestMfa(db);
  const pos=new Pos(db,hooks);
  t.after(()=>{try{db.close();}catch{}if(dir)rmSync(dir,{recursive:true,force:true});});
  return {db,pos,filename,dir};
}
export function open(pos,ctx=DEMO.manager,terminalId=DEMO.terminalA){
  const storeId=terminalId===DEMO.terminalB?DEMO.storeB:DEMO.storeA;
  return pos.openCash(ctx,key(),{storeId,terminalId,openingCents:10000}).data;
}
export function saleInput(cash,overrides={}) {
  return {storeId:cash.store_id,cashSessionId:cash.id,items:[{productId:DEMO.product,quantity:2}],discountCents:500,discountReason:'Teste de autorização',tenderedCents:5000,...overrides};
}
export function counts(db){return Object.fromEntries(['sales','sale_items','payments','sale_cancellations','sale_returns','sale_return_items','stock_movements','cash_movements','operations','audit_events'].map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));}
