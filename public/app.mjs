import {cents,brl} from './money.mjs';
const $=id=>document.getElementById(id);
const state={me:null,data:null,cart:[],csrf:'',pending:null,busy:false,tab:'products',lastReceipt:null};
function element(tag,content,className=''){const node=document.createElement(tag);if(content!==undefined)node.textContent=String(content);if(className)node.className=className;return node;}
function message(value){
  $('message').textContent=value;$('message').hidden=!value;
  const dialog=document.querySelector('dialog[open]:not(#receipt-dialog)');
  if(dialog){let warning=dialog.querySelector('.dialog-error');if(!warning){warning=element('p',undefined,'dialog-error');warning.setAttribute('role','alert');dialog.prepend(warning);}warning.textContent=value;}
}
async function api(path,options={}){
  let response;
  try{response=await fetch(path,{...options,credentials:'same-origin',signal:AbortSignal.timeout(12_000),headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf,...options.headers}});}
  catch{throw Object.assign(new Error('Servidor indisponível ou resposta não recebida.'),{uncertain:true});}
  let data;try{data=await response.json();}catch{throw Object.assign(new Error('Resposta inválida. Confirme o resultado antes de repetir.'),{uncertain:true});}
  if(!response.ok)throw Object.assign(new Error(data.error?.message??'Falha na operação.'),{status:response.status,uncertain:response.status>=500});
  return data;
}
const storeId=()=> $('store-select').value;
const terminalId=()=> $('terminal-select').value;
const currentCash=()=>state.data?.cash.find(c=>c.terminal_id===terminalId());
const scope=()=>`jcs.pending.v1:${state.me.tenantId}:${state.me.user.id}`;
const manager=()=>state.me?.user.role==='MANAGER';
function lock(){
  const locked=state.busy||Boolean(state.pending);
  document.querySelectorAll('[data-edit],[data-write]').forEach(el=>el.disabled=locked);
  $('pending-panel').hidden=!state.pending;
  $('recover').disabled=state.busy;
  $('discount').disabled=locked||!manager();$('discount-reason').disabled=locked||!manager();
  const cash=currentCash();
  $('open-cash').disabled=locked||Boolean(cash);
  $('close-cash').disabled=locked||!cash||cash.operator_id!==state.me?.user.id;
  $('confirm-sale').disabled=locked||!cash||cash.operator_id!==state.me?.user.id||state.cart.length===0;
  $('new-product').hidden=!manager();
  $('password-open').disabled=locked;
  $('logout').disabled=locked;
}
async function refresh(){
  if(!state.me)return;
  state.data=await api(`/api/stores/${storeId()}/state`);
  const prior=terminalId();$('terminal-select').replaceChildren();
  for(const terminal of state.data.terminals){const option=element('option',terminal.name);option.value=terminal.id;$('terminal-select').append(option);}
  if(state.data.terminals.some(t=>t.id===prior))$('terminal-select').value=prior;
  renderCash();renderSearch();renderManagement();renderCart();
}
function renderCash(){
  const cash=currentCash();
  $('cash-label').textContent=cash?(cash.operator_id===state.me.user.id?'Caixa aberto':'Aberto por outro operador'):'Caixa fechado';
  $('opening-value').textContent=brl(cash?.opening_cents??0);
  $('sales-value').textContent=brl(cash?.sales_cents??0);
  $('expected-value').textContent=brl(cash?.expected_cents??0);lock();
}
function renderSearch(){
  const query=$('search').value.trim().toLowerCase();$('search-results').replaceChildren();
  if(!query)return;
  const products=state.data.products.filter(p=>[p.sku,p.name,p.barcode??''].some(v=>v.toLowerCase().includes(query))).slice(0,6);
  for(const product of products){const b=element('button',`${product.name} · ${brl(product.price_cents)} · saldo ${product.quantity}`);b.type='button';b.dataset.write='';b.addEventListener('click',()=>add(product));$('search-results').append(b);}
  if(!products.length)$('search-results').append(element('small','Nenhum produto encontrado.'));lock();
}
function add(product){
  if(state.pending||state.busy)return;
  const existing=state.cart.find(p=>p.id===product.id);
  if(existing)existing.units++;else state.cart.push({...product,units:1});
  $('search').value='';renderSearch();renderCart();$('search').focus();
}
function renderCart(){
  $('cart-body').replaceChildren();
  for(const p of state.cart){
    const tr=element('tr'),name=element('td',p.name);name.append(element('small',p.sku));
    const quantity=element('td'),input=element('input');input.type='number';input.min='1';input.max='10000';input.step='1';input.value=p.units;input.dataset.edit='';input.setAttribute('aria-label',`Quantidade de ${p.name}`);
    input.addEventListener('change',()=>{const n=Number(input.value);if(!Number.isInteger(n)||n<1||n>10000){input.value=p.units;message('Quantidade inválida.');return;}p.units=n;renderCart();});quantity.append(input);
    const action=element('td'),remove=element('button','Remover');remove.type='button';remove.dataset.write='';remove.addEventListener('click',()=>{state.cart=state.cart.filter(i=>i.id!==p.id);renderCart();});action.append(remove);
    tr.append(name,quantity,element('td',brl(p.price_cents),'number'),element('td',brl(p.price_cents*p.units),'number'),action);$('cart-body').append(tr);
  }
  $('empty-cart').hidden=state.cart.length>0;$('item-count').textContent=`${state.cart.reduce((sum,p)=>sum+p.units,0)} unidades`;
  renderTotals();lock();
}
function renderTotals(){
  const subtotal=state.cart.reduce((sum,p)=>sum+p.units*p.price_cents,0);
  let discount=0,tendered=0;try{discount=cents($('discount').value||'0');}catch{}try{tendered=cents($('tendered').value||'0');}catch{}
  const total=subtotal-discount;
  $('subtotal').textContent=brl(subtotal);$('total').textContent=brl(total);
  $('change').textContent=brl(Math.max(0,tendered-total));
}
function table(headers,rows){
  const t=element('table'),thead=element('thead'),head=element('tr');headers.forEach(h=>head.append(element('th',h)));thead.append(head);t.append(thead);
  const body=element('tbody');
  for(const row of rows){const tr=element('tr');for(const value of row){const td=element('td');if(value instanceof Node)td.append(value);else td.textContent=String(value);tr.append(td);}body.append(tr);}
  if(!rows.length){const tr=element('tr'),td=element('td','Nenhum registro nesta loja.');td.colSpan=headers.length;tr.append(td);body.append(tr);}t.append(body);return t;
}
const date=value=>new Date(value).toLocaleString('pt-BR');
function renderManagement(){
  const d=state.data;let content;
  if(state.tab==='products')content=table(['Código','Produto','Código de barras','Preço','Estoque'],d.products.map(p=>[p.sku,p.name,p.barcode??'—',brl(p.price_cents),p.quantity]));
  if(state.tab==='history')content=table(['Data','Venda','Desconto','Total','Comprovante'],d.sales.map(s=>{
    const b=element('button','Abrir');b.type='button';b.addEventListener('click',()=>run(async()=>showReceipt(await api(`/api/sales/${s.id}`))));
    return [date(s.created_at),s.id.slice(0,8),brl(s.discount_cents),brl(s.total_cents),b];}));
  if(state.tab==='stock')content=table(['Data','Produto','Movimento','Quantidade','Motivo'],d.stockMovements.map(m=>[date(m.created_at),m.name,m.kind==='SALE'?'Venda':'Entrada inicial',m.quantity,m.reason]));
  if(state.tab==='closures')content=table(['Data','Terminal','Esperado','Contado','Diferença'],d.cashHistory.map(c=>[date(c.closed_at),d.terminals.find(t=>t.id===c.terminal_id)?.name??c.terminal_id,brl(c.expected_cents),brl(c.counted_cents),brl(c.difference_cents)]));
  $('management-content').replaceChildren(content);
}
function showReceipt(sale){
  state.lastReceipt=sale;const root=$('receipt');root.replaceChildren();
  root.append(element('h2','JCS · COMPROVANTE DE TESTE'),element('div','TESTE — SEM VALOR FISCAL','receipt-warning'));
  root.append(element('p',`${sale.store_name} | ${sale.operator_name}`),element('p',`Venda ${sale.id}\n${date(sale.created_at)}`));
  root.append(table(['Produto','Qtd.','Total'],sale.items.map(i=>[`${i.name_snapshot} (${brl(i.price_cents)})`,i.quantity,brl(i.line_cents)])));
  root.append(element('p',`Subtotal: ${brl(sale.subtotal_cents)} | Desconto: ${brl(sale.discount_cents)}`));
  const total=element('div',undefined,'grand-total');total.append(element('span','Total em dinheiro'),element('strong',brl(sale.total_cents)));root.append(total);
  root.append(element('p',`Entregue: ${brl(sale.payment.tendered_cents)} | Troco: ${brl(sale.payment.change_cents)}`),element('p','Emissão fiscal não implementada. Este comprovante não substitui documento fiscal.'));
  if(!$('receipt-dialog').open)$('receipt-dialog').showModal();
}
async function run(work){try{await work();}catch(error){message(error.message);}}
// A pendência é gravada ANTES do envio e só é removida após resposta conclusiva.
async function command(path,body){
  if(state.pending)throw new Error('Recupere a operação pendente primeiro.');
  const pending={path,body,key:crypto.randomUUID()};
  try{localStorage.setItem(scope(),JSON.stringify(pending));}catch{throw new Error('Armazenamento local indisponível. Venda bloqueada para evitar perda da chave de recuperação.');}
  state.pending=pending;await submitPending();
}
async function submitPending(){
  if(!state.pending||state.busy)return;
  state.busy=true;lock();
  const pending=state.pending;
  try{
    const result=await api(pending.path,{method:'POST',body:JSON.stringify(pending.body),headers:{'Idempotency-Key':pending.key}});
    localStorage.removeItem(scope());state.pending=null;
    document.querySelectorAll('dialog[open]').forEach(d=>d.close());
    if(pending.path==='/api/sales'){state.cart=[];$('discount').value='0,00';$('discount-reason').value='';$('tendered').value='';showReceipt(result.data);}
    if(pending.path==='/api/products')$('product-form').reset();
    message(result.replayed?'Operação recuperada. Nenhum registro foi duplicado.':'Operação confirmada.');
    await refresh();
  }catch(error){
    // 4xx é recusa explícita; falhas de rede/5xx preservam a pendência para repetir a mesma chave.
    // 401/403 mantêm a pendência: recarregue, entre no mesmo usuário e recupere.
    if(error.status>=400&&error.status<500&&![401,403,408,429].includes(error.status)){
      localStorage.removeItem(scope());state.pending=null;
    }
    if(state.pending)document.querySelectorAll('dialog[open]:not(#receipt-dialog)').forEach(d=>d.close());
    message(error.message+(state.pending?' Use Recuperar operação.':''));
  }finally{state.busy=false;lock();}
}
async function boot(){
  state.me=await api('/api/me');state.csrf=state.me.csrfToken;
  $('login-panel').hidden=true;$('workspace').hidden=false;$('user-label').textContent=state.me.user.name;
  $('role-label').textContent=manager()?'GERENTE':'OPERADOR';
  $('store-select').replaceChildren();
  for(const store of state.me.stores){const option=element('option',store.name);option.value=store.id;$('store-select').append(option);}
  const raw=localStorage.getItem(scope());state.pending=raw?JSON.parse(raw):null;
  if(state.pending&&state.me.stores.some(s=>s.id===state.pending.body.storeId))$('store-select').value=state.pending.body.storeId;
  await refresh();
}
$('login-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{await api('/api/login',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});$('login-error').textContent='';event.target.password.value='';await boot();}
  catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}
});
$('logout').addEventListener('click',()=>run(async()=>{if(state.pending)throw new Error('Resolva a pendência antes de sair.');await api('/api/logout',{method:'POST',body:'{}'});location.reload();}));
$('password-open').addEventListener('click',()=>$('password-dialog').showModal());
$('password-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const data=Object.fromEntries(new FormData(event.target));
  if(data.newPassword!==data.confirmPassword)throw new Error('A confirmação da nova senha não confere.');
  await api('/api/me/password',{method:'POST',body:JSON.stringify({currentPassword:data.currentPassword,newPassword:data.newPassword})});
  event.target.reset();$('password-dialog').close();message('Senha alterada. Outras sessões deste usuário foram encerradas.');
});});
$('store-select').addEventListener('change',()=>run(async()=>{state.cart=[];await refresh();}));
$('terminal-select').addEventListener('change',()=>{state.cart=[];renderCash();renderCart();});
$('refresh').addEventListener('click',()=>run(refresh));
$('search').addEventListener('input',renderSearch);
$('search-form').addEventListener('submit',event=>{event.preventDefault();const q=$('search').value.trim().toLowerCase();const exact=state.data.products.find(p=>p.sku.toLowerCase()===q||p.barcode===q);
  const matches=state.data.products.filter(p=>p.name.toLowerCase().includes(q));if(exact)add(exact);else if(q&&matches.length===1)add(matches[0]);else message('Selecione um produto da busca ou informe um código cadastrado.');});
