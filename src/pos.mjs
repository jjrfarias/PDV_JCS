import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { decryptField, encryptField, fieldDigest, hashPassword, sha256 } from './security.mjs';
import { AppError, requireThat, object, text, integer, id, operationKey } from './errors.mjs';
import { PostgresPos } from './postgres-pos.mjs';
import { reportRange } from './time.mjs';
import { ANONYMIZED_NAME, customerExportDocument, customerSummary } from './privacy.mjs';
import { createMailer } from './mailer.mjs';

const now = () => new Date().toISOString();
const PAYMENT_METHODS = new Set(['CASH','PIX','CARD']);
const CASH_ADJUSTMENTS = new Set(['SUPPLY','WITHDRAWAL']);
const MAX_MONEY = 100_000_000; // R$ 1 milhão por entrada monetária neste laboratório.
const INVITE_TTL_MS = 24 * 60 * 60_000;
const onlyDigits = value => value ? String(value).replace(/\D/g, '') : null;
function customerInput(raw, { updating = false } = {}) {
  object(raw, updating ? ['storeId','customerId','name','document','phone','email','note','active'] : ['storeId','name','document','phone','email','note']);
  const email = raw.email ? text(raw.email, 'E-mail', 120).toLowerCase() : null;
  if(email) requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email),400,'INVALID_EMAIL','E-mail inválido.');
  const document = onlyDigits(raw.document);
  if(document) requireThat(document.length>=11&&document.length<=14,400,'INVALID_DOCUMENT','Documento deve ter CPF ou CNPJ.');
  const phone = onlyDigits(raw.phone);
  if(phone) requireThat(phone.length>=10&&phone.length<=13,400,'INVALID_PHONE','Telefone inválido.');
  return {
    storeId:id(raw.storeId), customerId:updating?id(raw.customerId):undefined,
    name:text(raw.name,'Nome do cliente',120),
    document, phone, email,
    note:raw.note?text(raw.note,'Observação',300):null,
    active:updating?integer(raw.active,'Status',0,1):1
  };
}
function saleReturnInput(raw) {
  object(raw,['storeId','saleId','items','reason']);
  requireThat(Array.isArray(raw.items)&&raw.items.length>0&&raw.items.length<=100,400,'INVALID_ITEMS','Informe os produtos para devolução.');
  const items=raw.items.map(item => {
    object(item,['productId','quantity']);
    return {productId:id(item.productId),quantity:integer(item.quantity,'Quantidade',1,10_000)};
  }).sort((a,b)=>a.productId.localeCompare(b.productId));
  requireThat(new Set(items.map(i=>i.productId)).size===items.length,400,'DUPLICATE_ITEM','Agrupe a quantidade do mesmo produto em uma única linha.');
  return {storeId:id(raw.storeId),saleId:id(raw.saleId),items,reason:text(raw.reason,'Motivo',200,3)};
}
function proratedReturnCents(sale, lineCents) {
  return integer(Math.floor(lineCents*sale.total_cents/sale.subtotal_cents),'Total da devolução',1);
}
// Vendas líquidas por hora (início da hora em UTC). A tela converte para o horário local.
export function hourlySales(sales) {
  const hours = new Map();
  for (const sale of sales) {
    if (sale.canceled_at) continue;
    const start = new Date(sale.created_at); start.setUTCMinutes(0, 0, 0);
    const key = start.toISOString();
    hours.set(key, (hours.get(key) ?? 0) + Number(sale.total_cents) - Number(sale.returned_cents ?? 0));
  }
  return [...hours].sort(([a], [b]) => a.localeCompare(b)).map(([hour, gross_cents]) => ({ hour, gross_cents }));
}
export class Pos {
  constructor(db, hooks = {}) {
    if (typeof db.query === 'function' && typeof db.connect === 'function') return new PostgresPos(db, hooks);
    this.db = db; this.hooks = hooks; this.mailer = hooks.mailer ?? createMailer();
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  user(ctx) {
    const user = this.one('SELECT id,name,email,role,company_admin,mfa_enabled FROM users WHERE tenant_id=? AND id=? AND active=1',ctx.tenantId,ctx.userId);
    requireThat(user,401,'AUTH_REQUIRED','Faça login novamente.');
    return user;
  }
  authorize(ctx, storeId) {
    const user = this.user(ctx);
    const membership=this.one('SELECT role FROM memberships WHERE tenant_id=? AND user_id=? AND store_id=? AND active=1',ctx.tenantId,ctx.userId,storeId);
    requireThat(membership,403,'STORE_FORBIDDEN','Você não tem acesso a esta loja.');
    // Loja desativada não opera: venda, caixa, estoque e cadastros ficam bloqueados.
    requireThat(this.one('SELECT 1 FROM stores WHERE tenant_id=? AND id=? AND active=1',ctx.tenantId,storeId),403,'STORE_INACTIVE','Esta loja está desativada.');
    // O perfil vale só para esta loja; account_role é o resumo da conta.
    return {...user,account_role:user.role,role:membership.role};
  }
  me(ctx) {
    return { user:this.user(ctx), tenantId:ctx.tenantId,
      stores:this.all(`SELECT s.id,s.name,m.role FROM stores s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
        WHERE m.tenant_id=? AND m.user_id=? AND m.active=1 AND s.active=1 ORDER BY s.name`,ctx.tenantId,ctx.userId) };
  }
  audit(ctx, storeId, action, entityId, details) {
    this.run('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),ctx.userId,storeId,action,entityId,JSON.stringify(details),now());
  }
  auditReportExport(ctx,storeId,range,section) {
    id(storeId);
    return transaction(this.db,()=>{
      this.authorize(ctx,storeId);
      this.audit(ctx,storeId,'REPORT_EXPORTED',storeId,{from:range.from,to:range.to,section});
    });
  }
  // Todas as mutações passam por aqui. A chave e a resposta são persistidas junto com seus efeitos.
  mutate(ctx, kind, key, input, work) {
    operationKey(key);
    return transaction(this.db, () => {
      const user = this.authorize(ctx,input.storeId);
      const hash = sha256(JSON.stringify({kind,input}));
      const previous = this.one('SELECT * FROM operations WHERE tenant_id=? AND key=?',ctx.tenantId,key);
      if (previous) {
        requireThat(previous.user_id===ctx.userId && previous.store_id===input.storeId && previous.payload_hash===hash,
          409,'IDEMPOTENCY_CONFLICT','Esta chave já foi usada em outra operação ou com outros dados.');
        return { data:JSON.parse(previous.response_json), replayed:true };
      }
      const data = work(user);
      this.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,key,ctx.userId,input.storeId,kind,hash,JSON.stringify(data),now());
      // Ponto de falha injetável apenas por testes de código. Não existe flag ou rota HTTP para isto.
      this.hooks.beforeCommit?.(kind);
      return {data,replayed:false};
    });
  }
  operation(ctx,key) {
    operationKey(key);
    const op = this.one('SELECT * FROM operations WHERE tenant_id=? AND key=? AND user_id=?',ctx.tenantId,key,ctx.userId);
    requireThat(op,404,'NOT_FOUND','Operação não encontrada para este usuário.');
    this.authorize(ctx,op.store_id);
    return {data:JSON.parse(op.response_json),replayed:true,kind:op.kind};
  }
  // Lojas da empresa, inclusive desativadas, para o administrador da empresa.
  companyStores(ctx) {
    requireThat(this.user(ctx).company_admin===1,403,'COMPANY_ADMIN_REQUIRED','Somente o administrador da empresa gerencia lojas.');
    return {stores:this.all(`SELECT s.id,s.name,s.active,
        (SELECT COUNT(*) FROM terminals t WHERE t.tenant_id=s.tenant_id AND t.store_id=s.id) terminal_count,
        (SELECT COUNT(*) FROM memberships m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.user_id WHERE m.tenant_id=s.tenant_id AND m.store_id=s.id AND u.active=1) user_count,
        (SELECT COUNT(*) FROM cash_sessions c WHERE c.tenant_id=s.tenant_id AND c.store_id=s.id AND c.status='OPEN') open_cash_count
      FROM stores s WHERE s.tenant_id=? ORDER BY s.active DESC,s.name`,ctx.tenantId)};
  }
  updateStore(ctx,key,raw) {
    object(raw,['storeId','name','active']);operationKey(key);
    const input={storeId:id(raw.storeId),name:text(raw.name,'Nome da loja',120,2),active:raw.active};
    requireThat(input.active===0||input.active===1,400,'INVALID_INPUT','Status inválido.');
    return transaction(this.db,()=>{
      requireThat(this.user(ctx).company_admin===1,403,'COMPANY_ADMIN_REQUIRED','Somente o administrador da empresa gerencia lojas.');
      const hash=sha256(JSON.stringify({kind:'STORE_UPDATE',input}));
      const previous=this.one('SELECT * FROM operations WHERE tenant_id=? AND key=?',ctx.tenantId,key);
      if(previous){requireThat(previous.user_id===ctx.userId&&previous.kind==='STORE_UPDATE'&&previous.payload_hash===hash,409,'IDEMPOTENCY_CONFLICT','Esta chave já foi usada em outra operação ou com outros dados.');return {data:JSON.parse(previous.response_json),replayed:true};}
      const current=this.one('SELECT id,name,active FROM stores WHERE tenant_id=? AND id=?',ctx.tenantId,input.storeId);
      requireThat(current,404,'STORE_NOT_FOUND','Loja não encontrada.');
      requireThat(this.one('SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND store_id=?',ctx.tenantId,ctx.userId,input.storeId),403,'STORE_FORBIDDEN','Você não tem acesso a esta loja.');
      requireThat(!this.one('SELECT 1 FROM stores WHERE tenant_id=? AND lower(name)=lower(?) AND id<>?',ctx.tenantId,input.name,input.storeId),409,'DUPLICATE_STORE','Já existe uma loja com este nome.');
      if(input.active===0&&current.active===1){
        requireThat(!this.one("SELECT 1 FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='OPEN'",ctx.tenantId,input.storeId),409,'STORE_CASH_OPEN','Feche os caixas abertos desta loja antes de desativá-la.');
        requireThat(this.one('SELECT COUNT(*) n FROM stores WHERE tenant_id=? AND active=1 AND id<>?',ctx.tenantId,input.storeId).n>0,409,'LAST_ACTIVE_STORE','A empresa precisa de pelo menos uma loja ativa.');
      }
      this.run('UPDATE stores SET name=?,active=? WHERE tenant_id=? AND id=?',input.name,input.active,ctx.tenantId,input.storeId);
      const action=current.active===input.active?'STORE_UPDATED':input.active===1?'STORE_REACTIVATED':'STORE_DEACTIVATED';
      this.audit(ctx,input.storeId,action,input.storeId,{renamed:current.name!==input.name,active:input.active});
      const data={store:{id:input.storeId,name:input.name,active:input.active}};
      this.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,key,ctx.userId,input.storeId,'STORE_UPDATE',hash,JSON.stringify(data),now());
      return {data,replayed:false};
    });
  }
  async createStore(ctx,key,raw,origin) {
    object(raw,['name','managerName','managerEmail']);operationKey(key);
    const input={name:text(raw.name,'Nome da loja',120,2),managerName:text(raw.managerName,'Nome do gerente',120,2),managerEmail:text(raw.managerEmail,'E-mail do gerente',120).toLowerCase()};
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.managerEmail),400,'INVALID_EMAIL','E-mail inválido.');
    const ids={storeId:`store-${randomUUID()}`,terminalId:`terminal-${randomUUID()}`,managerId:`user-${randomUUID()}`,resetId:randomUUID()};
    const inviteToken=`${randomUUID()}${randomUUID()}`.replaceAll('-',''),createdAt=Date.now();let created=false;
    const result=transaction(this.db,()=>{
      const user=this.user(ctx);requireThat(user.company_admin===1,403,'COMPANY_ADMIN_REQUIRED','Somente o administrador da empresa pode criar lojas.');
      const hash=sha256(JSON.stringify({kind:'STORE_CREATE',input}));
      const previous=this.one('SELECT * FROM operations WHERE tenant_id=? AND key=?',ctx.tenantId,key);
      if(previous){requireThat(previous.user_id===ctx.userId&&previous.kind==='STORE_CREATE'&&previous.payload_hash===hash,409,'IDEMPOTENCY_CONFLICT','Esta chave já foi usada em outra operação ou com outros dados.');return {data:JSON.parse(previous.response_json),replayed:true};}
      requireThat(!this.one('SELECT 1 FROM stores WHERE tenant_id=? AND lower(name)=lower(?)',ctx.tenantId,input.name),409,'DUPLICATE_STORE','Já existe uma loja com este nome.');
      requireThat(!this.one('SELECT 1 FROM users WHERE tenant_id=? AND email=?',ctx.tenantId,input.managerEmail),409,'DUPLICATE_USER','E-mail já cadastrado.');
      const company=this.one('SELECT id,name FROM companies WHERE tenant_id=? ORDER BY id LIMIT 1',ctx.tenantId);requireThat(company,404,'COMPANY_NOT_FOUND','Empresa não encontrada.');
      this.run('INSERT INTO stores(tenant_id,id,company_id,name) VALUES(?,?,?,?)',ctx.tenantId,ids.storeId,company.id,input.name);
      this.run('INSERT INTO terminals(tenant_id,store_id,id,name) VALUES(?,?,?,?)',ctx.tenantId,ids.storeId,ids.terminalId,'Caixa 01');
      this.run("INSERT INTO users(tenant_id,id,email,name,password_hash,role,company_admin) VALUES(?,?,?,?,?,'MANAGER',0)",ctx.tenantId,ids.managerId,input.managerEmail,input.managerName,hashPassword(inviteToken));
      this.run("INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES(?,?,?,'MANAGER')",ctx.tenantId,ctx.userId,ids.storeId);this.run("INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES(?,?,?,'MANAGER')",ctx.tenantId,ids.managerId,ids.storeId);
      this.run('INSERT INTO stock(tenant_id,store_id,product_id,quantity) SELECT tenant_id,?,id,0 FROM products WHERE tenant_id=?',ids.storeId,ctx.tenantId);
      this.run('INSERT INTO password_resets(tenant_id,id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',ctx.tenantId,ids.resetId,ids.managerId,sha256(inviteToken),createdAt+INVITE_TTL_MS,createdAt);
      this.audit(ctx,ids.storeId,'STORE_CREATED',ids.storeId,{terminalId:ids.terminalId,managerId:ids.managerId});
      const data={store:{id:ids.storeId,name:input.name},terminal:{id:ids.terminalId,name:'Caixa 01'},manager:{id:ids.managerId,name:input.managerName,email:input.managerEmail,invited:true}};
      this.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,key,ctx.userId,ids.storeId,'STORE_CREATE',hash,JSON.stringify(data),now());created=true;return {data,replayed:false};
    });
    if(created) Promise.resolve(this.mailer.sendInvite({to:input.managerEmail,link:`${origin}/#redefinir=${inviteToken}`,tenantName:this.one('SELECT name FROM tenants WHERE id=?',ctx.tenantId).name,tenantSlug:this.one('SELECT slug FROM tenants WHERE id=?',ctx.tenantId).slug})).catch(()=>{});
    return result;
  }
  createProduct(ctx,key,raw) {
    object(raw,['storeId','sku','barcode','name','priceCents','initialQuantity']);
    const input = {storeId:id(raw.storeId),sku:text(raw.sku,'Código',40).toUpperCase(),
      barcode:raw.barcode ? text(raw.barcode,'Código de barras',48) : null,
      name:text(raw.name,'Nome'),priceCents:integer(raw.priceCents,'Preço',1),initialQuantity:integer(raw.initialQuantity,'Estoque',0,1_000_000)};
    return this.mutate(ctx,'PRODUCT_CREATE',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente cadastra produtos neste incremento.');
      requireThat(!this.one('SELECT 1 FROM products WHERE tenant_id=? AND (sku=? OR (barcode IS NOT NULL AND barcode=?))',ctx.tenantId,input.sku,input.barcode),409,'DUPLICATE_PRODUCT','Código interno ou código de barras já cadastrado.');
      const productId=randomUUID();
      this.run('INSERT INTO products(tenant_id,id,sku,barcode,name,price_cents) VALUES(?,?,?,?,?,?)',ctx.tenantId,productId,input.sku,input.barcode,input.name,input.priceCents);
      this.run('INSERT INTO stock VALUES(?,?,?,?)',ctx.tenantId,input.storeId,productId,input.initialQuantity);
      if(input.initialQuantity>0) this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,productId,null,input.initialQuantity,'INITIAL','Cadastro com estoque inicial',ctx.userId,now());
      this.audit(ctx,input.storeId,'PRODUCT_CREATED',productId,{initialQuantity:input.initialQuantity,priceCents:input.priceCents});
      return {id:productId,...input};
    });
  }
  updateProduct(ctx,key,raw) {
    object(raw,['storeId','productId','sku','barcode','name','priceCents','active']);
    const input = {storeId:id(raw.storeId),productId:id(raw.productId),sku:text(raw.sku,'Código',40).toUpperCase(),
      barcode:raw.barcode ? text(raw.barcode,'Código de barras',48) : null,
      name:text(raw.name,'Nome'),priceCents:integer(raw.priceCents,'Preço',1),active:integer(raw.active,'Status',0,1)};
    return this.mutate(ctx,'PRODUCT_UPDATE',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente altera produtos.');
      const current=this.one(`SELECT p.* FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE p.tenant_id=? AND s.store_id=? AND p.id=?`,ctx.tenantId,input.storeId,input.productId);
      requireThat(current,404,'PRODUCT_NOT_FOUND','Produto não disponível nesta loja.');
      requireThat(!this.one(`SELECT 1 FROM products WHERE tenant_id=? AND id<>? AND (sku=? OR (barcode IS NOT NULL AND barcode=?))`,
        ctx.tenantId,input.productId,input.sku,input.barcode),409,'DUPLICATE_PRODUCT','Código interno ou código de barras já cadastrado.');
      this.run(`UPDATE products SET sku=?,barcode=?,name=?,price_cents=?,active=? WHERE tenant_id=? AND id=?`,
        input.sku,input.barcode,input.name,input.priceCents,input.active,ctx.tenantId,input.productId);
      this.audit(ctx,input.storeId,'PRODUCT_UPDATED',input.productId,{sku:input.sku,barcode:input.barcode,name:input.name,priceCents:input.priceCents,active:input.active});
      return {id:input.productId,sku:input.sku,barcode:input.barcode,name:input.name,price_cents:input.priceCents,active:input.active};
    });
  }
  // Resumo da conta: gerente se for gerente em alguma loja ativa; conta inativa se não restar loja.
  syncAccount(tenantId,userId) {
    this.run(`UPDATE users SET
      role=CASE WHEN EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=users.tenant_id AND m.user_id=users.id AND m.active=1 AND m.role='MANAGER') THEN 'MANAGER' ELSE 'CASHIER' END,
      active=CASE WHEN EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=users.tenant_id AND m.user_id=users.id AND m.active=1) THEN 1 ELSE 0 END
      WHERE tenant_id=? AND id=?`,tenantId,userId);
  }
  createUser(ctx,key,raw) {
    object(raw,['storeId','email','name','role','temporaryPassword']);
    const input={storeId:id(raw.storeId),email:text(raw.email,'E-mail',120).toLowerCase(),name:text(raw.name,'Nome',120),
      role:text(raw.role,'Perfil',20),temporaryPassword:text(raw.temporaryPassword,'Senha temporária',200,12)};
    requireThat(['MANAGER','CASHIER'].includes(input.role),400,'INVALID_ROLE','Perfil inválido.');
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email),400,'INVALID_EMAIL','E-mail inválido.');
    requireThat(/[A-Z]/.test(input.temporaryPassword)&&/[a-z]/.test(input.temporaryPassword)&&/\d/.test(input.temporaryPassword),
      400,'WEAK_PASSWORD','A senha temporária deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    return this.mutate(ctx,'USER_CREATE',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente cadastra usuários.');
      const existing=this.one('SELECT id,name,email,active,company_admin FROM users WHERE tenant_id=? AND email=?',ctx.tenantId,input.email);
      if(existing){
        // Pessoa já existe na empresa: ganha acesso a esta loja com o perfil escolhido. Senha e nome não mudam.
        requireThat(!this.one('SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND store_id=?',ctx.tenantId,existing.id,input.storeId),409,'DUPLICATE_USER','Esta pessoa já está vinculada a esta loja. Use Editar.');
        requireThat(existing.active===1,409,'USER_INACTIVE','Esta conta está desativada. Fale com o administrador da empresa.');
        this.run('INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES(?,?,?,?)',ctx.tenantId,existing.id,input.storeId,input.role);
        this.syncAccount(ctx.tenantId,existing.id);
        this.audit(ctx,input.storeId,'USER_LINKED',existing.id,{role:input.role});
        return {id:existing.id,email:existing.email,name:existing.name,role:input.role,active:1,storeId:input.storeId,linked:true};
      }
      const userId=randomUUID();
      this.run('INSERT INTO users(tenant_id,id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,?,1)',
        ctx.tenantId,userId,input.email,input.name,hashPassword(input.temporaryPassword),input.role);
      this.run('INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES(?,?,?,?)',ctx.tenantId,userId,input.storeId,input.role);
      this.audit(ctx,input.storeId,'USER_CREATED',userId,{email:input.email,role:input.role});
      return {id:userId,email:input.email,name:input.name,role:input.role,active:1,storeId:input.storeId,linked:false};
    });
  }
  updateUser(ctx,key,raw) {
    object(raw,['storeId','userId','email','name','role','active','temporaryPassword']);
    const input={storeId:id(raw.storeId),userId:id(raw.userId),email:text(raw.email,'E-mail',120).toLowerCase(),name:text(raw.name,'Nome',120),
      role:text(raw.role,'Perfil',20),active:integer(raw.active,'Status',0,1),
      temporaryPassword:raw.temporaryPassword?text(raw.temporaryPassword,'Senha temporária',200,12):null};
    requireThat(['MANAGER','CASHIER'].includes(input.role),400,'INVALID_ROLE','Perfil inválido.');
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email),400,'INVALID_EMAIL','E-mail inválido.');
    if(input.temporaryPassword) requireThat(/[A-Z]/.test(input.temporaryPassword)&&/[a-z]/.test(input.temporaryPassword)&&/\d/.test(input.temporaryPassword),
      400,'WEAK_PASSWORD','A senha temporária deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    return this.mutate(ctx,'USER_UPDATE',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente altera usuários.');
      const current=this.one(`SELECT u.id,u.name,u.email,u.company_admin,m.role,m.active FROM users u JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE u.tenant_id=? AND u.id=? AND m.store_id=?`,ctx.tenantId,input.userId,input.storeId);
      requireThat(current,404,'USER_NOT_FOUND','Usuário não encontrado nesta loja.');
      requireThat(current.company_admin!==1,403,'COMPANY_ADMIN_PROTECTED','O administrador da empresa não pode ser alterado pela gestão da loja.');
      requireThat(!(input.userId===ctx.userId&&input.active===0),400,'SELF_DEACTIVATE_FORBIDDEN','Não é permitido remover seu próprio acesso.');
      requireThat(!(input.userId===ctx.userId&&input.role!=='MANAGER'),400,'SELF_ROLE_CHANGE_FORBIDDEN','Não é permitido remover seu próprio perfil de gerente.');
      const identityChanged=input.email!==current.email||input.name!==current.name||Boolean(input.temporaryPassword);
      if(identityChanged&&user.company_admin!==1){
        // Nome, e-mail e senha são da pessoa: só muda quem gerencia todas as lojas dela.
        const elsewhere=this.one(`SELECT 1 FROM memberships o WHERE o.tenant_id=? AND o.user_id=? AND o.store_id<>? AND o.active=1
          AND NOT EXISTS(SELECT 1 FROM memberships e WHERE e.tenant_id=o.tenant_id AND e.user_id=? AND e.store_id=o.store_id AND e.active=1 AND e.role='MANAGER')`,
          ctx.tenantId,input.userId,input.storeId,ctx.userId);
        requireThat(!elsewhere,403,'USER_SHARED','Esta pessoa também trabalha em outra loja. Nome, e-mail e senha só podem ser alterados pelo administrador da empresa.');
      }
      requireThat(!this.one('SELECT 1 FROM users WHERE tenant_id=? AND email=? AND id<>?',ctx.tenantId,input.email,input.userId),409,'DUPLICATE_USER','E-mail já cadastrado.');
      const passwordHash=input.temporaryPassword?hashPassword(input.temporaryPassword):null;
      if(identityChanged) this.run('UPDATE users SET email=?,name=? WHERE tenant_id=? AND id=?',input.email,input.name,ctx.tenantId,input.userId);
      if(passwordHash) this.run('UPDATE users SET password_hash=? WHERE tenant_id=? AND id=?',passwordHash,ctx.tenantId,input.userId);
      this.run('UPDATE memberships SET role=?,active=? WHERE tenant_id=? AND user_id=? AND store_id=?',input.role,input.active,ctx.tenantId,input.userId,input.storeId);
      this.syncAccount(ctx.tenantId,input.userId);
      if(passwordHash||input.active!==current.active||current.role!==input.role) this.run('DELETE FROM sessions WHERE tenant_id=? AND user_id=?',ctx.tenantId,input.userId);
      this.audit(ctx,input.storeId,'USER_UPDATED',input.userId,{role:input.role,access:input.active,identityChanged,passwordReset:Boolean(passwordHash)});
      return {id:input.userId,email:input.email,name:input.name,role:input.role,active:input.active,storeId:input.storeId,passwordReset:Boolean(passwordHash)};
    });
  }

  customerRow(row) {
    return row ? {id:row.id,store_id:row.store_id,name:decryptField(row.name_enc),
      document:decryptField(row.document_enc),phone:decryptField(row.phone_enc),email:decryptField(row.email_enc),
      note:decryptField(row.note_enc),active:row.active,created_at:row.created_at,updated_at:row.updated_at} : null;
  }
  // Cadastro completo de um cliente, sob demanda. Cada consulta fica auditada.
  customerDetail(ctx,storeId,customerId) {
    id(storeId);id(customerId);
    this.authorize(ctx,storeId);
    const row=this.one('SELECT * FROM customers WHERE tenant_id=? AND store_id=? AND id=?',ctx.tenantId,storeId,customerId);
    requireThat(row,404,'CUSTOMER_NOT_FOUND','Cliente não encontrado nesta loja.');
    this.audit(ctx,storeId,'CUSTOMER_VIEWED',customerId,{});
    return this.customerRow(row);
  }
  customerMutationResult(row) {
    return {id:row.id,storeId:row.store_id,active:row.active,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  createCustomer(ctx,key,raw) {
    const input=customerInput(raw);
    return this.mutate(ctx,'CUSTOMER_CREATE',key,input,() => {
      if(input.document) requireThat(!this.one('SELECT 1 FROM customers WHERE tenant_id=? AND document_hash=?',ctx.tenantId,fieldDigest(input.document)),409,'DUPLICATE_CUSTOMER','Documento já cadastrado.');
      const customerId=randomUUID(), createdAt=now();
      this.run(`INSERT INTO customers(tenant_id,id,store_id,name_enc,document_hash,document_enc,phone_hash,phone_enc,email_hash,email_enc,note_enc,active,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,ctx.tenantId,customerId,input.storeId,encryptField(input.name),
        fieldDigest(input.document),encryptField(input.document),fieldDigest(input.phone),encryptField(input.phone),
        fieldDigest(input.email),encryptField(input.email),encryptField(input.note),1,createdAt,createdAt);
      this.audit(ctx,input.storeId,'CUSTOMER_CREATED',customerId,{active:1,hasDocument:Boolean(input.document),hasEmail:Boolean(input.email)});
      return this.customerMutationResult(this.one('SELECT id,store_id,active,created_at,updated_at FROM customers WHERE tenant_id=? AND id=?',ctx.tenantId,customerId));
    });
  }
  updateCustomer(ctx,key,raw) {
    const input=customerInput(raw,{updating:true});
    return this.mutate(ctx,'CUSTOMER_UPDATE',key,input,() => {
      const current=this.one('SELECT * FROM customers WHERE tenant_id=? AND store_id=? AND id=?',ctx.tenantId,input.storeId,input.customerId);
      requireThat(current,404,'CUSTOMER_NOT_FOUND','Cliente não encontrado nesta loja.');
      if(input.document) requireThat(!this.one('SELECT 1 FROM customers WHERE tenant_id=? AND document_hash=? AND id<>?',ctx.tenantId,fieldDigest(input.document),input.customerId),409,'DUPLICATE_CUSTOMER','Documento já cadastrado.');
      const updatedAt=now();
      this.run(`UPDATE customers SET name_enc=?,document_hash=?,document_enc=?,phone_hash=?,phone_enc=?,email_hash=?,email_enc=?,note_enc=?,active=?,updated_at=?
        WHERE tenant_id=? AND id=?`,encryptField(input.name),fieldDigest(input.document),encryptField(input.document),
        fieldDigest(input.phone),encryptField(input.phone),fieldDigest(input.email),encryptField(input.email),
        encryptField(input.note),input.active,updatedAt,ctx.tenantId,input.customerId);
      this.audit(ctx,input.storeId,'CUSTOMER_UPDATED',input.customerId,{active:input.active,hasDocument:Boolean(input.document),hasEmail:Boolean(input.email)});
      return this.customerMutationResult(this.one('SELECT id,store_id,active,created_at,updated_at FROM customers WHERE tenant_id=? AND id=?',ctx.tenantId,input.customerId));
    });
  }
  // Direito de acesso e portabilidade do titular (LGPD art. 18, II e V): cadastro completo e compras vinculadas.
  customerExport(ctx,storeId,customerId) {
    id(storeId);id(customerId);
    return transaction(this.db,()=>{
      const user=this.authorize(ctx,storeId);
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente exporta dados do titular.');
      const row=this.one('SELECT * FROM customers WHERE tenant_id=? AND store_id=? AND id=?',ctx.tenantId,storeId,customerId);
      requireThat(row,404,'CUSTOMER_NOT_FOUND','Cliente não encontrado nesta loja.');
      const sales=this.all('SELECT id,store_id,total_cents,created_at FROM sales WHERE tenant_id=? AND customer_id=? ORDER BY created_at',ctx.tenantId,customerId);
      this.audit(ctx,storeId,'CUSTOMER_EXPORTED',customerId,{sales:sales.length});
      return customerExportDocument(this.customerRow(row),sales);
    });
  }
  // Eliminação a pedido do titular (LGPD art. 18, IV e VI). As vendas continuam para obrigação fiscal e contábil,
  // mas deixam de apontar para alguém identificável. Irreversível: os campos são apagados, não cifrados.
  anonymizeCustomer(ctx,key,raw) {
    object(raw,['storeId','customerId']);
    const input={storeId:id(raw.storeId),customerId:id(raw.customerId)};
    return this.mutate(ctx,'CUSTOMER_ANONYMIZE',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente anonimiza clientes.');
      requireThat(this.one('SELECT 1 FROM customers WHERE tenant_id=? AND store_id=? AND id=?',ctx.tenantId,input.storeId,input.customerId),404,'CUSTOMER_NOT_FOUND','Cliente não encontrado nesta loja.');
      const updatedAt=now();
      this.run(`UPDATE customers SET name_enc=?,document_hash=NULL,document_enc=NULL,phone_hash=NULL,phone_enc=NULL,
        email_hash=NULL,email_enc=NULL,note_enc=NULL,active=0,updated_at=? WHERE tenant_id=? AND id=?`,
        encryptField(ANONYMIZED_NAME),updatedAt,ctx.tenantId,input.customerId);
      this.audit(ctx,input.storeId,'CUSTOMER_ANONYMIZED',input.customerId,{});
      return this.customerMutationResult(this.one('SELECT id,store_id,active,created_at,updated_at FROM customers WHERE tenant_id=? AND id=?',ctx.tenantId,input.customerId));
    });
  }
  adjustStock(ctx,key,raw) {
    object(raw,['storeId','productId','quantity','reason']);
    const input={storeId:id(raw.storeId),productId:id(raw.productId),quantity:integer(raw.quantity,'Quantidade',-1_000_000,1_000_000),
      reason:text(raw.reason,'Motivo',200,3)};
    requireThat(input.quantity!==0,400,'INVALID_INPUT','Quantidade deve ser diferente de zero.');
    return this.mutate(ctx,'STOCK_ADJUST',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente ajusta estoque.');
      const product=this.one(`SELECT p.name,s.quantity FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE p.tenant_id=? AND s.store_id=? AND p.id=? AND p.active=1`,ctx.tenantId,input.storeId,input.productId);
      requireThat(product,404,'PRODUCT_NOT_FOUND','Produto não disponível nesta loja.');
      const changed=this.run(`UPDATE stock SET quantity=quantity+? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity+? BETWEEN 0 AND 1000000`,
        input.quantity,ctx.tenantId,input.storeId,input.productId,input.quantity);
      requireThat(changed.changes===1,409,'STOCK_LIMIT','Ajuste deixaria o estoque fora do limite permitido.');
      this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,input.productId,null,input.quantity,'ADJUSTMENT',input.reason,ctx.userId,now());
      this.audit(ctx,input.storeId,'STOCK_ADJUSTED',input.productId,{quantity:input.quantity,reason:input.reason});
      const updated=this.one('SELECT quantity FROM stock WHERE tenant_id=? AND store_id=? AND product_id=?',ctx.tenantId,input.storeId,input.productId);
      return {productId:input.productId,name:product.name,quantity:updated.quantity,adjustment:input.quantity,reason:input.reason};
    });
  }
  transferStock(ctx,key,raw) {
    const action=String(raw?.action??'REQUEST').toUpperCase();
    if(action==='REQUEST'){
      object(raw,['action','storeId','originStoreId','destinationStoreId','productId','quantity','note']);
      const input={action,storeId:id(raw.storeId),originStoreId:id(raw.originStoreId),destinationStoreId:id(raw.destinationStoreId),productId:id(raw.productId),quantity:integer(raw.quantity,'Quantidade',1,10000),note:raw.note?text(raw.note,'Observação',200):null};
      requireThat(input.storeId===input.destinationStoreId,400,'INVALID_INPUT','A solicitação deve partir da loja de destino.');requireThat(input.originStoreId!==input.destinationStoreId,400,'INVALID_INPUT','Escolha lojas diferentes.');
      return this.mutate(ctx,'TRANSFER_REQUEST',key,input,user=>{requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente solicita transferência.');
        const product=this.one(`SELECT p.name,o.quantity origin_quantity FROM products p JOIN stock o ON o.tenant_id=p.tenant_id AND o.product_id=p.id AND o.store_id=? JOIN stock d ON d.tenant_id=p.tenant_id AND d.product_id=p.id AND d.store_id=? WHERE p.tenant_id=? AND p.id=? AND p.active=1`,input.originStoreId,input.destinationStoreId,ctx.tenantId,input.productId);
        requireThat(product,404,'PRODUCT_NOT_FOUND','Produto não disponível nas duas lojas.');requireThat(product.origin_quantity>=input.quantity,409,'INSUFFICIENT_STOCK','A loja de origem não possui saldo suficiente.');
        const transferId=randomUUID(),createdAt=now();this.run(`INSERT INTO stock_transfers(tenant_id,id,origin_store_id,destination_store_id,product_id,quantity,status,note,requested_by,created_at) VALUES(?,?,?,?,?,?,'REQUESTED',?,?,?)`,ctx.tenantId,transferId,input.originStoreId,input.destinationStoreId,input.productId,input.quantity,input.note,ctx.userId,createdAt);
        this.audit(ctx,input.destinationStoreId,'TRANSFER_REQUESTED',transferId,{originStoreId:input.originStoreId,productId:input.productId,quantity:input.quantity});return {id:transferId,status:'REQUESTED',productName:product.name};});
    }
    object(raw,['action','storeId','transferId']);const input={action,storeId:id(raw.storeId),transferId:id(raw.transferId)};
    return this.mutate(ctx,`TRANSFER_${action}`,key,input,user=>{requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente movimenta transferências.');
      const transfer=this.one('SELECT * FROM stock_transfers WHERE tenant_id=? AND id=?',ctx.tenantId,input.transferId);requireThat(transfer,404,'TRANSFER_NOT_FOUND','Transferência não encontrada.');const timestamp=now();
      if(action==='APPROVE'){requireThat(input.storeId===transfer.origin_store_id,403,'STORE_FORBIDDEN','A loja de origem deve aprovar.');requireThat(transfer.status==='REQUESTED',409,'TRANSFER_STATUS','Esta transferência não aguarda aprovação.');this.run("UPDATE stock_transfers SET status='APPROVED',approved_by=?,approved_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.transferId);}
      else if(action==='SHIP'){requireThat(input.storeId===transfer.origin_store_id,403,'STORE_FORBIDDEN','A loja de origem deve enviar.');requireThat(transfer.status==='APPROVED',409,'TRANSFER_STATUS','A transferência precisa estar aprovada.');const changed=this.run(`UPDATE stock SET quantity=quantity-? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity-(SELECT COALESCE(SUM(r.quantity),0) FROM stock_reservations r WHERE r.tenant_id=stock.tenant_id AND r.pickup_store_id=stock.store_id AND r.product_id=stock.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP)>=?`,transfer.quantity,ctx.tenantId,transfer.origin_store_id,transfer.product_id,transfer.quantity);requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo insuficiente na loja de origem.');this.run("UPDATE stock_transfers SET status='IN_TRANSIT',shipped_by=?,shipped_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.transferId);this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),transfer.origin_store_id,transfer.product_id,null,-transfer.quantity,'ADJUSTMENT',`Transferência enviada ${transfer.id}`,ctx.userId,timestamp);}
      else if(action==='RECEIVE'){requireThat(input.storeId===transfer.destination_store_id,403,'STORE_FORBIDDEN','A loja de destino deve receber.');requireThat(transfer.status==='IN_TRANSIT',409,'TRANSFER_STATUS','A transferência ainda não foi enviada.');this.run('UPDATE stock SET quantity=quantity+? WHERE tenant_id=? AND store_id=? AND product_id=?',transfer.quantity,ctx.tenantId,transfer.destination_store_id,transfer.product_id);this.run("UPDATE stock_transfers SET status='RECEIVED',received_by=?,received_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.transferId);this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),transfer.destination_store_id,transfer.product_id,null,transfer.quantity,'ADJUSTMENT',`Transferência recebida ${transfer.id}`,ctx.userId,timestamp);}
      else if(action==='CANCEL'){requireThat(input.storeId===transfer.origin_store_id||input.storeId===transfer.destination_store_id,403,'STORE_FORBIDDEN','Somente uma loja envolvida pode cancelar.');requireThat(['REQUESTED','APPROVED'].includes(transfer.status),409,'TRANSFER_STATUS','Transferência enviada não pode ser cancelada.');this.run("UPDATE stock_transfers SET status='CANCELED',canceled_by=?,canceled_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.transferId);}
      else throw new AppError(400,'INVALID_INPUT','Ação de transferência inválida.');
      const status=action==='APPROVE'?'APPROVED':action==='SHIP'?'IN_TRANSIT':action==='RECEIVE'?'RECEIVED':'CANCELED';this.audit(ctx,input.storeId,`TRANSFER_${status}`,input.transferId,{status});return {id:input.transferId,status};});
  }
  reserveStock(ctx,key,raw) {
    const action=String(raw?.action??'REQUEST').toUpperCase();
    if(action==='REQUEST'){
      object(raw,['action','storeId','pickupStoreId','productId','customerId','quantity','expiresHours']);
      const input={action,storeId:id(raw.storeId),pickupStoreId:id(raw.pickupStoreId),productId:id(raw.productId),customerId:id(raw.customerId),quantity:integer(raw.quantity,'Quantidade',1,100),expiresHours:integer(raw.expiresHours,'Prazo',1,168)};
      requireThat(input.storeId!==input.pickupStoreId,400,'INVALID_INPUT','Escolha outra loja para retirada.');
      return this.mutate(ctx,'RESERVATION_REQUEST',key,input,()=>{requireThat(this.one('SELECT 1 FROM customers WHERE tenant_id=? AND id=? AND store_id=? AND active=1',ctx.tenantId,input.customerId,input.storeId),404,'CUSTOMER_NOT_FOUND','Selecione um cliente ativo desta loja.');requireThat(this.one('SELECT 1 FROM stores WHERE tenant_id=? AND id=? AND active=1',ctx.tenantId,input.pickupStoreId),404,'STORE_NOT_FOUND','Loja de retirada não encontrada.');requireThat(this.one('SELECT 1 FROM stock s JOIN products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id WHERE s.tenant_id=? AND s.store_id=? AND s.product_id=? AND p.active=1',ctx.tenantId,input.pickupStoreId,input.productId),404,'PRODUCT_NOT_FOUND','Produto não disponível na loja escolhida.');const reservationId=randomUUID(),createdAt=now(),expiresAt=new Date(Date.now()+input.expiresHours*3600000).toISOString();this.run(`INSERT INTO stock_reservations(tenant_id,id,requesting_store_id,pickup_store_id,product_id,customer_id,quantity,status,requested_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,'REQUESTED',?,?,?)`,ctx.tenantId,reservationId,input.storeId,input.pickupStoreId,input.productId,input.customerId,input.quantity,ctx.userId,createdAt,expiresAt);this.audit(ctx,input.storeId,'RESERVATION_REQUESTED',reservationId,{pickupStoreId:input.pickupStoreId,productId:input.productId,quantity:input.quantity});return {id:reservationId,status:'REQUESTED',expiresAt};});
    }
    object(raw,['action','storeId','reservationId']);const input={action,storeId:id(raw.storeId),reservationId:id(raw.reservationId)};
    return this.mutate(ctx,`RESERVATION_${action}`,key,input,user=>{requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente confirma reservas.');const reservation=this.one('SELECT * FROM stock_reservations WHERE tenant_id=? AND id=?',ctx.tenantId,input.reservationId);requireThat(reservation,404,'RESERVATION_NOT_FOUND','Reserva não encontrada.');requireThat(input.storeId===reservation.pickup_store_id,403,'STORE_FORBIDDEN','A loja de retirada deve processar a reserva.');const timestamp=now();
      if(action==='CONFIRM'){requireThat(reservation.status==='REQUESTED',409,'RESERVATION_STATUS','Esta reserva não aguarda confirmação.');requireThat(new Date(reservation.expires_at)>new Date(),409,'RESERVATION_EXPIRED','O prazo desta reserva venceu.');const balance=this.one(`SELECT s.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=s.tenant_id AND r.pickup_store_id=s.store_id AND r.product_id=s.product_id AND r.status='CONFIRMED' AND r.expires_at>?),0) available FROM stock s WHERE s.tenant_id=? AND s.store_id=? AND s.product_id=?`,timestamp,ctx.tenantId,input.storeId,reservation.product_id);requireThat(balance&&balance.available>=reservation.quantity,409,'INSUFFICIENT_STOCK','Saldo disponível insuficiente para confirmar a reserva.');this.run("UPDATE stock_reservations SET status='CONFIRMED',confirmed_by=?,confirmed_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.reservationId);}
      else if(action==='COLLECT'){requireThat(reservation.status==='CONFIRMED',409,'RESERVATION_STATUS','A reserva precisa estar confirmada.');requireThat(new Date(reservation.expires_at)>new Date(),409,'RESERVATION_EXPIRED','O prazo desta reserva venceu.');const changed=this.run('UPDATE stock SET quantity=quantity-? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity>=?',reservation.quantity,ctx.tenantId,input.storeId,reservation.product_id,reservation.quantity);requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo físico insuficiente.');this.run("UPDATE stock_reservations SET status='COLLECTED',collected_by=?,collected_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.reservationId);this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,reservation.product_id,null,-reservation.quantity,'ADJUSTMENT',`Retirada da reserva ${reservation.id}`,ctx.userId,timestamp);}
      else if(action==='CANCEL'){requireThat(['REQUESTED','CONFIRMED'].includes(reservation.status),409,'RESERVATION_STATUS','Esta reserva não pode ser cancelada.');this.run("UPDATE stock_reservations SET status='CANCELED',canceled_by=?,canceled_at=? WHERE tenant_id=? AND id=?",ctx.userId,timestamp,ctx.tenantId,input.reservationId);}
      else throw new AppError(400,'INVALID_INPUT','Ação de reserva inválida.');const status=action==='CONFIRM'?'CONFIRMED':action==='COLLECT'?'COLLECTED':'CANCELED';this.audit(ctx,input.storeId,`RESERVATION_${status}`,input.reservationId,{status});return {id:input.reservationId,status};});
  }
  openCash(ctx,key,raw) {
    object(raw,['storeId','terminalId','openingCents']);
    const input={storeId:id(raw.storeId),terminalId:id(raw.terminalId),openingCents:integer(raw.openingCents,'Fundo inicial')};
    return this.mutate(ctx,'CASH_OPEN',key,input,() => {
      requireThat(this.one('SELECT 1 FROM terminals WHERE tenant_id=? AND store_id=? AND id=?',ctx.tenantId,input.storeId,input.terminalId),404,'TERMINAL_NOT_FOUND','Terminal não encontrado nesta loja.');
      requireThat(!this.one("SELECT 1 FROM cash_sessions WHERE tenant_id=? AND terminal_id=? AND status='OPEN'",ctx.tenantId,input.terminalId),409,'CASH_ALREADY_OPEN','Este terminal já tem um caixa aberto.');
      const cashId=randomUUID();
      this.run(`INSERT INTO cash_sessions(tenant_id,id,store_id,terminal_id,operator_id,status,opening_cents,opened_at)
        VALUES(?,?,?,?,?,'OPEN',?,?)`,ctx.tenantId,cashId,input.storeId,input.terminalId,ctx.userId,input.openingCents,now());
      this.run('INSERT INTO cash_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,cashId,null,'OPENING',input.openingCents,'Fundo inicial',ctx.userId,now());
      this.audit(ctx,input.storeId,'CASH_OPENED',cashId,{openingCents:input.openingCents});
      return this.cash(ctx,cashId);
    });
  }
  cash(ctx,cashId) {
    const cash=this.one('SELECT * FROM cash_sessions WHERE tenant_id=? AND id=?',ctx.tenantId,id(cashId));
    requireThat(cash,404,'CASH_NOT_FOUND','Caixa não encontrado.');
    this.authorize(ctx,cash.store_id);
    const sums=this.one(`SELECT COALESCE(SUM(amount_cents),0) expected,
      COALESCE(SUM(CASE WHEN kind='SALE' THEN amount_cents ELSE 0 END),0) sales
      FROM cash_movements WHERE tenant_id=? AND cash_session_id=?`,ctx.tenantId,cashId);
    const payments=this.one(`SELECT
      COALESCE(SUM(p.amount_cents),0) total,
      COALESCE(SUM(CASE WHEN p.method='CASH' THEN p.amount_cents ELSE 0 END),0) cash_total,
      COALESCE(SUM(CASE WHEN p.method='PIX' THEN p.amount_cents ELSE 0 END),0) pix_total,
      COALESCE(SUM(CASE WHEN p.method='CARD' THEN p.amount_cents ELSE 0 END),0) card_total
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=? AND s.cash_session_id=? AND x.sale_id IS NULL`,ctx.tenantId,cashId);
    return {...cash,expected_cents:sums.expected,sales_cents:sums.sales,
      total_sales_cents:payments.total,cash_sales_cents:payments.cash_total,pix_sales_cents:payments.pix_total,card_sales_cents:payments.card_total};
  }
  cashDetail(ctx,cashId) {
    const cash=this.cash(ctx,cashId);
    const terminal=this.one('SELECT name FROM terminals WHERE tenant_id=? AND id=?',ctx.tenantId,cash.terminal_id);
    const operator=this.one('SELECT name FROM users WHERE tenant_id=? AND id=?',ctx.tenantId,cash.operator_id);
    const movements=this.all(`SELECT m.kind,m.amount_cents,m.reason,m.created_at,u.name actor_name
      FROM cash_movements m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
      WHERE m.tenant_id=? AND m.cash_session_id=? ORDER BY m.created_at`,ctx.tenantId,cash.id);
    const sales=this.all(`SELECT s.id,s.created_at,s.total_cents,p.method,
        x.created_at canceled_at,COALESCE(SUM(r.total_cents),0) returned_cents
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=? AND s.cash_session_id=?
      GROUP BY s.id,s.created_at,s.total_cents,p.method,x.created_at
      ORDER BY s.created_at`,ctx.tenantId,cash.id);
    return {cash:{...cash,terminal_name:terminal?.name??cash.terminal_id,operator_name:operator?.name??cash.operator_id},movements,sales};
  }
  closeCash(ctx,key,raw) {
    object(raw,['storeId','cashSessionId','countedCents','reason']);
    const input={storeId:id(raw.storeId),cashSessionId:id(raw.cashSessionId),countedCents:integer(raw.countedCents,'Valor contado'),reason:raw.reason?text(raw.reason,'Motivo',200):null};
    return this.mutate(ctx,'CASH_CLOSE',key,input,() => {
      const cash=this.cash(ctx,input.cashSessionId);
      requireThat(cash.store_id===input.storeId,409,'CASH_STORE_MISMATCH','Caixa de outra loja.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','O fechamento deve ser feito pelo operador que abriu este caixa.');
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Este caixa já foi fechado.');
      const difference=input.countedCents-cash.expected_cents;
      requireThat(difference===0 || (input.reason?.length??0)>=3,400,'CLOSE_REASON_REQUIRED','Informe o motivo da diferença de caixa.');
      this.run("UPDATE cash_sessions SET status='CLOSED',counted_cents=?,expected_cents=?,difference_cents=?,close_reason=?,closed_at=? WHERE tenant_id=? AND id=?",
        input.countedCents,cash.expected_cents,difference,input.reason,now(),ctx.tenantId,input.cashSessionId);
      this.audit(ctx,input.storeId,'CASH_CLOSED',input.cashSessionId,{expectedCents:cash.expected_cents,countedCents:input.countedCents,differenceCents:difference,reason:input.reason});
      return this.cash(ctx,input.cashSessionId);
    });
  }
  moveCash(ctx,key,raw) {
    object(raw,['storeId','cashSessionId','kind','amountCents','reason']);
    const kind=text(raw.kind,'Tipo de movimento',20).toUpperCase();
    requireThat(CASH_ADJUSTMENTS.has(kind),400,'INVALID_CASH_MOVEMENT','Tipo de movimento de caixa inválido.');
    const input={storeId:id(raw.storeId),cashSessionId:id(raw.cashSessionId),kind,
      amountCents:integer(raw.amountCents,'Valor',1),reason:text(raw.reason,'Motivo',200,3)};
    return this.mutate(ctx,'CASH_MOVE',key,input,() => {
      const cash=this.cash(ctx,input.cashSessionId);
      requireThat(cash.store_id===input.storeId,409,'CASH_STORE_MISMATCH','Caixa de outra loja.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Este caixa já foi fechado.');
      const signed=input.kind==='WITHDRAWAL'?-input.amountCents:input.amountCents;
      const expected=cash.expected_cents+signed;
      requireThat(expected>=0,409,'CASH_NEGATIVE','Sangria maior que o dinheiro esperado no caixa.');
      requireThat(expected<=MAX_MONEY,409,'CASH_LIMIT','Limite monetario do caixa atingido neste laboratorio.');
      const movementId=randomUUID();
      this.run('INSERT INTO cash_movements VALUES(?,?,?,?,?,?,?,?,?,?)',
        ctx.tenantId,movementId,input.storeId,input.cashSessionId,null,input.kind,signed,input.reason,ctx.userId,now());
      this.audit(ctx,input.storeId,input.kind==='WITHDRAWAL'?'CASH_WITHDRAWAL':'CASH_SUPPLY',movementId,{amountCents:input.amountCents,reason:input.reason});
      return this.cash(ctx,input.cashSessionId);
    });
  }
  sell(ctx,key,raw) {
    const body={customerId:null,...raw};
    object(body,['storeId','cashSessionId','items','discountCents','discountReason','tenderedCents','paymentMethod','customerId']);
    requireThat(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=100,400,'INVALID_ITEMS','Informe entre 1 e 100 produtos.');
    const items=body.items.map(item => {
      object(item,['productId','quantity']);
      return {productId:id(item.productId),quantity:integer(item.quantity,'Quantidade',1,10_000)};
    }).sort((a,b)=>a.productId.localeCompare(b.productId));
    requireThat(new Set(items.map(i=>i.productId)).size===items.length,400,'DUPLICATE_ITEM','Agrupe a quantidade do mesmo produto em uma única linha.');
    const paymentMethod=text(body.paymentMethod??'CASH','Forma de pagamento',20).toUpperCase();
    requireThat(PAYMENT_METHODS.has(paymentMethod),400,'INVALID_PAYMENT_METHOD','Forma de pagamento invalida.');
    const input={storeId:id(body.storeId),cashSessionId:id(body.cashSessionId),items,paymentMethod,
      customerId:body.customerId?id(body.customerId):null,
      discountCents:integer(body.discountCents??0,'Desconto'),discountReason:body.discountReason?text(body.discountReason,'Motivo',200):null,
      tenderedCents:paymentMethod==='CASH'?integer(body.tenderedCents,'Valor entregue',1):0};
    return this.mutate(ctx,'SALE',key,input,user => {
      const cash=this.cash(ctx,input.cashSessionId);
      requireThat(cash.store_id===input.storeId,409,'CASH_STORE_MISMATCH','Caixa de outra loja.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Abra o caixa antes de vender.');
      if(input.customerId) requireThat(this.one('SELECT 1 FROM customers WHERE tenant_id=? AND store_id=? AND id=? AND active=1',
        ctx.tenantId,input.storeId,input.customerId),404,'CUSTOMER_NOT_FOUND','Cliente não encontrado nesta loja.');
      const lines=input.items.map(item => {
        const product=this.one(`SELECT p.*,s.quantity stock_quantity FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
          WHERE p.tenant_id=? AND s.store_id=? AND p.id=? AND p.active=1`,ctx.tenantId,input.storeId,item.productId);
        requireThat(product,404,'PRODUCT_NOT_FOUND','Produto não disponível nesta loja.');
        const reserved=this.one("SELECT COALESCE(SUM(quantity),0) quantity FROM stock_reservations WHERE tenant_id=? AND pickup_store_id=? AND product_id=? AND status='CONFIRMED' AND expires_at>?",ctx.tenantId,input.storeId,item.productId,now()).quantity;
        requireThat(product.stock_quantity-reserved>=item.quantity,409,'INSUFFICIENT_STOCK',`Estoque disponivel insuficiente: ${product.name}.`);
        return {...item,sku:product.sku,name:product.name,priceCents:product.price_cents,lineCents:integer(product.price_cents*item.quantity,'Total do item',1)};
      });
      const subtotal=integer(lines.reduce((n,l)=>n+l.lineCents,0),'Subtotal',1);
      if(input.discountCents>0) {
        requireThat(user.role==='MANAGER',403,'DISCOUNT_FORBIDDEN','Este operador não tem permissão para desconto.');
        requireThat((input.discountReason?.length??0)>=3,400,'DISCOUNT_REASON_REQUIRED','Informe o motivo do desconto.');
        requireThat(input.discountCents*100<=subtotal*20,400,'DISCOUNT_LIMIT','Limite de desconto neste laboratório: 20%.');
      }
      const total=subtotal-input.discountCents;
      const tenderedCents=input.paymentMethod==='CASH'?input.tenderedCents:total;
      const changeCents=input.paymentMethod==='CASH'?input.tenderedCents-total:0;
      requireThat(total>0&&(input.paymentMethod!=='CASH'||input.tenderedCents>=total),400,'INSUFFICIENT_CASH','Valor entregue menor que o total da venda.');
      requireThat(input.paymentMethod!=='CASH'||cash.expected_cents+total<=MAX_MONEY,409,'CASH_LIMIT','Limite monetario do caixa atingido neste laboratorio.');
      const saleId=randomUUID();
      this.run(`INSERT INTO sales(tenant_id,id,store_id,cash_session_id,operator_id,customer_id,subtotal_cents,discount_cents,discount_reason,discount_author_id,total_cents,status,fiscal_status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'CONFIRMED','TEST_NOT_ISSUED',?)`,ctx.tenantId,saleId,input.storeId,input.cashSessionId,ctx.userId,input.customerId,
        subtotal,input.discountCents,input.discountCents>0?input.discountReason:null,input.discountCents>0?ctx.userId:null,total,now());
      for (const line of lines) {
        // BEGIN IMMEDIATE serializa escritores. A condição de saldo é uma defesa adicional.
        const changed=this.run(`UPDATE stock SET quantity=quantity-? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity-(SELECT COALESCE(SUM(r.quantity),0) FROM stock_reservations r WHERE r.tenant_id=stock.tenant_id AND r.pickup_store_id=stock.store_id AND r.product_id=stock.product_id AND r.status='CONFIRMED' AND r.expires_at>?)>=?`,
          line.quantity,ctx.tenantId,input.storeId,line.productId,now(),line.quantity);
        requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo mudou. Consulte o estoque.');
        this.run('INSERT INTO sale_items VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,saleId,line.productId,line.sku,line.name,line.quantity,line.priceCents,line.lineCents);
        this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,line.productId,saleId,-line.quantity,'SALE','Venda confirmada de teste',ctx.userId,now());
      }
      this.run("INSERT INTO payments VALUES(?,?,?,'CONFIRMED',?,?,?)",ctx.tenantId,saleId,input.paymentMethod,total,tenderedCents,changeCents);
      if(input.paymentMethod==='CASH') this.run("INSERT INTO cash_movements VALUES(?,?,?,?,?,'SALE',?,?,?,?)",ctx.tenantId,randomUUID(),input.storeId,input.cashSessionId,saleId,total,'Venda em dinheiro',ctx.userId,now());
      this.audit(ctx,input.storeId,'SALE_CONFIRMED',saleId,{totalCents:total,paymentMethod:input.paymentMethod,discountCents:input.discountCents,discountReason:input.discountReason,hasCustomer:Boolean(input.customerId)});
      return this.receipt(ctx,saleId);
    });
  }
  cancelSale(ctx,key,raw) {
    object(raw,['storeId','saleId','reason']);
    const input={storeId:id(raw.storeId),saleId:id(raw.saleId),reason:text(raw.reason,'Motivo',200,3)};
    return this.mutate(ctx,'SALE_CANCEL',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente cancela venda confirmada.');
      const sale=this.one(`SELECT s.*,p.method,p.amount_cents FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
        WHERE s.tenant_id=? AND s.store_id=? AND s.id=?`,ctx.tenantId,input.storeId,input.saleId);
      requireThat(sale,404,'SALE_NOT_FOUND','Venda não encontrada nesta loja.');
      requireThat(!this.one('SELECT 1 FROM sale_cancellations WHERE tenant_id=? AND sale_id=?',ctx.tenantId,input.saleId),409,'SALE_ALREADY_CANCELED','Venda já cancelada.');
      const cash=this.cash(ctx,sale.cash_session_id);
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Abra o caixa da venda antes de cancelar.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','O cancelamento deve ser feito pelo operador do caixa aberto.');
      for(const item of this.all('SELECT product_id,quantity FROM sale_items WHERE tenant_id=? AND sale_id=? ORDER BY product_id',ctx.tenantId,input.saleId)) {
        const changed=this.run(`UPDATE stock SET quantity=quantity+? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity+? BETWEEN 0 AND 1000000`,
          item.quantity,ctx.tenantId,input.storeId,item.product_id,item.quantity);
        requireThat(changed.changes===1,409,'STOCK_LIMIT','Cancelamento deixaria o estoque fora do limite permitido.');
        this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,item.product_id,null,item.quantity,'ADJUSTMENT',`Cancelamento de venda: ${input.reason}`,ctx.userId,now());
      }
      if(sale.method==='CASH') {
        requireThat(cash.expected_cents-sale.amount_cents>=0,409,'CASH_NEGATIVE','Dinheiro esperado insuficiente para estornar esta venda.');
        this.run('INSERT INTO cash_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,sale.cash_session_id,null,'WITHDRAWAL',-sale.amount_cents,`Cancelamento de venda: ${input.reason}`,ctx.userId,now());
      }
      this.run('INSERT INTO sale_cancellations VALUES(?,?,?,?,?,?,?)',ctx.tenantId,input.saleId,input.storeId,sale.cash_session_id,input.reason,ctx.userId,now());
      this.audit(ctx,input.storeId,'SALE_CANCELED',input.saleId,{reason:input.reason,paymentMethod:sale.method,totalCents:sale.total_cents});
      return this.receipt(ctx,input.saleId);
    });
  }
  returnSale(ctx,key,raw) {
    const input=saleReturnInput(raw);
    return this.mutate(ctx,'SALE_RETURN',key,input,user => {
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente registra devolução.');
      const sale=this.one(`SELECT s.*,p.method,p.amount_cents FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
        WHERE s.tenant_id=? AND s.store_id=? AND s.id=?`,ctx.tenantId,input.storeId,input.saleId);
      requireThat(sale,404,'SALE_NOT_FOUND','Venda não encontrada nesta loja.');
      requireThat(!this.one('SELECT 1 FROM sale_cancellations WHERE tenant_id=? AND sale_id=?',ctx.tenantId,input.saleId),409,'SALE_CANCELED','Venda cancelada não aceita devolução.');
      const cash=this.cash(ctx,sale.cash_session_id);
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Abra o caixa da venda antes de registrar devolução.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','A devolução deve ser feita pelo operador do caixa aberto.');
      const saleItems=new Map(this.all(`SELECT i.*,COALESCE(SUM(r.quantity),0) returned_quantity
        FROM sale_items i
        LEFT JOIN sale_return_items r ON r.tenant_id=i.tenant_id AND r.sale_id=i.sale_id AND r.product_id=i.product_id
        WHERE i.tenant_id=? AND i.sale_id=?
        GROUP BY i.tenant_id,i.sale_id,i.product_id,i.sku_snapshot,i.name_snapshot,i.quantity,i.price_cents,i.line_cents`,ctx.tenantId,input.saleId)
        .map(row=>[row.product_id,row]));
      const lines=input.items.map(item => {
        const original=saleItems.get(item.productId);
        requireThat(original,404,'SALE_ITEM_NOT_FOUND','Produto não pertence a esta venda.');
        const available=original.quantity-original.returned_quantity;
        requireThat(item.quantity<=available,409,'RETURN_QUANTITY_EXCEEDED','Quantidade maior que o saldo disponível para devolução.');
        const lineCents=original.price_cents*item.quantity;
        return {...item,sku:original.sku_snapshot,name:original.name_snapshot,priceCents:original.price_cents,amountCents:proratedReturnCents(sale,lineCents)};
      });
      const previousTotal=this.one('SELECT COALESCE(SUM(total_cents),0) total FROM sale_returns WHERE tenant_id=? AND sale_id=?',ctx.tenantId,input.saleId).total;
      let total=lines.reduce((sum,line)=>sum+line.amountCents,0);
      const returningAll=input.items.every(item => item.quantity===saleItems.get(item.productId).quantity-saleItems.get(item.productId).returned_quantity)
        && [...saleItems.values()].every(item => input.items.some(line=>line.productId===item.product_id) || item.quantity===item.returned_quantity);
      if(returningAll) total=sale.total_cents-previousTotal;
      requireThat(total>0&&previousTotal+total<=sale.total_cents,409,'RETURN_TOTAL_EXCEEDED','Valor de devolução maior que o saldo da venda.');
      if(sale.method==='CASH') requireThat(cash.expected_cents-total>=0,409,'CASH_NEGATIVE','Dinheiro esperado insuficiente para esta devolução.');
      const returnId=randomUUID(),createdAt=now();
      this.run(`INSERT INTO sale_returns(tenant_id,id,store_id,sale_id,cash_session_id,actor_id,payment_method,total_cents,reason,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,ctx.tenantId,returnId,input.storeId,input.saleId,sale.cash_session_id,ctx.userId,sale.method,total,input.reason,createdAt);
      for(const line of lines) {
        const changed=this.run(`UPDATE stock SET quantity=quantity+? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity+? BETWEEN 0 AND 1000000`,
          line.quantity,ctx.tenantId,input.storeId,line.productId,line.quantity);
        requireThat(changed.changes===1,409,'STOCK_LIMIT','Devolução deixaria o estoque fora do limite permitido.');
        this.run('INSERT INTO sale_return_items VALUES(?,?,?,?,?,?)',ctx.tenantId,returnId,input.saleId,line.productId,line.quantity,line.amountCents);
        this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,line.productId,null,line.quantity,'ADJUSTMENT',`Devolução de venda: ${input.reason}`,ctx.userId,createdAt);
      }
      if(sale.method==='CASH') this.run('INSERT INTO cash_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,sale.cash_session_id,null,'WITHDRAWAL',-total,`Devolução de venda: ${input.reason}`,ctx.userId,createdAt);
      this.audit(ctx,input.storeId,'SALE_RETURNED',returnId,{saleId:input.saleId,totalCents:total,paymentMethod:sale.method,reason:input.reason});
      return this.receipt(ctx,input.saleId);
    });
  }
  receipt(ctx,saleId) {
    const sale=this.one('SELECT * FROM sales WHERE tenant_id=? AND id=?',ctx.tenantId,id(saleId));
    requireThat(sale,404,'SALE_NOT_FOUND','Venda não encontrada.');
    this.authorize(ctx,sale.store_id);
    return {...sale,
      cancellation:this.one(`SELECT reason,created_at,u.name actor_name FROM sale_cancellations c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.actor_id
        WHERE c.tenant_id=? AND c.sale_id=?`,ctx.tenantId,saleId),
      returns:this.all(`SELECT r.id,r.total_cents,r.reason,r.payment_method,r.created_at,u.name actor_name
        FROM sale_returns r JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.actor_id
        WHERE r.tenant_id=? AND r.sale_id=? ORDER BY r.created_at`,ctx.tenantId,saleId),
      return_items:this.all(`SELECT i.return_id,i.product_id,i.quantity,i.amount_cents,p.name_snapshot
        FROM sale_return_items i JOIN sale_items p ON p.tenant_id=i.tenant_id AND p.sale_id=i.sale_id AND p.product_id=i.product_id
        WHERE i.tenant_id=? AND i.sale_id=? ORDER BY p.sku_snapshot`,ctx.tenantId,saleId),
      store_name:this.one('SELECT name FROM stores WHERE tenant_id=? AND id=?',ctx.tenantId,sale.store_id).name,
      operator_name:this.one('SELECT name FROM users WHERE tenant_id=? AND id=?',ctx.tenantId,sale.operator_id).name,
      items:this.all('SELECT product_id,sku_snapshot,name_snapshot,quantity,price_cents,line_cents FROM sale_items WHERE tenant_id=? AND sale_id=? ORDER BY sku_snapshot',ctx.tenantId,saleId),
      payment:this.one('SELECT method,status,amount_cents,tendered_cents,change_cents FROM payments WHERE tenant_id=? AND sale_id=?',ctx.tenantId,saleId)};
  }
  report(ctx,storeId,from,to) {
    id(storeId);this.authorize(ctx,storeId);const range=reportRange(from,to);
    const sales=this.all(`SELECT s.id,s.created_at,s.customer_id,s.total_cents,s.discount_cents,p.method,u.name operator_name,t.name terminal_name,
        x.created_at canceled_at,x.reason cancel_reason,COALESCE(SUM(r.total_cents),0) returned_cents
      FROM sales s
      JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
      JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
      JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=? AND s.store_id=? AND s.created_at>=? AND s.created_at<?
      GROUP BY s.id,s.created_at,s.customer_id,s.total_cents,s.discount_cents,p.method,u.name,t.name,x.created_at,x.reason
      ORDER BY s.created_at`,ctx.tenantId,storeId,range.start,range.end);
    const active=sales.filter(s=>!s.canceled_at);
    const summary={
      sale_count:sales.length,active_sale_count:active.length,canceled_sale_count:sales.length-active.length,
      gross_cents:active.reduce((n,s)=>n+s.total_cents-s.returned_cents,0),
      discount_cents:active.reduce((n,s)=>n+s.discount_cents,0),
      canceled_cents:sales.filter(s=>s.canceled_at).reduce((n,s)=>n+s.total_cents,0),
      returned_cents:active.reduce((n,s)=>n+s.returned_cents,0)
    };
    const payments=this.all(`SELECT p.method,COUNT(*) sale_count,COALESCE(SUM(p.amount_cents-COALESCE(r.returned_cents,0)),0) amount_cents
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN (SELECT tenant_id,sale_id,SUM(total_cents) returned_cents FROM sale_returns GROUP BY tenant_id,sale_id) r
        ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=? AND s.store_id=? AND s.created_at>=? AND s.created_at<? AND x.sale_id IS NULL
      GROUP BY p.method ORDER BY p.method`,ctx.tenantId,storeId,range.start,range.end);
    const products=this.all(`SELECT i.product_id,i.sku_snapshot sku,i.name_snapshot name,COALESCE(SUM(i.quantity-COALESCE(r.quantity,0)),0) quantity,
        COALESCE(SUM(i.line_cents-COALESCE(r.amount_cents,0)),0) total_cents
      FROM sales s JOIN sale_items i ON i.tenant_id=s.tenant_id AND i.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN (SELECT tenant_id,sale_id,product_id,SUM(quantity) quantity,SUM(amount_cents) amount_cents
        FROM sale_return_items GROUP BY tenant_id,sale_id,product_id) r
        ON r.tenant_id=i.tenant_id AND r.sale_id=i.sale_id AND r.product_id=i.product_id
      WHERE s.tenant_id=? AND s.store_id=? AND s.created_at>=? AND s.created_at<? AND x.sale_id IS NULL
      GROUP BY i.product_id,i.sku_snapshot,i.name_snapshot HAVING COALESCE(SUM(i.quantity-COALESCE(r.quantity,0)),0)>0
      ORDER BY total_cents DESC,name LIMIT 50`,ctx.tenantId,storeId,range.start,range.end);
    const operators=this.all(`SELECT u.name operator_name,COUNT(*) sale_count,COALESCE(SUM(s.total_cents),0) total_cents
      FROM sales s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=? AND s.store_id=? AND s.created_at>=? AND s.created_at<? AND x.sale_id IS NULL
      GROUP BY u.name ORDER BY total_cents DESC,u.name`,ctx.tenantId,storeId,range.start,range.end);
    const cashClosures=this.all(`SELECT c.closed_at,t.name terminal_name,c.expected_cents,c.counted_cents,c.difference_cents,c.close_reason
      FROM cash_sessions c JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      WHERE c.tenant_id=? AND c.store_id=? AND c.status='CLOSED' AND c.closed_at>=? AND c.closed_at<?
      ORDER BY c.closed_at`,ctx.tenantId,storeId,range.start,range.end);
    return {range,summary,payments,products,operators,cashClosures,sales};
  }
  networkOverview(ctx,from,to) {
    const me=this.me(ctx);
    // A rede mostra só as lojas em que a pessoa é gerente.
    me.stores=me.stores.filter(store=>store.role==='MANAGER');
    requireThat(me.stores.length>0,403,'MANAGER_REQUIRED','Somente gerente acompanha a rede de lojas.');
    const sales=[];
    const stores=me.stores.map(store=>{
      const report=this.report(ctx,store.id,from,to);
      sales.push(...report.sales);
      const open_cash_count=this.one("SELECT COUNT(*) count FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='OPEN'",ctx.tenantId,store.id).count;
      const last_sale_at=this.one('SELECT MAX(created_at) value FROM sales WHERE tenant_id=? AND store_id=? AND created_at>=? AND created_at<?',ctx.tenantId,store.id,report.range.start,report.range.end).value;
      return {...store,...report.summary,open_cash_count,last_sale_at,payments:report.payments,hourly:hourlySales(report.sales)};
    });
    const payments=new Map();
    for(const store of stores)for(const payment of store.payments){
      const current=payments.get(payment.method)??{method:payment.method,sale_count:0,amount_cents:0};
      current.sale_count+=Number(payment.sale_count);current.amount_cents+=Number(payment.amount_cents);payments.set(payment.method,current);
    }
    const totals=stores.reduce((sum,store)=>({
      sale_count:sum.sale_count+store.sale_count,active_sale_count:sum.active_sale_count+store.active_sale_count,
      canceled_sale_count:sum.canceled_sale_count+store.canceled_sale_count,gross_cents:sum.gross_cents+store.gross_cents,
      discount_cents:sum.discount_cents+store.discount_cents,returned_cents:sum.returned_cents+store.returned_cents,
      open_cash_count:sum.open_cash_count+store.open_cash_count
    }),{sale_count:0,active_sale_count:0,canceled_sale_count:0,gross_cents:0,discount_cents:0,returned_cents:0,open_cash_count:0});
    return {generated_at:now(),range:reportRange(from,to),totals:{...totals,ticket_average_cents:totals.active_sale_count?Math.round(totals.gross_cents/totals.active_sale_count):0},payments:[...payments.values()],hourly:hourlySales(sales),stores};
  }
  stockLookup(ctx,query='') {
    this.user(ctx);
    const term=String(query??'').trim().slice(0,120),pattern=`%${term.replaceAll('%','\\%').replaceAll('_','\\_')}%`;
    const rows=this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.id store_id,s.name store_name,st.quantity, COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved_quantity, st.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) available_quantity
      FROM products p JOIN stock st ON st.tenant_id=p.tenant_id AND st.product_id=p.id
      JOIN stores s ON s.tenant_id=st.tenant_id AND s.id=st.store_id
      WHERE p.tenant_id=? AND p.active=1 AND s.active=1
        AND (?='' OR p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR COALESCE(p.barcode,'') LIKE ? ESCAPE '\\')
      ORDER BY p.name,s.name LIMIT 250`,ctx.tenantId,term,pattern,pattern,pattern);
    const products=new Map();
    for(const row of rows){const reserved_quantity=Number(row.reserved_quantity),available_quantity=row.quantity-reserved_quantity;const product=products.get(row.id)??{id:row.id,sku:row.sku,barcode:row.barcode,name:row.name,price_cents:row.price_cents,total_quantity:0,total_available_quantity:0,stores:[]};product.total_quantity+=row.quantity;product.total_available_quantity+=available_quantity;product.stores.push({id:row.store_id,name:row.store_name,quantity:row.quantity,reserved_quantity,available_quantity});products.set(row.id,product);}
    return {query:term,products:[...products.values()]};
  }
  networkOperations(ctx,from,to) {
    const me=this.me(ctx),stores=me.stores.filter(store=>store.role==='MANAGER');
    requireThat(stores.length>0,403,'MANAGER_REQUIRED','Somente gerente acompanha a operação da rede.');
    const range=reportRange(from,to),access=`JOIN memberships access ON access.tenant_id=? AND access.user_id=? AND access.store_id=s.id AND access.active=1 AND access.role='MANAGER'`;
    const stock=this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.id store_id,s.name store_name,st.quantity, COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved_quantity, st.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) available_quantity
      FROM stores s ${access} JOIN stock st ON st.tenant_id=s.tenant_id AND st.store_id=s.id
      JOIN products p ON p.tenant_id=st.tenant_id AND p.id=st.product_id
      WHERE s.tenant_id=? AND s.active=1 AND p.active=1 ORDER BY p.name,s.name`,ctx.tenantId,ctx.userId,ctx.tenantId);
    const movements=this.all(`SELECT m.id,m.created_at,m.kind,m.quantity,m.reason,p.sku,p.name,s.id store_id,s.name store_name,u.name actor_name
      FROM stores s ${access} JOIN stock_movements m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
      JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
      WHERE s.tenant_id=? AND m.created_at>=? AND m.created_at<? ORDER BY m.created_at DESC LIMIT 300`,ctx.tenantId,ctx.userId,ctx.tenantId,range.start,range.end);
    const sales=this.all(`SELECT sale.id,sale.created_at,sale.total_cents,sale.discount_cents,s.id store_id,s.name store_name,u.name operator_name,pay.method,x.created_at canceled_at,COALESCE(SUM(ret.total_cents),0) returned_cents
      FROM stores s ${access} JOIN sales sale ON sale.tenant_id=s.tenant_id AND sale.store_id=s.id
      JOIN users u ON u.tenant_id=sale.tenant_id AND u.id=sale.operator_id JOIN payments pay ON pay.tenant_id=sale.tenant_id AND pay.sale_id=sale.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=sale.tenant_id AND x.sale_id=sale.id LEFT JOIN sale_returns ret ON ret.tenant_id=sale.tenant_id AND ret.sale_id=sale.id
      WHERE s.tenant_id=? AND sale.created_at>=? AND sale.created_at<?
      GROUP BY sale.id,sale.created_at,sale.total_cents,sale.discount_cents,s.id,s.name,u.name,pay.method,x.created_at ORDER BY sale.created_at DESC LIMIT 300`,ctx.tenantId,ctx.userId,ctx.tenantId,range.start,range.end);
    const closures=this.all(`SELECT c.id,c.closed_at,c.expected_cents,c.counted_cents,c.difference_cents,c.close_reason,s.id store_id,s.name store_name,t.name terminal_name,u.name operator_name
      FROM stores s ${access} JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.store_id=s.id
      JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.operator_id
      WHERE s.tenant_id=? AND c.status='CLOSED' AND c.closed_at>=? AND c.closed_at<? ORDER BY c.closed_at DESC LIMIT 300`,ctx.tenantId,ctx.userId,ctx.tenantId,range.start,range.end);
    const transfers=this.all(`SELECT x.*,p.sku,p.name product_name,o.name origin_name,d.name destination_name,u.name requested_by_name
      FROM stock_transfers x JOIN products p ON p.tenant_id=x.tenant_id AND p.id=x.product_id
      JOIN stores o ON o.tenant_id=x.tenant_id AND o.id=x.origin_store_id JOIN stores d ON d.tenant_id=x.tenant_id AND d.id=x.destination_store_id
      JOIN users u ON u.tenant_id=x.tenant_id AND u.id=x.requested_by
      WHERE x.tenant_id=? AND (x.created_at>=? AND x.created_at<? OR x.status IN('REQUESTED','APPROVED','IN_TRANSIT'))
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=x.tenant_id AND m.user_id=? AND m.active=1 AND m.role='MANAGER' AND m.store_id IN(x.origin_store_id,x.destination_store_id))
      ORDER BY CASE x.status WHEN 'IN_TRANSIT' THEN 1 WHEN 'REQUESTED' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END,x.created_at DESC LIMIT 300`,ctx.tenantId,range.start,range.end,ctx.userId);
    const reservations=this.all(`SELECT r.*,p.sku,p.name product_name,requesting.name requesting_store_name,pickup.name pickup_store_name,u.name requested_by_name,c.name_enc customer_name_enc
      FROM stock_reservations r JOIN products p ON p.tenant_id=r.tenant_id AND p.id=r.product_id
      JOIN stores requesting ON requesting.tenant_id=r.tenant_id AND requesting.id=r.requesting_store_id
      JOIN stores pickup ON pickup.tenant_id=r.tenant_id AND pickup.id=r.pickup_store_id
      JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.requested_by JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
      WHERE r.tenant_id=? AND (r.created_at>=? AND r.created_at<? OR r.status IN('REQUESTED','CONFIRMED'))
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=r.tenant_id AND m.user_id=? AND m.active=1 AND m.role='MANAGER' AND m.store_id IN(r.requesting_store_id,r.pickup_store_id))
      ORDER BY CASE r.status WHEN 'REQUESTED' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3 END,r.created_at DESC LIMIT 300`,ctx.tenantId,range.start,range.end,ctx.userId)
      .map(row=>({...row,customer_name:decryptField(row.customer_name_enc),customer_name_enc:undefined}));
    return {range,stores,stock,movements,sales,closures,transfers,reservations};
  }
  state(ctx,storeId) {
    id(storeId);
    const storeUser=this.authorize(ctx,storeId);
    const open=this.all("SELECT id FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='OPEN' ORDER BY terminal_id",ctx.tenantId,storeId);
    return {
      products:this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.quantity, COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=s.tenant_id AND r.pickup_store_id=s.store_id AND r.product_id=s.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved_quantity, s.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=s.tenant_id AND r.pickup_store_id=s.store_id AND r.product_id=s.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) available_quantity FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE s.tenant_id=? AND s.store_id=? AND p.active=1 ORDER BY p.name`,ctx.tenantId,storeId),
      terminals:this.all('SELECT id,name FROM terminals WHERE tenant_id=? AND store_id=? ORDER BY id',ctx.tenantId,storeId),
      users:storeUser.role==='MANAGER'?this.all(`SELECT u.id,u.email,u.name,m.role,u.company_admin,m.active,
          (SELECT COUNT(*) FROM memberships o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.store_id<>m.store_id AND o.active=1) other_stores,
          (SELECT COUNT(*) FROM memberships o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.store_id<>m.store_id AND o.active=1
            AND NOT EXISTS(SELECT 1 FROM memberships e WHERE e.tenant_id=o.tenant_id AND e.user_id=? AND e.store_id=o.store_id AND e.active=1 AND e.role='MANAGER')) locked_stores
        FROM users u JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE u.tenant_id=? AND m.store_id=? ORDER BY m.active DESC,u.name`,ctx.userId,ctx.tenantId,storeId):[],
      customers:this.all('SELECT * FROM customers WHERE tenant_id=? AND store_id=? ORDER BY updated_at DESC LIMIT 100',ctx.tenantId,storeId).map(row=>customerSummary(this.customerRow(row))),
      cash:open.map(c=>this.cash(ctx,c.id)),
      cashMovements:this.all(`SELECT m.id,m.cash_session_id,m.kind,m.amount_cents,m.reason,m.created_at,u.name actor_name
        FROM cash_movements m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
        WHERE m.tenant_id=? AND m.store_id=? ORDER BY m.created_at DESC LIMIT 50`,ctx.tenantId,storeId),
      sales:this.all(`SELECT s.id,s.customer_id,s.total_cents,s.discount_cents,s.created_at,u.name operator_name,c.terminal_id,t.name terminal_name,
          x.created_at canceled_at,x.reason cancel_reason,COALESCE(SUM(r.total_cents),0) returned_cents
        FROM sales s
        JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
        JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
        JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
        LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
        LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
        WHERE s.tenant_id=? AND s.store_id=?
        GROUP BY s.id,s.customer_id,s.total_cents,s.discount_cents,s.created_at,u.name,c.terminal_id,t.name,x.created_at,x.reason
        ORDER BY s.created_at DESC LIMIT 30`,ctx.tenantId,storeId),
      stockMovements:this.all(`SELECT m.product_id,p.name,m.kind,m.quantity,m.reason,m.created_at FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
        WHERE m.tenant_id=? AND m.store_id=? ORDER BY m.created_at DESC LIMIT 50`,ctx.tenantId,storeId),
      cashHistory:this.all("SELECT id,terminal_id,expected_cents,counted_cents,difference_cents,closed_at FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='CLOSED' ORDER BY closed_at DESC LIMIT 20",ctx.tenantId,storeId)
    };
  }
}
