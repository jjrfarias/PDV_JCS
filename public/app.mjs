import {cents,brl} from './money.mjs';
const $=id=>document.getElementById(id);
const state={me:null,data:null,network:null,networkLoading:false,cart:[],csrf:'',pending:null,busy:false,tab:'products',view:'sale',lastReceipt:null,paymentMethod:'CASH',report:null,reportFrom:'',reportTo:'',reportSection:'resumo'};
let messageTimer=null;
function element(tag,content,className=''){const node=document.createElement(tag);if(content!==undefined)node.textContent=String(content);if(className)node.className=className;return node;}
function message(value,{sticky=false}={}){
  clearTimeout(messageTimer);messageTimer=null;
  $('message').textContent=value;$('message').hidden=!value;
  if(value&&!sticky)messageTimer=setTimeout(()=>{if($('message').textContent===value){$('message').textContent='';$('message').hidden=true;}},4000);
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
const customerLabel=customer=>[customer.name,customer.document,customer.phone].filter(Boolean).join(' · ');
function clearSaleCustomer(){
  $('sale-customer').value='';
  $('sale-customer-search').value='';
}
function selectedCustomerId(){
  const text=$('sale-customer-search').value.trim();
  if(!text){$('sale-customer').value='';return null;}
  const current=$('sale-customer').value;
  if(current&&customerLabel(state.data?.customers?.find(customer=>customer.id===current)??{})===text)return current;
  const matches=(state.data?.customers??[]).filter(customer=>customer.active===1&&customerLabel(customer)===text);
  if(matches.length===1){$('sale-customer').value=matches[0].id;return matches[0].id;}
  throw new Error('Selecione um cliente da lista ou deixe o campo vazio.');
}
function lock(){
  const locked=state.busy||Boolean(state.pending);
  document.querySelectorAll('[data-edit],[data-write]').forEach(el=>el.disabled=locked);
  $('pending-panel').hidden=!state.pending;
  $('recover').disabled=state.busy;
  $('discount').disabled=locked||!manager();$('discount-reason').disabled=locked||!manager();
  const cash=currentCash();
  $('open-cash').disabled=locked||Boolean(cash);
  $('cash-supply').disabled=locked||!cash||cash.operator_id!==state.me?.user.id;
  $('cash-withdrawal').disabled=locked||!cash||cash.operator_id!==state.me?.user.id;
  $('close-cash').disabled=locked||!cash||cash.operator_id!==state.me?.user.id;
  document.querySelectorAll('[data-cancel-sale]').forEach(el=>{el.disabled=locked;});
  document.querySelectorAll('[data-return-sale]').forEach(el=>{el.disabled=locked;});
  document.querySelectorAll('[data-product-action]').forEach(el=>{el.disabled=locked;});
  document.querySelectorAll('[data-user-action]').forEach(el=>{el.disabled=locked;});
  document.querySelectorAll('[data-customer-action]').forEach(el=>{el.disabled=locked;});
  $('confirm-sale').disabled=locked||!cash||cash.operator_id!==state.me?.user.id||state.cart.length===0;
  $('cancel-sale').disabled=locked||state.cart.length===0;
  document.querySelectorAll('[data-tendered]').forEach(el=>{el.disabled=locked||state.cart.length===0;});
  document.querySelectorAll('[data-payment-method]').forEach(el=>{el.disabled=locked;});
  $('new-product').hidden=!manager();
  $('new-user').hidden=!manager();
  $('adjust-stock').hidden=!manager();
  $('password-open').disabled=locked;
  $('logout').disabled=locked;
}
async function refresh(){
  if(!state.me)return;
  state.data=await api(`/api/stores/${storeId()}/state`);
  const prior=terminalId();$('terminal-select').replaceChildren();
  for(const terminal of state.data.terminals){const option=element('option',terminal.name);option.value=terminal.id;$('terminal-select').append(option);}
  if(state.data.terminals.some(t=>t.id===prior))$('terminal-select').value=prior;
  const customer=$('sale-customer').value;$('sale-customer-options').replaceChildren();
  for(const entry of (state.data.customers??[]).filter(c=>c.active===1)){const option=element('option');option.value=customerLabel(entry);$('sale-customer-options').append(option);}
  const selected=(state.data.customers??[]).find(c=>c.id===customer&&c.active===1);
  if(selected){$('sale-customer').value=selected.id;$('sale-customer-search').value=customerLabel(selected);}else if(customer)clearSaleCustomer();
  if(state.tab==='reports')await loadReport();
  if(state.view==='network'&&manager())await loadNetwork();
  renderCash();renderSearch();renderManagement();renderCart();
}
function renderCash(){
  const cash=currentCash();
  $('cash-label').textContent=cash?(cash.operator_id===state.me.user.id?'Caixa aberto':'Aberto por outro operador'):'Caixa fechado';
  $('cash-label').classList.toggle('closed',!cash||cash.operator_id!==state.me.user.id);
  $('cash-gate').hidden=Boolean(cash&&cash.operator_id===state.me.user.id);
  if(!cash){$('cash-gate-title').textContent='Caixa fechado';$('cash-gate-text').textContent='Abra o caixa antes de registrar vendas neste terminal.';}
  else if(cash.operator_id!==state.me.user.id){$('cash-gate-title').textContent='Terminal em uso';$('cash-gate-text').textContent='Este caixa foi aberto por outro operador. Selecione outro terminal ou peça o fechamento.';}
  $('opening-value').textContent=brl(cash?.opening_cents??0);
  $('expected-value').textContent=brl(cash?.expected_cents??0);
  $('payment-total-value').textContent=brl(cash?.total_sales_cents??0);
  $('payment-cash-value').textContent=brl(cash?.cash_sales_cents??0);
  $('payment-pix-value').textContent=brl(cash?.pix_sales_cents??0);
  $('payment-card-value').textContent=brl(cash?.card_sales_cents??0);
  renderCashMovements();
  lock();
}
function setView(view){
  if(view==='network'&&!manager())return;
  state.view=view;
  document.querySelectorAll('[data-panel]').forEach(panel=>{panel.hidden=panel.dataset.panel!==view;});
  document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('selected',button.dataset.view===view));
  const headings={network:['REDE DE LOJAS','Acompanhamento em tempo real'],sale:['FRENTE DE CAIXA','Nova venda'],cash:['CAIXA','Operação do caixa'],management:['GESTÃO','Produtos, equipe e movimentações']};
  $('page-eyebrow').textContent=headings[view][0];$('page-title').textContent=headings[view][1];
  $('workspace').classList.toggle('network-context',view==='network');
  if(view==='sale')setTimeout(()=>$('search').focus(),0);
  if(view==='network')run(loadNetwork);
}
const BUSINESS_TIME_ZONE='America/Sao_Paulo';
const localDay=(value=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:BUSINESS_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
const dayOffset=days=>{const [year,month,day]=localDay().split('-').map(Number);return localDay(new Date(Date.UTC(year,month-1,day+days,15)));};
const businessHour=value=>Number(new Intl.DateTimeFormat('en-US',{timeZone:BUSINESS_TIME_ZONE,hour:'2-digit',hourCycle:'h23'}).format(new Date(value)));
async function loadNetwork(){
  if(!manager()||state.networkLoading)return;
  state.networkLoading=true;$('network-status').textContent='Atualizando';$('network-status').classList.add('loading');
  try{const today=localDay(),reference=dayOffset(-7);const [current,previous]=await Promise.all([api(`/api/network/overview?from=${today}&to=${today}`),api(`/api/network/overview?from=${reference}&to=${reference}`)]);state.network={current,previous};renderNetwork();}
  finally{state.networkLoading=false;$('network-status').textContent='Ao vivo';$('network-status').classList.remove('loading');}
}
// Caixa aberto sem venda por mais tempo que isto vira alerta: risco de caixa esquecido aberto.
const IDLE_ALERT_MS=2*60*60_000;
const plural=(count,one,many)=>`${count} ${count===1?one:many}`;
const elapsed=ms=>{const minutes=Math.floor(ms/60_000);if(minutes<60)return `${minutes} min`;const hours=Math.floor(minutes/60),rest=minutes%60;return rest?`${hours} h ${rest} min`:`${hours} h`;};
function storeAttention(store,now){
  if(!store.open_cash_count)return null;
  const last=store.last_sale_at?new Date(store.last_sale_at).getTime():null;
  const idle=last===null?Infinity:now-last;
  return idle>=IDLE_ALERT_MS?{idle,text:last===null?`${store.name}: caixa aberto e nenhuma venda registrada`:`${store.name}: caixa aberto sem venda há ${elapsed(idle)}`}:null;
}
function renderNetwork(){
  const overview=state.network?.current,previous=state.network?.previous;if(!overview)return;
  const totals=overview.totals,now=new Date(overview.generated_at).getTime(),currentHour=businessHour(overview.generated_at);
  const hasHistory=previous.totals.gross_cents>0;
  const variation=(value,reference)=>reference?`${value>=reference?'▲':'▼'} ${Math.abs((value-reference)/reference*100).toLocaleString('pt-BR',{maximumFractionDigits:1})}% vs. semana passada`:'';
  const throughHour=(items,hour)=>items.filter(item=>businessHour(item.hour)<=hour).reduce((sum,item)=>sum+item.gross_cents,0);
  const comparablePrevious=throughHour(previous.hourly??[],currentHour);
  const openStores=overview.stores.filter(store=>store.open_cash_count).length;
  const summary=[['Vendas líquidas',brl(totals.gross_cents),variation(totals.gross_cents,comparablePrevious),'primary'],['Vendas confirmadas',totals.active_sale_count,''],['Ticket médio',brl(totals.ticket_average_cents),''],['Caixas abertos',totals.open_cash_count,`em ${plural(openStores,'loja','lojas')} de ${overview.stores.length}`]];
  $('network-summary').replaceChildren(...summary.map(([label,value,note,kind])=>{const card=element('div',undefined,kind==='primary'?'primary-metric':'');card.append(element('span',label),element('strong',value));if(note)card.append(element('small',note,note.startsWith('▲')?'positive':note.startsWith('▼')?'negative':''));return card;}));
  $('network-history-note').textContent=hasHistory?'':'A comparação com a semana passada aparece quando houver vendas no mesmo dia da semana anterior.';
  // Alertas: só exceções que pedem ação. Caixa fechado à noite é normal e não entra aqui.
  const attention=new Map(overview.stores.map(store=>[store.id,storeAttention(store,now)]));
  const idleAlerts=[...attention.values()].filter(Boolean).sort((a,b)=>b.idle-a.idle);
  const alerts=[...(idleAlerts.length?[{text:`${plural(idleAlerts.length,'loja com caixa aberto','lojas com caixa aberto')} sem venda há mais de 2 horas`,level:'critical'}]:[]),
    ...(totals.canceled_sale_count?[{text:plural(totals.canceled_sale_count,'venda cancelada','vendas canceladas'),level:'warning'}]:[]),
    ...(totals.returned_cents?[{text:`${brl(totals.returned_cents)} em devoluções`,level:'warning'}]:[])];
  $('network-alerts').classList.toggle('has-alerts',alerts.length>0);
  $('network-alerts').replaceChildren(element('strong',alerts.length?'Atenção agora':'Operação sem exceções'),...(alerts.length?alerts.map(alert=>element('span',alert.text,`alert-${alert.level}`)):[element('span','Nenhum caixa parado, cancelamento ou devolução no período.')]));
  const methods=['CASH','PIX','CARD'];
  const paymentData=methods.map(method=>{const payment=overview.payments.find(item=>item.method===method);return {method,amount:payment?.amount_cents??0,count:payment?.sale_count??0};});
  const paymentTotal=paymentData.reduce((sum,item)=>sum+item.amount,0);
  const share=item=>`${paymentTotal?Math.round(item.amount/paymentTotal*100):0}%`;
  $('network-payment-bar').replaceChildren(...paymentData.map(item=>{const part=element('span',undefined,`payment-${item.method.toLowerCase()}`);part.style.width=`${paymentTotal?item.amount/paymentTotal*100:0}%`;part.title=`${paymentName(item.method)}: ${brl(item.amount)}`;return part;}));
  $('network-payment-legend').replaceChildren(...paymentData.map(item=>{const row=element('div');const value=element('strong',brl(item.amount));value.append(element('small',share(item)));row.append(element('i',undefined,`payment-${item.method.toLowerCase()}`),element('span',paymentName(item.method)),value);return row;}));
  const previousStores=new Map(previous.stores.map(store=>[store.id,{...store,gross_cents:throughHour(store.hourly??[],currentHour)}]));
  // Ordem: lojas com alerta primeiro (mais tempo parado no topo), depois por faturamento.
  const stores=[...overview.stores].sort((a,b)=>(attention.get(b.id)?.idle??-1)-(attention.get(a.id)?.idle??-1)||b.gross_cents-a.gross_cents);
  const openStore=store=>run(async()=>{$('store-select').value=store.id;state.cart=[];await refresh();setView('management');});
  const cashLabel=store=>store.open_cash_count?plural(store.open_cash_count,'aberto','abertos'):'Fechados';
  document.querySelectorAll('.compare-col').forEach(cell=>{cell.hidden=!hasHistory;});
  const maxStoreGross=Math.max(...stores.map(store=>store.gross_cents),1);
  $('network-store-rows').replaceChildren(...stores.map(store=>{const reference=previousStores.get(store.id),ticket=store.active_sale_count?Math.round(store.gross_cents/store.active_sale_count):0,tr=element('tr');tr.tabIndex=0;if(attention.get(store.id))tr.className='needs-attention';
    const compare=element('td',variation(store.gross_cents,reference?.gross_cents??0)||'—',`compare-col ${reference?.gross_cents?(store.gross_cents>=reference.gross_cents?'positive':'negative'):'muted-cell'}`);compare.hidden=!hasHistory;
    const sales=element('td',undefined,'number sales-cell'),salesBar=element('span',undefined,'sales-bar'),salesValue=element('strong',brl(store.gross_cents));salesBar.style.width=`${store.gross_cents/maxStoreGross*100}%`;sales.append(salesBar,salesValue);
    const cash=element('td',undefined,attention.get(store.id)?'alert-cell':store.open_cash_count?'positive':'muted-cell');cash.append(element('span',cashLabel(store)));if(attention.get(store.id))cash.append(element('small',attention.get(store.id).text.replace(`${store.name}: caixa aberto `,'')));
    tr.append(element('td',store.name),sales,compare,element('td',store.active_sale_count,'number'),element('td',brl(ticket),'number'),cash,element('td',store.last_sale_at?date(store.last_sale_at):'Sem venda'),element('td','Abrir','row-link'));
    tr.addEventListener('click',()=>openStore(store));tr.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openStore(store);}});return tr;}));
  $('network-store-cards').replaceChildren(...stores.map(store=>{const card=element('button',undefined,`network-store-card${attention.get(store.id)?' needs-attention':''}`);card.type='button';const reference=previousStores.get(store.id),ticket=store.active_sale_count?Math.round(store.gross_cents/store.active_sale_count):0,note=variation(store.gross_cents,reference?.gross_cents??0);card.append(element('strong',store.name),element('b',brl(store.gross_cents)));if(note)card.append(element('span',note,store.gross_cents>=reference.gross_cents?'positive':'negative'));card.append(element('small',`${plural(store.active_sale_count,'venda','vendas')} · ticket ${brl(ticket)} · ${store.open_cash_count?plural(store.open_cash_count,'caixa aberto','caixas abertos'):'caixas fechados'}`));card.addEventListener('click',()=>openStore(store));return card;}));
  renderCumulative(overview.hourly??[],hasHistory?previous.hourly??[]:[],overview.generated_at);
  $('network-period').textContent=`Hoje, ${new Date(`${localDay()}T12:00:00`).toLocaleDateString('pt-BR')}`;
  $('network-updated').textContent=`Atualizado às ${new Date(overview.generated_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;
}
// Curva acumulada no fuso da operação. A referência é comparada somente até a mesma hora.
function renderCumulative(today,reference,generatedAt){
  const byHour=list=>{const map=new Map();for(const item of list){const hour=businessHour(item.hour);map.set(hour,(map.get(hour)??0)+item.gross_cents);}return map;};
  const current=byHour(today),past=byHour(reference),currentHour=businessHour(generatedAt),first=7,last=23;
  const chart=$('network-hourly');
  if(!today.length&&!reference.length){chart.replaceChildren(element('p','Nenhuma venda registrada hoje.','muted-cell'));$('network-hourly-note').textContent='Vendas líquidas acumuladas';return;}
  const cumulative=(map,limit=last)=>{let total=0;const result=[];for(let hour=first;hour<=last;hour++){total+=map.get(hour)??0;if(hour<=limit)result.push({hour,total});}return result;};
  const todayPoints=cumulative(current,Math.min(currentHour,last)),pastPoints=reference.length?cumulative(past):[],max=Math.max(...todayPoints.map(item=>item.total),...pastPoints.map(item=>item.total),1);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 320 150');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label','Vendas acumuladas de hoje e do mesmo dia da semana passada');
  const node=(name,attributes={})=>{const value=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,item] of Object.entries(attributes))value.setAttribute(key,item);return value;};
  const x=hour=>12+(hour-first)/(last-first)*296,y=value=>128-value/max*105;
  for(const fraction of [0,.5,1]){svg.append(node('line',{x1:12,y1:y(max*fraction),x2:308,y2:y(max*fraction),class:'chart-grid'}));}
  const line=(items,className)=>{if(!items.length)return;const points=items.map(item=>`${x(item.hour)},${y(item.total)}`).join(' ');svg.append(node('polyline',{points,class:className}));};
  line(pastPoints,'cumulative-reference');line(todayPoints,'cumulative-today');
  for(const hour of [7,11,15,19,23]){const label=node('text',{x:x(hour),y:146,class:'chart-label','text-anchor':'middle'});label.textContent=`${String(hour).padStart(2,'0')}h`;svg.append(label);}
  chart.replaceChildren(svg);
  const currentTotal=todayPoints.at(-1)?.total??0,referenceNow=pastPoints.find(item=>item.hour===Math.min(currentHour,last))?.total??0,difference=currentTotal-referenceNow;
  $('network-hourly-note').textContent=reference.length?`${difference>=0?'À frente':'Atrás'} em ${brl(Math.abs(difference))} neste horário.`:'Referência disponível após o primeiro ciclo semanal.';
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
    const quantity=element('td',undefined,'quantity-cell'),input=element('input');input.type='number';input.min='1';input.max='10000';input.step='1';input.value=p.units;input.dataset.edit='';input.setAttribute('aria-label',`Quantidade de ${p.name}`);
    input.addEventListener('change',()=>{const n=Number(input.value);if(!Number.isInteger(n)||n<1||n>10000){input.value=p.units;message('Quantidade inválida.');return;}p.units=n;renderCart();});quantity.append(input);
    const action=element('td',undefined,'action-cell'),remove=element('button','Remover');remove.type='button';remove.dataset.write='';remove.addEventListener('click',()=>{state.cart=state.cart.filter(i=>i.id!==p.id);renderCart();});action.append(remove);
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
  $('change').textContent=brl(state.paymentMethod==='CASH'?Math.max(0,tendered-total):0);
  $('cash-payment-fields').hidden=state.paymentMethod!=='CASH';
  $('electronic-payment-note').hidden=state.paymentMethod==='CASH';
  const names={CASH:'dinheiro',PIX:'PIX',CARD:'cartao'};
  $('confirm-sale').textContent=`Confirmar venda em ${names[state.paymentMethod]}`;
  document.querySelectorAll('[data-payment-method]').forEach(button=>button.classList.toggle('selected',button.dataset.paymentMethod===state.paymentMethod));
  updateMoneyPreviews();
}
function updateMoneyPreviews(){
  document.querySelectorAll('.money-input').forEach(input=>{
    const preview=input.parentElement.querySelector('.money-preview');
    if(!preview)return;
    try{preview.textContent=brl(cents(input.value||'0'));preview.classList.remove('invalid');}
    catch{preview.textContent='Valor inválido';preview.classList.add('invalid');}
  });
}
const codeValue=(data,names)=>names.map(name=>data[name]).find(value=>value!==undefined&&value!==null&&String(value).trim()!=='');
function parseKeyValues(text){
  const data={};
  text.split(/[\r\n;|]+/).forEach(part=>{
    const match=part.match(/^\s*([^:=]+)\s*[:=]\s*(.+?)\s*$/);
    if(match)data[match[1].trim().toLowerCase()]=match[2].trim();
  });
  return data;
}
function parseProductScan(raw){
  const text=String(raw??'').trim();
  if(!text)return {};
  let data={};
  try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==='object')data=Object.fromEntries(Object.entries(parsed).map(([k,v])=>[k.toLowerCase(),v]));}catch{}
  if(!Object.keys(data).length){
    try{const url=new URL(text);data=Object.fromEntries([...url.searchParams.entries()].map(([k,v])=>[k.toLowerCase(),v]));}catch{}
  }
  if(!Object.keys(data).length)data=parseKeyValues(text);
  const gtin=text.match(/\(01\)\s*(\d{14})/)?.[1]??text.match(/^01(\d{14})/)?.[1];
  const digits=text.replace(/\D/g,'');
  const barcode=String(codeValue(data,['barcode','codigo_barras','codigo de barras','ean','gtin','code','codigo','código'])??gtin??(/^\d{8,14}$/.test(digits)?digits:'')).trim();
  return {
    barcode,
    sku:String(codeValue(data,['sku','codigo_interno','codigo interno','referencia','referência'])??'').trim(),
    name:String(codeValue(data,['name','nome','description','descricao','descrição','produto'])??'').trim(),
    price:String(codeValue(data,['price','preco','preço','valor','pricecents','price_cents'])??'').trim()
  };
}
function applyProductScan(form){
  const parsed=parseProductScan(form.scan.value);
  if(!parsed.barcode&&!parsed.sku&&!parsed.name&&!parsed.price)return;
  if(parsed.barcode&&!form.barcode.value)form.barcode.value=parsed.barcode;
  if((parsed.sku||parsed.barcode)&&!form.sku.value)form.sku.value=(parsed.sku||parsed.barcode).slice(0,40);
  if(parsed.name&&!form.name.value)form.name.value=parsed.name.slice(0,120);
  if(parsed.price&&!form.price.value)form.price.value=parsed.price;
  updateMoneyPreviews();
  if(!form.name.value)form.name.focus();else if(!form.price.value)form.price.focus();else form.quantity.focus();
}
function currentTotalCents(){
  const subtotal=state.cart.reduce((sum,p)=>sum+p.units*p.price_cents,0);
  let discount=0;try{discount=cents($('discount').value||'0');}catch{}
  return Math.max(0,subtotal-discount);
}
function fillTendered(mode){
  const total=currentTotalCents();
  if(total<=0)return;
  if(mode==='exact')$('tendered').value=String(total);
  else if(mode==='round')$('tendered').value=String(Math.ceil(total/1000)*1000);
  else $('tendered').value=String(total+Number(mode));
  renderTotals();$('tendered').focus();
}
function clearSale(){
  if(!state.cart.length)return;
  if(!confirm('Cancelar a venda atual e limpar todos os itens?'))return;
  state.cart=[];$('discount').value='0';$('discount-reason').value='';$('tendered').value='';clearSaleCustomer();
  renderSearch();renderCart();updateMoneyPreviews();message('Venda cancelada.');$('search').focus();
}
function table(headers,rows){
  const t=element('table'),thead=element('thead'),head=element('tr');headers.forEach(h=>head.append(element('th',h)));thead.append(head);t.append(thead);
  const body=element('tbody');
  for(const row of rows){const tr=element('tr');for(const value of row){const td=element('td');if(value instanceof Node)td.append(value);else td.textContent=String(value);tr.append(td);}body.append(tr);}
  if(!rows.length){const tr=element('tr'),td=element('td','Nenhum registro nesta loja.');td.colSpan=headers.length;tr.append(td);body.append(tr);}t.append(body);return t;
}
const date=value=>{
  return new Intl.DateTimeFormat('pt-BR',{timeZone:BUSINESS_TIME_ZONE,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value)).replace(',','');
};
const dateOnly=value=>{
  const [y,m,d]=String(value??'').slice(0,10).split('-');
  return y&&m&&d?`${d}/${m}/${y}`:'';
};
const isoFromDateOnly=value=>{
  const text=String(value??'').trim();
  const br=text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(br)return `${br[3]}-${br[2]}-${br[1]}`;
  if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;
  throw new Error('Informe a data no formato dd/mm/aaaa.');
};
const includes=(values,query)=>!query||values.some(value=>String(value??'').toLowerCase().includes(query));
const customerName=id=>id?state.data?.customers?.find(customer=>customer.id===id)?.name??'Cliente vinculado':'';
const moneyValue=value=>Number(value??0);
const cashMovementName=kind=>({OPENING:'Fundo inicial',SALE:'Venda em dinheiro',SUPPLY:'Suprimento',WITHDRAWAL:'Sangria'}[kind]??kind);
const paymentName=method=>({CASH:'Dinheiro',PIX:'PIX',CARD:'Cartão'}[method]??method);
function renderCashMovements(){
  if(!$('cash-movement-table')||!state.data)return;
  const current=currentCash();
  const rows=current?(state.data.cashMovements??[]).filter(m=>m.cash_session_id===current.id):[];
  $('cash-movement-count').textContent=`${rows.length} registros`;
  $('cash-movement-table').replaceChildren(table(['Data','Tipo','Valor','Operador','Motivo'],rows.map(m=>[
    date(m.created_at),cashMovementName(m.kind),brl(m.amount_cents),m.actor_name,m.reason
  ])));
}
function renderSummary(cards){
  $('management-summary').replaceChildren(...cards.map(([label,value])=>{
    const card=element('div');card.append(element('span',label),element('strong',value));return card;
  }));
}
const isoDate=value=>{
  const d=value?new Date(value):new Date();
  return d.toISOString().slice(0,10);
};
function ensureReportPeriod(){
  const today=isoDate();
  if(!state.reportFrom)state.reportFrom=today;
  if(!state.reportTo)state.reportTo=today;
}
async function loadReport(){
  ensureReportPeriod();
  state.report=await api(`/api/stores/${storeId()}/report?from=${encodeURIComponent(state.reportFrom)}&to=${encodeURIComponent(state.reportTo)}`);
}
function reportControls(){
  ensureReportPeriod();
  const wrap=element('div',undefined,'report-controls');
  const bindDateInput=(input,field)=>{input.type='text';input.inputMode='numeric';input.placeholder='dd/mm/aaaa';input.value=dateOnly(state[field]);input.addEventListener('change',()=>{state[field]=isoFromDateOnly(input.value);input.value=dateOnly(state[field]);});};
  const fromLabel=element('label','De');const from=element('input');bindDateInput(from,'reportFrom');
  const toLabel=element('label','Até');const to=element('input');bindDateInput(to,'reportTo');
  const typeLabel=element('label','Relatório');const type=element('select');[
    ['resumo','Resumo'],['pagamentos','Pagamentos'],['produtos','Produtos vendidos'],['operadores','Operadores'],['vendas','Vendas'],['fechamentos','Fechamentos']
  ].forEach(([value,label])=>{const option=element('option',label);option.value=value;type.append(option);});
  type.value=state.reportSection;type.addEventListener('change',()=>{state.reportSection=type.value;renderManagement();});
  const readDates=()=>{state.reportFrom=isoFromDateOnly(from.value);state.reportTo=isoFromDateOnly(to.value);from.value=dateOnly(state.reportFrom);to.value=dateOnly(state.reportTo);};
  const apply=element('button','Atualizar');apply.type='button';apply.addEventListener('click',()=>run(async()=>{readDates();await loadReport();renderManagement();}));
  const exportButton=element('button','Exportar Excel');exportButton.type='button';exportButton.addEventListener('click',()=>run(async()=>{readDates();location.href=`/api/stores/${storeId()}/report.csv?from=${encodeURIComponent(state.reportFrom)}&to=${encodeURIComponent(state.reportTo)}&section=${encodeURIComponent(state.reportSection)}`;}));
  fromLabel.append(from);toLabel.append(to);typeLabel.append(type);wrap.append(fromLabel,toLabel,typeLabel,apply,exportButton);return wrap;
}
function renderManagement(){
  const d=state.data,query=$('management-search').value.trim().toLowerCase();let content;
  if(state.tab==='products'){const rows=d.products.filter(p=>includes([p.sku,p.name,p.barcode,brl(p.price_cents),p.quantity],query));renderSummary([['Produtos',rows.length],['Estoque total',rows.reduce((n,p)=>n+p.quantity,0)],['Valor em estoque',brl(rows.reduce((n,p)=>n+p.quantity*p.price_cents,0))]]);content=table(['Código','Produto','Código de barras','Preço','Estoque','Ações'],rows.map(p=>{
    const actions=element('div',undefined,'row-actions');
    if(manager()){const edit=element('button','Editar');edit.type='button';edit.dataset.productAction='edit';edit.addEventListener('click',()=>openProductEdit(p));actions.append(edit);
      const deactivate=element('button','Inativar');deactivate.type='button';deactivate.dataset.productAction='deactivate';deactivate.addEventListener('click',()=>deactivateProduct(p));actions.append(deactivate);}
    return [p.sku,p.name,p.barcode??'—',brl(p.price_cents),p.quantity,actions];
  }));}
  if(state.tab==='users'){const rows=(d.users??[]).filter(u=>includes([u.name,u.email,u.role,u.role==='MANAGER'?'Gerente':'Operador',u.active===1?'Ativo':'Inativo'],query));renderSummary([['Usuários',rows.length],['Ativos',rows.filter(u=>u.active===1).length],['Gerentes',rows.filter(u=>u.role==='MANAGER').length]]);content=table(['Nome','E-mail','Perfil','Status','Ações'],rows.map(u=>{
    const actions=element('div',undefined,'row-actions');
    if(manager()){const edit=element('button','Editar');edit.type='button';edit.dataset.userAction='edit';edit.addEventListener('click',()=>openUserEdit(u));actions.append(edit);}
    return [u.name,u.email,u.role==='MANAGER'?'Gerente':'Operador',u.active===1?'Ativo':'Inativo',actions];
  }));}
  if(state.tab==='customers'){const rows=(d.customers??[]).filter(c=>includes([c.name,c.document,c.phone,c.email,c.note,c.active===1?'Ativo':'Inativo'],query));renderSummary([['Clientes',rows.length],['Ativos',rows.filter(c=>c.active===1).length],['Com documento',rows.filter(c=>c.document).length]]);content=table(['Nome','Documento','Telefone','E-mail','Status','Ações'],rows.map(c=>{
    const actions=element('div',undefined,'row-actions'),edit=element('button','Editar');edit.type='button';edit.dataset.customerAction='edit';edit.addEventListener('click',()=>openCustomerEdit(c));actions.append(edit);
    return [c.name,c.document??'—',c.phone??'—',c.email??'—',c.active===1?'Ativo':'Inativo',actions];
  }));}
  if(state.tab==='history'){const rows=d.sales.filter(s=>includes([date(s.created_at),s.id,s.operator_name,s.terminal_name,customerName(s.customer_id),brl(s.discount_cents),brl(s.total_cents),s.canceled_at?'Cancelada':'Confirmada',s.cancel_reason],query));const active=rows.filter(s=>!s.canceled_at);renderSummary([['Vendas',rows.length],['Total líquido',brl(active.reduce((n,s)=>n+moneyValue(s.total_cents)-moneyValue(s.returned_cents),0))],['Devolvido',brl(active.reduce((n,s)=>n+moneyValue(s.returned_cents),0))],['Canceladas',rows.filter(s=>s.canceled_at).length]]);content=table(['Data','Venda','Cliente','Operador','Terminal','Status','Devolvido','Total','Ações'],rows.map(s=>{
    const b=element('button','Abrir');b.type='button';b.addEventListener('click',()=>run(async()=>showReceipt(await api(`/api/sales/${s.id}`))));
    const actions=element('div',undefined,'row-actions');actions.append(b);
    if(manager()&&!s.canceled_at){
      const r=element('button','Devolver');r.type='button';r.dataset.returnSale=s.id;r.addEventListener('click',()=>run(()=>openSaleReturn(s)));actions.append(r);
      const c=element('button','Cancelar');c.type='button';c.dataset.cancelSale=s.id;c.addEventListener('click',()=>openSaleCancel(s));actions.append(c);}
    return [date(s.created_at),s.id.slice(0,8),customerName(s.customer_id)||'—',s.operator_name,s.terminal_name,s.canceled_at?'Cancelada':(moneyValue(s.returned_cents)>0?'Com devolução':'Confirmada'),brl(moneyValue(s.returned_cents)),brl(moneyValue(s.total_cents)),actions];}));}
  if(state.tab==='stock'){const movementName=m=>({SALE:'Venda',INITIAL:'Entrada inicial',ADJUSTMENT:'Ajuste'}[m.kind]??m.kind);const rows=d.stockMovements.filter(m=>includes([date(m.created_at),m.name,m.kind,movementName(m),m.quantity,m.reason],query));renderSummary([['Movimentos',rows.length],['Entradas',rows.filter(m=>m.quantity>0).reduce((n,m)=>n+m.quantity,0)],['Saídas',Math.abs(rows.filter(m=>m.quantity<0).reduce((n,m)=>n+m.quantity,0))]]);content=table(['Data','Produto','Movimento','Quantidade','Motivo'],rows.map(m=>[date(m.created_at),m.name,movementName(m),m.quantity,m.reason]));}
  if(state.tab==='closures'){const rows=d.cashHistory.filter(c=>{const terminal=d.terminals.find(t=>t.id===c.terminal_id)?.name??c.terminal_id;return includes([date(c.closed_at),terminal,brl(c.expected_cents),brl(c.counted_cents),brl(c.difference_cents)],query);});renderSummary([['Fechamentos',rows.length],['Esperado',brl(rows.reduce((n,c)=>n+moneyValue(c.expected_cents),0))],['Diferença',brl(rows.reduce((n,c)=>n+moneyValue(c.difference_cents),0))]]);content=table(['Data','Terminal','Esperado','Contado','Diferença','Ações'],rows.map(c=>{const actions=element('div',undefined,'row-actions'),open=element('button','Abrir');open.type='button';open.addEventListener('click',()=>run(()=>openCashDetail(c.id)));actions.append(open);return [date(c.closed_at),d.terminals.find(t=>t.id===c.terminal_id)?.name??c.terminal_id,brl(c.expected_cents),brl(c.counted_cents),brl(c.difference_cents),actions];}));}
  if(state.tab==='reports'){
    const report=state.report;
    if(!report){renderSummary([['Período','-'],['Total ativo','R$ 0,00'],['Vendas','0']]);content=element('div');content.append(reportControls(),element('p','Atualize o relatório para carregar os dados.'));}
    else {
      renderSummary([['Vendas ativas',report.summary.active_sale_count],['Total ativo',brl(report.summary.gross_cents)],['Canceladas',report.summary.canceled_sale_count]]);
      content=element('div',undefined,'report-block');
      content.append(reportControls());
      if(state.reportSection==='resumo')content.append(element('h2','Resumo'),table(['Indicador','Valor'],[
        ['Período',`${dateOnly(report.range.from)} a ${dateOnly(report.range.to)}`],['Vendas',report.summary.sale_count],['Vendas ativas',report.summary.active_sale_count],
        ['Canceladas',report.summary.canceled_sale_count],['Total líquido',brl(report.summary.gross_cents)],['Descontos ativos',brl(report.summary.discount_cents)],['Total devolvido',brl(report.summary.returned_cents??0)],['Total cancelado',brl(report.summary.canceled_cents)]
      ]));
      if(state.reportSection==='pagamentos')content.append(element('h2','Pagamentos'),table(['Forma','Vendas','Valor'],report.payments.filter(p=>includes([paymentName(p.method),p.method,p.sale_count,brl(p.amount_cents)],query)).map(p=>[paymentName(p.method),p.sale_count,brl(p.amount_cents)])));
      if(state.reportSection==='produtos')content.append(element('h2','Produtos vendidos'),table(['Código','Produto','Quantidade','Total'],report.products.filter(p=>includes([p.sku,p.name,p.quantity,brl(p.total_cents)],query)).map(p=>[p.sku,p.name,p.quantity,brl(p.total_cents)])));
      if(state.reportSection==='operadores')content.append(element('h2','Operadores'),table(['Operador','Vendas','Total'],report.operators.filter(o=>includes([o.operator_name,o.sale_count,brl(o.total_cents)],query)).map(o=>[o.operator_name,o.sale_count,brl(o.total_cents)])));
      if(state.reportSection==='vendas')content.append(element('h2','Vendas do período'),table(['Data','Venda','Cliente','Operador','Terminal','Forma','Status','Devolvido','Total'],report.sales.filter(s=>includes([date(s.created_at),s.id,customerName(s.customer_id),s.operator_name,s.terminal_name,paymentName(s.method),s.method,s.canceled_at?'Cancelada':'Confirmada'],query)).map(s=>[date(s.created_at),s.id.slice(0,8),customerName(s.customer_id)||'—',s.operator_name,s.terminal_name,paymentName(s.method),s.canceled_at?'Cancelada':(s.returned_cents?'Com devolução':'Confirmada'),brl(s.returned_cents??0),brl(s.total_cents)])));
      if(state.reportSection==='fechamentos')content.append(element('h2','Fechamentos'),table(['Data','Terminal','Esperado','Contado','Diferença'],report.cashClosures.filter(c=>includes([date(c.closed_at),c.terminal_name,brl(c.expected_cents),brl(c.counted_cents),brl(c.difference_cents)],query)).map(c=>[date(c.closed_at),c.terminal_name,brl(c.expected_cents),brl(c.counted_cents),brl(c.difference_cents)])));
    }
  }
  $('management-content').replaceChildren(content);
}
function showReceipt(sale){
  state.lastReceipt=sale;const root=$('receipt');root.replaceChildren();
  root.append(element('h2','JCS · COMPROVANTE DE TESTE'),element('div','TESTE — SEM VALOR FISCAL','receipt-warning'));
  root.append(element('p',`${sale.store_name} | ${sale.operator_name}`),element('p',`Venda ${sale.id}\n${date(sale.created_at)}`));
  if(sale.customer_id)root.append(element('p',`Cliente: ${customerName(sale.customer_id)}`));
  root.append(table(['Produto','Qtd.','Total'],sale.items.map(i=>[`${i.name_snapshot} (${brl(i.price_cents)})`,i.quantity,brl(i.line_cents)])));
  root.append(element('p',`Subtotal: ${brl(sale.subtotal_cents)} | Desconto: ${brl(sale.discount_cents)}`));
  const total=element('div',undefined,'grand-total');total.append(element('span','Total da venda'),element('strong',brl(sale.total_cents)));root.append(total);
  const method=paymentName(sale.payment.method);
  const paymentText=sale.payment.method==='CASH'?`Pagamento: ${method} | Entregue: ${brl(sale.payment.tendered_cents)} | Troco: ${brl(sale.payment.change_cents)}`:`Pagamento: ${method} confirmado manualmente`;
  if(sale.cancellation)root.append(element('p',`Venda cancelada em ${date(sale.cancellation.created_at)} por ${sale.cancellation.actor_name}. Motivo: ${sale.cancellation.reason}`,'receipt-warning'));
  if((sale.returns??[]).length){
    root.append(element('p',`Devoluções: ${brl(sale.returns.reduce((n,r)=>n+r.total_cents,0))}`,'receipt-warning'));
    root.append(table(['Produto','Qtd.','Valor'],(sale.return_items??[]).map(i=>[i.name_snapshot,i.quantity,brl(i.amount_cents)])));
  }
  root.append(element('p',paymentText),element('p','Emissao fiscal nao implementada. Este comprovante nao substitui documento fiscal.'));
  if(!$('receipt-dialog').open)$('receipt-dialog').showModal();
}
async function openCashDetail(cashId){
  const detail=await api(`/api/cash/${cashId}`),root=$('cash-detail');
  const cash=detail.cash;
  const difference=moneyValue(cash.difference_cents);
  root.replaceChildren();
  const title=element('div',undefined,'cash-detail-title');
  title.append(element('div',undefined),element('span',difference===0?'Sem diferença':'Com diferença',difference===0?'badge':'badge closed'));
  title.firstChild.append(element('h2',`Conferência do ${cash.terminal_name}`),element('p',`${cash.operator_name} · ${date(cash.opened_at)} até ${date(cash.closed_at)}`));
  root.append(title);
  const cards=element('div',undefined,'cash-detail-cards');
  [['Esperado',brl(cash.expected_cents)],['Contado',brl(cash.counted_cents)],['Diferença',brl(cash.difference_cents)],['Total vendido',brl(cash.total_sales_cents)]].forEach(([label,value])=>{
    const card=element('div');card.append(element('span',label),element('strong',value));cards.append(card);
  });
  root.append(cards);
  const payments=element('div',undefined,'cash-detail-payments');
  [['Dinheiro',cash.cash_sales_cents],['PIX',cash.pix_sales_cents],['Cartão',cash.card_sales_cents],['Fundo inicial',cash.opening_cents]].forEach(([label,value])=>{
    const item=element('div');item.append(element('span',label),element('strong',brl(value)));payments.append(item);
  });
  root.append(payments);
  if(cash.close_reason)root.append(element('p',`Motivo informado: ${cash.close_reason}`,'cash-detail-note'));
  const movements=element('section',undefined,'cash-detail-section');
  movements.append(element('h3','Movimentos de dinheiro'),table(['Data','Tipo','Valor','Motivo'],detail.movements.map(m=>[date(m.created_at),cashMovementName(m.kind),brl(m.amount_cents),m.reason||'—'])));
  root.append(movements);
  const sales=element('section',undefined,'cash-detail-section');
  sales.append(element('h3','Vendas do caixa'),table(['Data','Venda','Forma','Status','Devolvido','Total'],detail.sales.map(s=>[
    date(s.created_at),s.id.slice(0,8),paymentName(s.method),s.canceled_at?'Cancelada':(s.returned_cents?'Com devolução':'Confirmada'),brl(s.returned_cents??0),brl(s.total_cents)
  ])));
  root.append(sales);
  $('cash-detail-dialog').showModal();
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
    if(pending.path==='/api/sales'){state.cart=[];$('discount').value='0';$('discount-reason').value='';$('tendered').value='';clearSaleCustomer();showReceipt(result.data);}
    if(pending.path==='/api/products')$('product-form').reset();
    if(pending.path==='/api/products/update')$('product-edit-form').reset();
    if(pending.path==='/api/stock/adjust')$('stock-form').reset();
    if(pending.path==='/api/sales/cancel')$('sale-cancel-form').reset();
    if(pending.path==='/api/sales/return')$('sale-return-form').reset();
    if(pending.path==='/api/users')$('user-form').reset();
    if(pending.path==='/api/users/update')$('user-edit-form').reset();
    if(pending.path==='/api/customers')$('customer-form').reset();
    if(pending.path==='/api/customers/update')$('customer-edit-form').reset();
    updateMoneyPreviews();
    message(result.replayed?'Operação recuperada. Nenhum registro foi duplicado.':'Operação confirmada.');
    await refresh();
  }catch(error){
    // 4xx é recusa explícita; falhas de rede/5xx preservam a pendência para repetir a mesma chave.
    // 401/403 mantêm a pendência: recarregue, entre no mesmo usuário e recupere.
    if(error.status>=400&&error.status<500&&![401,403,408,429].includes(error.status)){
      localStorage.removeItem(scope());state.pending=null;
    }
    if(state.pending)document.querySelectorAll('dialog[open]:not(#receipt-dialog)').forEach(d=>d.close());
    message(error.message+(state.pending?' Use Recuperar operação.':''),{sticky:Boolean(state.pending)});
  }finally{state.busy=false;lock();}
}
async function boot(){
  state.me=await api('/api/me');state.csrf=state.me.csrfToken;
  $('login-panel').hidden=true;$('workspace').hidden=false;$('user-label').textContent=state.me.user.name;
  $('role-label').textContent=manager()?'GERENTE':'OPERADOR';
  $('network-nav').hidden=!manager();
  $('store-select').replaceChildren();
  for(const store of state.me.stores){const option=element('option',store.name);option.value=store.id;$('store-select').append(option);}
  const raw=localStorage.getItem(scope());state.pending=raw?JSON.parse(raw):null;
  if(state.pending&&state.me.stores.some(s=>s.id===state.pending.body.storeId))$('store-select').value=state.pending.body.storeId;
  await refresh();
  if(manager())setView('network');
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
$('sale-customer-search').addEventListener('input',()=>{
  const text=$('sale-customer-search').value.trim();
  const match=(state.data?.customers??[]).find(customer=>customer.active===1&&customerLabel(customer)===text);
  $('sale-customer').value=match?.id??'';
});
$('search-form').addEventListener('submit',event=>{event.preventDefault();const q=$('search').value.trim().toLowerCase();const exact=state.data.products.find(p=>p.sku.toLowerCase()===q||p.barcode===q);
  const matches=state.data.products.filter(p=>p.name.toLowerCase().includes(q));if(exact)add(exact);else if(q&&matches.length===1)add(matches[0]);else message('Selecione um produto da busca ou informe um código cadastrado.');});
document.querySelectorAll('.money-input').forEach(input=>input.addEventListener('input',()=>{updateMoneyPreviews();if(input.id==='discount'||input.id==='tendered')renderTotals();}));
$('sale-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const cash=currentCash();if(!cash)throw new Error('Abra o caixa primeiro.');
  await command('/api/sales',{storeId:storeId(),cashSessionId:cash.id,items:state.cart.map(p=>({productId:p.id,quantity:p.units})),discountCents:cents($('discount').value||'0'),discountReason:$('discount-reason').value||null,paymentMethod:state.paymentMethod,tenderedCents:state.paymentMethod==='CASH'?cents($('tendered').value):0,customerId:selectedCustomerId()});
});});
$('cancel-sale').addEventListener('click',clearSale);
document.querySelectorAll('[data-tendered]').forEach(button=>button.addEventListener('click',()=>fillTendered(button.dataset.tendered)));
document.querySelectorAll('[data-payment-method]').forEach(button=>button.addEventListener('click',()=>{state.paymentMethod=button.dataset.paymentMethod;if(state.paymentMethod!=='CASH')$('tendered').value='';renderTotals();}));
$('open-cash').addEventListener('click',()=>{$('open-description').textContent=`${$('store-select').selectedOptions[0].textContent} · ${$('terminal-select').selectedOptions[0].textContent}`;$('open-dialog').showModal();});
$('open-form').addEventListener('submit',event=>{event.preventDefault();run(()=>command('/api/cash/open',{storeId:storeId(),terminalId:terminalId(),openingCents:cents(event.target.opening.value)}));});
function openCashMove(kind){
$('forgot-open').addEventListener('click',()=>{
  const login=$('login-form'),form=$('forgot-form');
  form.tenant.value=login.tenant.value;form.email.value=login.email.value;$('forgot-status').textContent='';
  $('forgot-dialog').showModal();
});
$('forgot-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{
    await api('/api/password/forgot',{method:'POST',body:JSON.stringify({tenant:event.target.tenant.value,email:event.target.email.value})});
    $('forgot-status').textContent='Pedido registrado. Se os dados estiverem cadastrados, o link chega ao e-mail em instantes.';
  }catch(error){$('forgot-status').textContent=error.message;}finally{button.disabled=false;}
});
// O token chega no fragmento da URL e sai da barra de endereço assim que a página o lê.
const resetToken=(location.hash.match(/^#redefinir=([\w-]{43})$/)??[])[1]??null;
if(location.hash.startsWith('#redefinir='))history.replaceState(null,'',location.pathname+location.search);
if(resetToken)$('reset-dialog').showModal();
$('reset-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  const data=Object.fromEntries(new FormData(event.target));
  try{
    if(data.newPassword!==data.confirmPassword)throw new Error('A confirmação da nova senha não confere.');
    await api('/api/password/reset',{method:'POST',body:JSON.stringify({token:resetToken,newPassword:data.newPassword})});
    event.target.reset();$('reset-dialog').close();
    if(state.me)return location.reload();
    $('login-notice').textContent='Senha redefinida. Entre com a nova senha.';$('login-form').password.focus();
  }catch(error){$('reset-status').textContent=error.message;}finally{button.disabled=false;}
});
  const supply=kind==='SUPPLY';
  $('cash-move-title').textContent=supply?'Registrar suprimento':'Registrar sangria';
  $('cash-move-description').textContent=supply?'Entrada manual de dinheiro no caixa atual.':'Retirada manual de dinheiro do caixa atual.';
  $('cash-move-form').kind.value=kind;$('cash-move-form').amount.value='';$('cash-move-form').reason.value='';
  updateMoneyPreviews();$('cash-move-dialog').showModal();
}
$('cash-supply').addEventListener('click',()=>openCashMove('SUPPLY'));
$('cash-withdrawal').addEventListener('click',()=>openCashMove('WITHDRAWAL'));
$('cash-move-form').addEventListener('submit',event=>{event.preventDefault();run(()=>command('/api/cash/move',{storeId:storeId(),cashSessionId:currentCash().id,kind:event.target.kind.value,amountCents:cents(event.target.amount.value),reason:event.target.reason.value}));});
$('close-cash').addEventListener('click',()=>{$('close-description').textContent=`Dinheiro esperado: ${brl(currentCash().expected_cents)}. Informe a contagem física.`;$('close-dialog').showModal();});
$('close-form').addEventListener('submit',event=>{event.preventDefault();run(()=>command('/api/cash/close',{storeId:storeId(),cashSessionId:currentCash().id,countedCents:cents(event.target.counted.value),reason:event.target.reason.value||null}));});
$('new-product').addEventListener('click',()=>{$('product-dialog').showModal();setTimeout(()=>$('product-form').scan.focus(),0);});
$('product-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/products',{storeId:storeId(),sku:f.sku,barcode:f.barcode||null,name:f.name,priceCents:cents(f.price),initialQuantity:Number(f.quantity)});});});
$('product-form').scan.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();applyProductScan(event.target.form);}});
$('product-form').scan.addEventListener('change',event=>applyProductScan(event.target.form));
function openProductEdit(product){
  const form=$('product-edit-form');form.productId.value=product.id;form.name.value=product.name;form.sku.value=product.sku;form.barcode.value=product.barcode??'';form.price.value=String(product.price_cents);
  updateMoneyPreviews();$('product-edit-dialog').showModal();
}
$('product-edit-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/products/update',{storeId:storeId(),productId:f.productId,sku:f.sku,barcode:f.barcode||null,name:f.name,priceCents:cents(f.price),active:1});});});
function deactivateProduct(product){
  if(!confirm(`Inativar ${product.name}? Ele deixará de aparecer na venda.`))return;
  run(()=>command('/api/products/update',{storeId:storeId(),productId:product.id,sku:product.sku,barcode:product.barcode??null,name:product.name,priceCents:product.price_cents,active:0}));
}
$('adjust-stock').addEventListener('click',()=>{const select=$('stock-form').productId;select.replaceChildren(...state.data.products.map(product=>{const option=element('option',`${product.sku} · ${product.name} · saldo ${product.quantity}`);option.value=product.id;return option;}));$('stock-form').reset();$('stock-dialog').showModal();});
$('stock-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/stock/adjust',{storeId:storeId(),productId:f.productId,quantity:Number(f.quantity),reason:f.reason});});});
function openSaleCancel(sale){
  $('sale-cancel-form').saleId.value=sale.id;$('sale-cancel-form').reason.value='';
  $('sale-cancel-description').textContent=`Venda ${sale.id.slice(0,8)} no valor de ${brl(sale.total_cents)}. O estoque será devolvido e dinheiro será estornado se o pagamento foi em dinheiro.`;
  $('sale-cancel-dialog').showModal();
}
$('sale-cancel-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/sales/cancel',{storeId:storeId(),saleId:f.saleId,reason:f.reason});});});
async function openSaleReturn(sale){
  const receipt=await api(`/api/sales/${sale.id}`);
  const returned=new Map();
  for(const item of receipt.return_items??[])returned.set(item.product_id,(returned.get(item.product_id)??0)+item.quantity);
  const list=$('sale-return-items');list.replaceChildren();
  for(const item of receipt.items){
    const available=item.quantity-(returned.get(item.product_id)??0);
    const row=element('label',undefined,'return-item');
    const info=element('span',`${item.name_snapshot} · vendido ${item.quantity} · disponível ${available}`);
    const input=element('input');input.name=item.product_id;input.type='number';input.min='0';input.max=String(available);input.step='1';input.value='0';input.disabled=available<=0;
    row.append(info,input);list.append(row);
  }
  const form=$('sale-return-form');form.saleId.value=sale.id;form.reason.value='';
  $('sale-return-description').textContent=`Venda ${sale.id.slice(0,8)} no valor de ${brl(sale.total_cents)}. Informe somente as quantidades devolvidas.`;
  $('sale-return-dialog').showModal();
}
$('sale-return-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{
  const form=event.target;
  const items=[...$('sale-return-items').querySelectorAll('input')].map(input=>({productId:input.name,quantity:Number(input.value)})).filter(item=>item.quantity>0);
  if(!items.length)throw new Error('Informe pelo menos um item devolvido.');
  return command('/api/sales/return',{storeId:storeId(),saleId:form.saleId.value,items,reason:form.reason.value});
});});
$('new-customer').addEventListener('click',()=>$('customer-dialog').showModal());
$('customer-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/customers',{storeId:storeId(),name:f.name,document:f.document||null,phone:f.phone||null,email:f.email||null,note:f.note||null});});});
function openCustomerEdit(customer){
  const form=$('customer-edit-form');
  form.customerId.value=customer.id;form.name.value=customer.name;form.document.value=customer.document??'';form.phone.value=customer.phone??'';form.email.value=customer.email??'';form.note.value=customer.note??'';form.active.value=String(customer.active);
  $('customer-edit-dialog').showModal();
}
$('customer-edit-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/customers/update',{storeId:storeId(),customerId:f.customerId,name:f.name,document:f.document||null,phone:f.phone||null,email:f.email||null,note:f.note||null,active:Number(f.active)});});});
$('new-user').addEventListener('click',()=>$('user-dialog').showModal());
$('user-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/users',{storeId:storeId(),email:f.email,name:f.name,role:f.role,temporaryPassword:f.temporaryPassword});});});
function openUserEdit(user){
  const form=$('user-edit-form');
  form.userId.value=user.id;form.name.value=user.name;form.email.value=user.email;form.role.value=user.role;form.active.value=String(user.active);form.temporaryPassword.value='';
  $('user-edit-dialog').showModal();
}
$('user-edit-form').addEventListener('submit',event=>{event.preventDefault();run(()=>{const f=Object.fromEntries(new FormData(event.target));return command('/api/users/update',{storeId:storeId(),userId:f.userId,email:f.email,name:f.name,role:f.role,active:Number(f.active),temporaryPassword:f.temporaryPassword||null});});});
$('recover').addEventListener('click',()=>run(submitPending));
$('print').addEventListener('click',()=>window.print());
$('cash-gate-action').addEventListener('click',()=>setView('cash'));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>run(async()=>{state.tab=b.dataset.tab;$('management-search').value='';document.querySelectorAll('[data-tab]').forEach(button=>button.classList.toggle('selected',button===b));if(state.tab==='reports')await loadReport();renderManagement();})));
$('management-search').addEventListener('input',renderManagement);
document.addEventListener('keydown',event=>{
  if(!state.me)return;
  if(event.key==='F2'){event.preventDefault();$('search').focus();}
  if(event.key==='F9'&&!document.querySelector('dialog[open]')){event.preventDefault();if(!$('confirm-sale').disabled)$('sale-form').requestSubmit();}
  if(event.key==='F10'){event.preventDefault();if(state.lastReceipt){showReceipt(state.lastReceipt);window.print();}}
  if(event.key==='Escape'&&!document.querySelector('dialog[open]')&&state.cart.length){event.preventDefault();clearSale();}
});
boot().catch(error=>{if(error.status!==401)$('login-error').textContent=error.message;});
setInterval(()=>{if(state.me&&state.view==='network'&&document.visibilityState==='visible')run(loadNetwork);},5000);