for(const key of ['discount','tendered'])$(key).addEventListener('input',renderTotals);
$('sale-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const cash=currentCash();if(!cash)throw new Error('Abra o caixa primeiro.');
  await command('/api/sales',{storeId:storeId(),cashSessionId:cash.id,items:state.cart.map(p=>({productId:p.id,quantity:p.units})),discountCents:cents($('discount').value||'0'),discountReason:$('discount-reason').value||null,tenderedCents:cents($('tendered').value)});
});});
$('open-cash').addEventListener('click',()=>{$('open-description').textContent=`${$('store-select').selectedOptions[0].textContent} · ${$('terminal-select').selectedOptions[0].textContent}`;$('open-dialog').showModal();});
$('open-form').addEventListener('submit',event=>{event.preventDefault();run(()=>command('/api/cash/open',{storeId:storeId(),terminalId:terminalId(),openingCents:cents(event.target.opening.value)}));});
$('close-cash').addEventListener('click',()=>{$('close-description').textContent=`Dinheiro esperado: ${brl(currentCash().expected_cents)}. Informe a contagem física.`;$('close-dialog').showModal();});
$('close-form').addEventListener('submit',event=>{event.preventDefault();run(()=>command('/api/cash/close',{storeId:storeId(),cashSessionId:currentCash().id,countedCents:cents(event.target.counted.value),reason:event.target.reason.value||null}));});
$('new-product').addEventListener('click',()=>$('product-dialog').showModal());
$('product-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/products',{storeId:storeId(),sku:f.sku,barcode:f.barcode||null,name:f.name,priceCents:cents(f.price),initialQuantity:Number(f.quantity)});});});
$('recover').addEventListener('click',()=>run(submitPending));
$('print').addEventListener('click',()=>window.print());
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{state.tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('selected',button===b));renderManagement();}));
document.addEventListener('keydown',event=>{
  if(!state.me)return;
  if(event.key==='F2'){event.preventDefault();$('search').focus();}
  if(event.key==='F9'&&!document.querySelector('dialog[open]')){event.preventDefault();if(!$('confirm-sale').disabled)$('sale-form').requestSubmit();}
  if(event.key==='F10'){event.preventDefault();if(state.lastReceipt){showReceipt(state.lastReceipt);window.print();}}
});
boot().catch(error=>{if(error.status!==401)$('login-error').textContent=error.message;});
