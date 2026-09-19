import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect } from '../src/database.mjs';
import { seedDemo, DEMO } from '../src/demo.mjs';
import { Pos } from '../src/pos.mjs';
export {DEMO};
export const PASSWORD='Tests-only-password-2026!';
export const key=()=>randomUUID();
export function fixture(t,{file=false,hooks={}}={}) {
  const dir=file?mkdtempSync(join(tmpdir(),'jcs-pdv-test-')):null;
  const filename=dir?join(dir,'test.sqlite'):':memory:';
  const db=connect(filename);seedDemo(db,PASSWORD);
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
export function counts(db){return Object.fromEntries(['sales','sale_items','payments','stock_movements','cash_movements','operations','audit_events'].map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));}
