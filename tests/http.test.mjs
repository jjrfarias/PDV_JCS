import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/http.mjs';
import { fixture,PASSWORD,DEMO,key } from './helpers.mjs';

async function web(t){
  const {db,pos}=fixture(t);const server=createApp(db);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  let cookie='',csrf='';
  async function call(path,{method='GET',body,headers={}}={}) {
    const response=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf,...headers},body:body?JSON.stringify(body):undefined});
    const content=await response.text();let data;try{data=JSON.parse(content);}catch{data=content;}
    return {response,data};
  }
  async function login(email='gerente@jcs.local',tenant='demo') {
    const result=await call('/api/login',{method:'POST',body:{tenant,email,password:PASSWORD}});
    assert.equal(result.response.status,200);
    cookie=result.response.headers.get('set-cookie').split(';')[0];csrf=result.data.csrfToken;
    return result;
  }
  return {db,pos,server,origin,call,login};
}

test('HTTP 01 · login emite cookie HttpOnly/SameSite e sessão não vai ao JSON',async t=>{
  const w=await web(t),result=await w.login();const header=result.response.headers.get('set-cookie');
  assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.equal(result.data.token,undefined);
  const me=await w.call('/api/me');assert.equal(me.data.user.role,'MANAGER');assert.equal(me.data.stores.length,2);
});
test('HTTP 02 · rota exige autenticação',async t=>{
  const w=await web(t);assert.equal((await w.call('/api/stores/store-a/state')).response.status,401);
});
test('HTTP 03 · origem externa é bloqueada inclusive no login',async t=>{
  const w=await web(t);const result=await w.call('/api/login',{method:'POST',headers:{Origin:'http://evil.invalid'},body:{tenant:'demo',email:'gerente@jcs.local',password:PASSWORD}});
  assert.equal(result.response.status,403);assert.equal(result.data.error.code,'ORIGIN_FORBIDDEN');
});
test('HTTP 04 · token CSRF incorreto impede mutação',async t=>{
  const w=await web(t);await w.login();
  const r=await w.call('/api/cash/open',{method:'POST',headers:{'X-CSRF-Token':'invalid','Idempotency-Key':key()},body:{storeId:DEMO.storeA,terminalId:DEMO.terminalA,openingCents:10000}});
  assert.equal(r.response.status,403);assert.equal(r.data.error.code,'CSRF_FORBIDDEN');
});
test('HTTP 05 · venda e recuperação via API são persistentes e idempotentes',async t=>{
  const w=await web(t);await w.login();
  const cash=await w.call('/api/cash/open',{method:'POST',headers:{'Idempotency-Key':key()},body:{storeId:DEMO.storeA,terminalId:DEMO.terminalA,openingCents:10000}});
  assert.equal(cash.response.status,201);
  const saleKey=key(),body={storeId:DEMO.storeA,cashSessionId:cash.data.data.id,items:[{productId:DEMO.product,quantity:2}],discountCents:500,discountReason:'Teste HTTP',tenderedCents:5000};
  const first=await w.call('/api/sales',{method:'POST',headers:{'Idempotency-Key':saleKey},body});
  assert.equal(first.response.status,201);assert.equal(first.data.data.total_cents,4500);
  const second=await w.call('/api/sales',{method:'POST',headers:{'Idempotency-Key':saleKey},body});
  assert.equal(second.response.status,200);assert.equal(second.data.replayed,true);assert.equal(second.data.data.id,first.data.data.id);
  assert.equal((await w.call(`/api/operations/${saleKey}`)).data.data.id,first.data.data.id);
});
test('HTTP 06 · loja B não aparece nem é acessível para operador A',async t=>{
  const w=await web(t);await w.login('operador@jcs.local');
  assert.equal((await w.call('/api/me')).data.stores.length,1);
  assert.equal((await w.call('/api/stores/store-b/state')).response.status,403);
});
test('HTTP 07 · logout invalida sessão no servidor',async t=>{
  const w=await web(t);await w.login();await w.call('/api/logout',{method:'POST',body:{}});
  assert.equal((await w.call('/api/me')).response.status,401);
});
test('HTTP 08 · senha incorreta é recusada sem indicar se a conta existe',async t=>{
  const w=await web(t);
  const existing=await w.call('/api/login',{method:'POST',body:{tenant:'demo',email:'gerente@jcs.local',password:'senha-errada'}});
  const missing=await w.call('/api/login',{method:'POST',body:{tenant:'demo',email:'inexistente@jcs.local',password:'senha-errada'}});
  assert.equal(existing.response.status,401);assert.deepEqual(existing.data,missing.data);
});
test('HTTP 09 · limite de tentativas de login é aplicado',async t=>{
  const w=await web(t);let last;
  for(let i=0;i<9;i++)last=await w.call('/api/login',{method:'POST',body:{tenant:'demo',email:'gerente@jcs.local',password:'incorreta'}});
  assert.equal(last.response.status,429);
});
test('HTTP 10 · Host arbitrário é recusado contra DNS rebinding',async t=>{
  const w=await web(t);
  const status=await new Promise((resolve,reject)=>{const req=request(w.origin+'/health',{headers:{Host:'evil.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
  assert.equal(status,403);
});
test('HTTP 11 · arquivo de senhas, esquema e banco não são servidos',async t=>{
  const w=await web(t);for(const path of ['/data/ACESSOS-LOCAIS.txt','/data/pdv.sqlite','/src/schema.sql'])assert.equal((await w.call(path)).response.status,404);
});
test('HTTP 12 · sessão expirada exige novo login',async t=>{
  const w=await web(t);await w.login();w.db.prepare('UPDATE sessions SET expires_at=0').run();
  assert.equal((await w.call('/api/me')).response.status,401);
});
test('HTTP 13 · corpo grande e tipo de conteúdo incorreto são rejeitados',async t=>{
  const w=await web(t);
  assert.equal((await w.call('/api/login',{method:'POST',body:{tenant:'demo',email:'x',password:'a'.repeat(40000)}})).response.status,413);
  assert.equal((await w.call('/api/login',{method:'POST',headers:{'Content-Type':'text/plain'},body:{}})).response.status,415);
});
