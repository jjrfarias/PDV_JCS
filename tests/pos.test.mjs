import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { connect } from '../src/database.mjs';
import { Pos } from '../src/pos.mjs';
import { transaction } from '../src/database.mjs';
import { seedDemo } from '../src/demo.mjs';
import { cents } from '../public/money.mjs';
import { fixture,open,saleInput,counts,key,DEMO } from './helpers.mjs';
const fails=(fn,code)=>assert.throws(fn,error=>error.code===code);

test('01 · cenário R$100 / R$50 / R$5 / R$45 / troco R$5 / saldo R$145',t=>{
  const {pos}=fixture(t);const cash=open(pos);const sale=pos.sell(DEMO.manager,key(),saleInput(cash)).data;
  assert.equal(sale.subtotal_cents,5000);assert.equal(sale.discount_cents,500);assert.equal(sale.total_cents,4500);
  assert.equal(sale.payment.tendered_cents,5000);assert.equal(sale.payment.change_cents,500);
  assert.equal(sale.status,'CONFIRMED');assert.equal(sale.payment.status,'CONFIRMED');assert.equal(sale.fiscal_status,'TEST_NOT_ISSUED');
  assert.equal(pos.state(DEMO.manager,DEMO.storeA).products[0].quantity,8);
  assert.equal(pos.state(DEMO.manager,DEMO.storeB).products[0].quantity,30);
  assert.equal(pos.cash(DEMO.manager,cash.id).expected_cents,14500);
  const closed=pos.closeCash(DEMO.manager,key(),{storeId:DEMO.storeA,cashSessionId:cash.id,countedCents:14500,reason:null}).data;
  assert.equal(closed.status,'CLOSED');assert.equal(closed.difference_cents,0);
});
test('02 · repetir a venda devolve o mesmo resultado sem novos efeitos',t=>{
  const {pos,db}=fixture(t);const cash=open(pos),k=key(),input=saleInput(cash);
  const first=pos.sell(DEMO.manager,k,input),before=counts(db);
  const second=pos.sell(DEMO.manager,k,input);
  assert.equal(second.replayed,true);assert.equal(second.data.id,first.data.id);assert.deepEqual(counts(db),before);
});
test('03 · mesma chave com valores diferentes é recusada',t=>{
  const {pos,db}=fixture(t);const cash=open(pos),k=key();pos.sell(DEMO.manager,k,saleInput(cash));const before=counts(db);
  fails(()=>pos.sell(DEMO.manager,k,saleInput(cash,{tenderedCents:6000})),'IDEMPOTENCY_CONFLICT');assert.deepEqual(counts(db),before);
});
test('04 · resposta perdida pode ser recuperada por chave',t=>{
  const {pos}=fixture(t);const cash=open(pos),k=key();const id=pos.sell(DEMO.manager,k,saleInput(cash)).data.id;
  assert.equal(pos.operation(DEMO.manager,k).data.id,id);
});
test('05 · falha antes de COMMIT desfaz venda, pagamento, estoque, caixa, auditoria e chave',t=>{
  const {db,pos}=fixture(t);const cash=open(pos),before=counts(db);
  const faulty=new Pos(db,{beforeCommit:kind=>{if(kind==='SALE')throw new Error('INJECTED_FAILURE');}});
  assert.throws(()=>faulty.sell(DEMO.manager,key(),saleInput(cash)),/INJECTED_FAILURE/);
  assert.deepEqual(counts(db),before);assert.equal(pos.state(DEMO.manager,DEMO.storeA).products[0].quantity,10);
  assert.equal(pos.cash(DEMO.manager,cash.id).expected_cents,10000);
});
test('06 · estoque insuficiente não gera registros parciais',t=>{
  const {pos,db}=fixture(t);const cash=open(pos),before=counts(db);
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{items:[{productId:DEMO.product,quantity:11}],discountCents:0,tenderedCents:50000})),'INSUFFICIENT_STOCK');
  assert.deepEqual(counts(db),before);
});
test('07 · venda em caixa fechado é recusada',t=>{
  const {pos}=fixture(t);const cash=open(pos);pos.closeCash(DEMO.manager,key(),{storeId:DEMO.storeA,cashSessionId:cash.id,countedCents:10000});
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash)),'CASH_CLOSED');
});
test('08 · operador sem permissão não concede desconto',t=>{
  const {pos}=fixture(t);const cash=open(pos,DEMO.cashier);
  fails(()=>pos.sell(DEMO.cashier,key(),saleInput(cash)),'DISCOUNT_FORBIDDEN');
});
test('09 · operador vende sem desconto em seu próprio caixa',t=>{
  const {pos}=fixture(t);const cash=open(pos,DEMO.cashier);
  const sale=pos.sell(DEMO.cashier,key(),saleInput(cash,{discountCents:0,discountReason:null})).data;
  assert.equal(sale.total_cents,5000);assert.equal(sale.discount_author_id,null);
});
test('10 · gerente precisa justificar desconto e respeitar limite',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{discountReason:null})),'DISCOUNT_REASON_REQUIRED');
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{discountCents:1001})),'DISCOUNT_LIMIT');
});
test('11 · acesso direto de operador à loja B é bloqueado',t=>{
  const {pos}=fixture(t);fails(()=>pos.state(DEMO.cashier,DEMO.storeB),'STORE_FORBIDDEN');
});
test('12 · contratante A não acessa loja de B',t=>{
  const {pos}=fixture(t);fails(()=>pos.state(DEMO.manager,DEMO.otherStore),'STORE_FORBIDDEN');
});
test('13 · ID de produto de outro contratante não é aceito na venda',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{items:[{productId:'product-other',quantity:1}]})),'PRODUCT_NOT_FOUND');
});
test('14 · caixa de outra loja não pode receber a venda',t=>{
  const {pos}=fixture(t);const cash=open(pos,DEMO.manager,DEMO.terminalB);
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{storeId:DEMO.storeA})),'CASH_STORE_MISMATCH');
});
test('15 · preço, total e tenant enviados pelo navegador são rejeitados',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  for(const field of ['totalCents','tenantId','priceCents'])fails(()=>pos.sell(DEMO.manager,key(),{...saleInput(cash),[field]:1}),'UNKNOWN_FIELD');
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{items:[{productId:DEMO.product,quantity:1,priceCents:1}]})),'UNKNOWN_FIELD');
});
test('16 · valores fracionários, negativos, NaN e quantidades repetidas são recusados',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  for(const qty of [0,-1,1.5,NaN,10001])fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{items:[{productId:DEMO.product,quantity:qty}]})),'INVALID_INPUT');
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{items:[{productId:DEMO.product,quantity:1},{productId:DEMO.product,quantity:1}]})),'DUPLICATE_ITEM');
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{discountCents:-1})),'INVALID_INPUT');
});
test('17 · dinheiro insuficiente é recusado sem baixa',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  fails(()=>pos.sell(DEMO.manager,key(),saleInput(cash,{tenderedCents:4000})),'INSUFFICIENT_CASH');
  assert.equal(pos.state(DEMO.manager,DEMO.storeA).products[0].quantity,10);
});
test('18 · reabertura simultânea do mesmo terminal não cria dois caixas',t=>{
  const {pos}=fixture(t);open(pos);fails(()=>open(pos),'CASH_ALREADY_OPEN');
});
test('19 · abertura e fechamento também são idempotentes',t=>{
  const {pos}=fixture(t);const k=key(),body={storeId:DEMO.storeA,terminalId:DEMO.terminalA,openingCents:10000};
  const cash=pos.openCash(DEMO.manager,k,body).data;assert.equal(pos.openCash(DEMO.manager,k,body).data.id,cash.id);
  const closeKey=key(),input={storeId:DEMO.storeA,cashSessionId:cash.id,countedCents:10000};
  pos.closeCash(DEMO.manager,closeKey,input);assert.equal(pos.closeCash(DEMO.manager,closeKey,input).replayed,true);
});
test('20 · outro operador não vende nem fecha o caixa do gerente',t=>{
  const {pos}=fixture(t);const cash=open(pos);
  fails(()=>pos.sell(DEMO.cashier,key(),saleInput(cash,{discountCents:0})),'CASH_OWNER_REQUIRED');
  fails(()=>pos.closeCash(DEMO.cashier,key(),{storeId:DEMO.storeA,cashSessionId:cash.id,countedCents:10000}),'CASH_OWNER_REQUIRED');
});
test('21 · fechamento com diferença exige motivo e registra divergência',t=>{
  const {pos}=fixture(t);const cash=open(pos);const body={storeId:DEMO.storeA,cashSessionId:cash.id,countedCents:9500};
  fails(()=>pos.closeCash(DEMO.manager,key(),body),'CLOSE_REASON_REQUIRED');
  assert.equal(pos.closeCash(DEMO.manager,key(),{...body,reason:'Diferença fictícia para teste'}).data.difference_cents,-500);
});
test('22 · cadastro mantém movimento inicial e impede código duplicado',t=>{
  const {pos}=fixture(t);const input={storeId:DEMO.storeA,sku:'ABC-123',name:'Produto novo',priceCents:1990,initialQuantity:5,barcode:'00123'};
  const product=pos.createProduct(DEMO.manager,key(),input).data;
  const state=pos.state(DEMO.manager,DEMO.storeA);assert.equal(state.products.find(p=>p.id===product.id).quantity,5);
  assert.equal(state.stockMovements.find(m=>m.product_id===product.id).quantity,5);
  fails(()=>pos.createProduct(DEMO.manager,key(),input),'DUPLICATE_PRODUCT');
});
test('23 · alteração posterior de cadastro não muda snapshot de venda',t=>{
  const {pos,db}=fixture(t);const cash=open(pos),sale=pos.sell(DEMO.manager,key(),saleInput(cash)).data;
  db.prepare('UPDATE products SET price_cents=9999,name=? WHERE tenant_id=? AND id=?').run('Nome alterado em teste',DEMO.manager.tenantId,DEMO.product);
  const recovered=pos.receipt(DEMO.manager,sale.id);assert.equal(recovered.items[0].price_cents,2500);assert.notEqual(recovered.items[0].name_snapshot,'Nome alterado em teste');
});
test('24 · registros confirmados não podem ser apagados ou alterados',t=>{
  const {pos,db}=fixture(t);pos.sell(DEMO.manager,key(),saleInput(open(pos)));
  assert.throws(()=>db.exec('DELETE FROM sales'),/immutable_record/);assert.throws(()=>db.exec('UPDATE payments SET amount_cents=1'),/immutable_record/);
});
test('25 · chaves estrangeiras compostas bloqueiam mistura de empresas',t=>{
  const {db}=fixture(t);
  assert.throws(()=>db.prepare('INSERT INTO stock VALUES(?,?,?,?)').run('tenant-demo',DEMO.storeA,'product-other',3),/FOREIGN KEY/);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('26 · reinício preserva venda e seed não repõe saldo',t=>{
  const {db,pos,filename}=fixture(t,{file:true});const cash=open(pos),k=key();const original=pos.sell(DEMO.manager,k,saleInput(cash)).data;
  db.close();const reopened=connect(filename);t.after(()=>{try{reopened.close();}catch{}});
  assert.equal(seedDemo(reopened),null);const service=new Pos(reopened);
  assert.equal(service.receipt(DEMO.manager,original.id).total_cents,4500);
  assert.equal(service.state(DEMO.manager,DEMO.storeA).products[0].quantity,8);
  assert.equal(service.sell(DEMO.manager,k,saleInput(cash)).replayed,true);
  reopened.close();
});
test('27 · conversão monetária decimal exata e limites',()=>{
  assert.equal(cents('25,00'),2500);assert.equal(cents('0.29'),29);assert.equal(cents('100'),10000);assert.equal(cents('0,1'),10);
  for(const v of ['-1','1,001','1e3','1.000,00','Infinity','1000001'])assert.throws(()=>cents(v));
});
test('28 · mesma chave não expõe resposta para outro operador',t=>{
  const {pos}=fixture(t);const cash=open(pos),k=key();pos.sell(DEMO.manager,k,saleInput(cash));
  fails(()=>pos.operation(DEMO.cashier,k),'NOT_FOUND');
  fails(()=>pos.sell(DEMO.cashier,k,saleInput(cash)),'IDEMPOTENCY_CONFLICT');
});
test('29 · desativar usuário bloqueia acesso mesmo com contexto previamente obtido',t=>{
  const {pos,db}=fixture(t);db.prepare('UPDATE users SET active=0 WHERE tenant_id=? AND id=?').run(DEMO.manager.tenantId,DEMO.manager.userId);
  fails(()=>pos.state(DEMO.manager,DEMO.storeA),'AUTH_REQUIRED');
});
test('30 · duas conexões reais disputam a última unidade: apenas uma confirma',async t=>{
  const {pos,db,filename}=fixture(t,{file:true});const cash1=open(pos),cash2=open(pos,DEMO.manager,DEMO.terminalA2);
  const product=pos.createProduct(DEMO.manager,key(),{storeId:DEMO.storeA,sku:'LAST',name:'Última unidade',priceCents:100,initialQuantity:1}).data;
  const startGate=new SharedArrayBuffer(4);
  const jobs=[cash1,cash2].map(cash=>{
    const worker=new Worker(new URL('./race-worker.mjs',import.meta.url),{workerData:{filename,startGate,cashId:cash.id,productId:product.id,key:key()}});
    const ready=new Promise((resolve,reject)=>{worker.once('error',reject);worker.on('message',m=>{if(m.ready)resolve();});});
    const done=new Promise((resolve,reject)=>{worker.once('error',reject);worker.on('message',m=>{if(m.result)resolve(m.result);});});
    const exited=new Promise(resolve=>worker.once('exit',resolve));
    return {worker,ready,done,exited};
  });
  t.after(()=>Promise.all(jobs.map(j=>j.worker.terminate())));
  await Promise.all(jobs.map(j=>j.ready));Atomics.store(new Int32Array(startGate),0,1);Atomics.notify(new Int32Array(startGate),0,2);
  const results=await Promise.all(jobs.map(j=>j.done));await Promise.all(jobs.map(j=>j.exited));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'INSUFFICIENT_STOCK');
  assert.equal(db.prepare('SELECT quantity FROM stock WHERE tenant_id=? AND store_id=? AND product_id=?').get(DEMO.manager.tenantId,DEMO.storeA,product.id).quantity,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sales').get().n,1);
});
test('31 · transação não aceita função assíncrona',t=>{
  const {db}=fixture(t);assert.throws(()=>transaction(db,()=>Promise.resolve()),/assíncrona/);
  assert.equal(db.isTransaction,false);
});
