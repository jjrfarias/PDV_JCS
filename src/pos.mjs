import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { hashPassword, sha256 } from './security.mjs';
import { requireThat, object, text, integer, id, operationKey } from './errors.mjs';
import { PostgresPos } from './postgres-pos.mjs';

const now = () => new Date().toISOString();
const PAYMENT_METHODS = new Set(['CASH','PIX','CARD']);
const CASH_ADJUSTMENTS = new Set(['SUPPLY','WITHDRAWAL']);
const MAX_MONEY = 100_000_000; // R$ 1 milhão por entrada monetária neste laboratório.

export class Pos {
  constructor(db, hooks = {}) {
    if (typeof db.query === 'function' && typeof db.connect === 'function') return new PostgresPos(db, hooks);
    this.db = db; this.hooks = hooks;
  }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  user(ctx) {
    const user = this.one('SELECT id,name,email,role FROM users WHERE tenant_id=? AND id=? AND active=1',ctx.tenantId,ctx.userId);
    requireThat(user,401,'AUTH_REQUIRED','Faça login novamente.');
    return user;
  }
  authorize(ctx, storeId) {
    const user = this.user(ctx);
    requireThat(this.one('SELECT 1 FROM memberships WHERE tenant_id=? AND user_id=? AND store_id=?',ctx.tenantId,ctx.userId,storeId),403,'STORE_FORBIDDEN','Você não tem acesso a esta loja.');
    return user;
  }
  me(ctx) {
    return { user:this.user(ctx), tenantId:ctx.tenantId,
      stores:this.all(`SELECT s.id,s.name FROM stores s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
        WHERE m.tenant_id=? AND m.user_id=? ORDER BY s.name`,ctx.tenantId,ctx.userId) };
  }
  audit(ctx, storeId, action, entityId, details) {
    this.run('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),ctx.userId,storeId,action,entityId,JSON.stringify(details),now());
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
      requireThat(!this.one('SELECT 1 FROM users WHERE tenant_id=? AND email=?',ctx.tenantId,input.email),409,'DUPLICATE_USER','E-mail já cadastrado.');
      const userId=randomUUID();
      this.run('INSERT INTO users(tenant_id,id,email,name,password_hash,role,active) VALUES(?,?,?,?,?,?,1)',
        ctx.tenantId,userId,input.email,input.name,hashPassword(input.temporaryPassword),input.role);
      this.run('INSERT INTO memberships VALUES(?,?,?)',ctx.tenantId,userId,input.storeId);
      this.audit(ctx,input.storeId,'USER_CREATED',userId,{email:input.email,role:input.role});
      return {id:userId,email:input.email,name:input.name,role:input.role,active:1,storeId:input.storeId};
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
    object(raw,['storeId','cashSessionId','items','discountCents','discountReason','tenderedCents','paymentMethod']);
    requireThat(Array.isArray(raw.items)&&raw.items.length>0&&raw.items.length<=100,400,'INVALID_ITEMS','Informe entre 1 e 100 produtos.');
    const items=raw.items.map(item => {
      object(item,['productId','quantity']);
      return {productId:id(item.productId),quantity:integer(item.quantity,'Quantidade',1,10_000)};
    }).sort((a,b)=>a.productId.localeCompare(b.productId));
    requireThat(new Set(items.map(i=>i.productId)).size===items.length,400,'DUPLICATE_ITEM','Agrupe a quantidade do mesmo produto em uma única linha.');
    const paymentMethod=text(raw.paymentMethod??'CASH','Forma de pagamento',20).toUpperCase();
    requireThat(PAYMENT_METHODS.has(paymentMethod),400,'INVALID_PAYMENT_METHOD','Forma de pagamento invalida.');
    const input={storeId:id(raw.storeId),cashSessionId:id(raw.cashSessionId),items,paymentMethod,
      discountCents:integer(raw.discountCents??0,'Desconto'),discountReason:raw.discountReason?text(raw.discountReason,'Motivo',200):null,
      tenderedCents:paymentMethod==='CASH'?integer(raw.tenderedCents,'Valor entregue',1):0};
    return this.mutate(ctx,'SALE',key,input,user => {
      const cash=this.cash(ctx,input.cashSessionId);
      requireThat(cash.store_id===input.storeId,409,'CASH_STORE_MISMATCH','Caixa de outra loja.');
      requireThat(cash.operator_id===ctx.userId,403,'CASH_OWNER_REQUIRED','Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status==='OPEN',409,'CASH_CLOSED','Abra o caixa antes de vender.');
      const lines=input.items.map(item => {
        const product=this.one(`SELECT p.*,s.quantity stock_quantity FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
          WHERE p.tenant_id=? AND s.store_id=? AND p.id=? AND p.active=1`,ctx.tenantId,input.storeId,item.productId);
        requireThat(product,404,'PRODUCT_NOT_FOUND','Produto não disponível nesta loja.');
        requireThat(product.stock_quantity>=item.quantity,409,'INSUFFICIENT_STOCK',`Estoque insuficiente: ${product.name}.`);
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
      this.run(`INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?,'CONFIRMED','TEST_NOT_ISSUED',?)`,ctx.tenantId,saleId,input.storeId,input.cashSessionId,ctx.userId,
        subtotal,input.discountCents,input.discountCents>0?input.discountReason:null,input.discountCents>0?ctx.userId:null,total,now());
      for (const line of lines) {
        // BEGIN IMMEDIATE serializa escritores. A condição de saldo é uma defesa adicional.
        const changed=this.run(`UPDATE stock SET quantity=quantity-? WHERE tenant_id=? AND store_id=? AND product_id=? AND quantity>=?`,
          line.quantity,ctx.tenantId,input.storeId,line.productId,line.quantity);
        requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo mudou. Consulte o estoque.');
        this.run('INSERT INTO sale_items VALUES(?,?,?,?,?,?,?,?)',ctx.tenantId,saleId,line.productId,line.sku,line.name,line.quantity,line.priceCents,line.lineCents);
        this.run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',ctx.tenantId,randomUUID(),input.storeId,line.productId,saleId,-line.quantity,'SALE','Venda confirmada de teste',ctx.userId,now());
      }
      this.run("INSERT INTO payments VALUES(?,?,?,'CONFIRMED',?,?,?)",ctx.tenantId,saleId,input.paymentMethod,total,tenderedCents,changeCents);
      if(input.paymentMethod==='CASH') this.run("INSERT INTO cash_movements VALUES(?,?,?,?,?,'SALE',?,?,?,?)",ctx.tenantId,randomUUID(),input.storeId,input.cashSessionId,saleId,total,'Venda em dinheiro',ctx.userId,now());
      this.audit(ctx,input.storeId,'SALE_CONFIRMED',saleId,{totalCents:total,paymentMethod:input.paymentMethod,discountCents:input.discountCents,discountReason:input.discountReason});
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
  receipt(ctx,saleId) {
    const sale=this.one('SELECT * FROM sales WHERE tenant_id=? AND id=?',ctx.tenantId,id(saleId));
    requireThat(sale,404,'SALE_NOT_FOUND','Venda não encontrada.');
    this.authorize(ctx,sale.store_id);
    return {...sale,
      cancellation:this.one(`SELECT reason,created_at,u.name actor_name FROM sale_cancellations c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.actor_id
        WHERE c.tenant_id=? AND c.sale_id=?`,ctx.tenantId,saleId),
      store_name:this.one('SELECT name FROM stores WHERE tenant_id=? AND id=?',ctx.tenantId,sale.store_id).name,
      operator_name:this.one('SELECT name FROM users WHERE tenant_id=? AND id=?',ctx.tenantId,sale.operator_id).name,
      items:this.all('SELECT product_id,sku_snapshot,name_snapshot,quantity,price_cents,line_cents FROM sale_items WHERE tenant_id=? AND sale_id=? ORDER BY sku_snapshot',ctx.tenantId,saleId),
      payment:this.one('SELECT method,status,amount_cents,tendered_cents,change_cents FROM payments WHERE tenant_id=? AND sale_id=?',ctx.tenantId,saleId)};
  }
  state(ctx,storeId) {
    id(storeId);
    this.authorize(ctx,storeId);
    const open=this.all("SELECT id FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='OPEN' ORDER BY terminal_id",ctx.tenantId,storeId);
    return {
      products:this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.quantity FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE s.tenant_id=? AND s.store_id=? AND p.active=1 ORDER BY p.name`,ctx.tenantId,storeId),
      terminals:this.all('SELECT id,name FROM terminals WHERE tenant_id=? AND store_id=? ORDER BY id',ctx.tenantId,storeId),
      users:this.user(ctx).role==='MANAGER'?this.all(`SELECT u.id,u.email,u.name,u.role,u.active
        FROM users u JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE u.tenant_id=? AND m.store_id=? ORDER BY u.name`,ctx.tenantId,storeId):[],
      cash:open.map(c=>this.cash(ctx,c.id)),
      cashMovements:this.all(`SELECT m.id,m.cash_session_id,m.kind,m.amount_cents,m.reason,m.created_at,u.name actor_name
        FROM cash_movements m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
        WHERE m.tenant_id=? AND m.store_id=? ORDER BY m.created_at DESC LIMIT 50`,ctx.tenantId,storeId),
      sales:this.all(`SELECT s.id,s.total_cents,s.discount_cents,s.created_at,u.name operator_name,c.terminal_id,t.name terminal_name,
          x.created_at canceled_at,x.reason cancel_reason
        FROM sales s
        JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
        JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
        JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
        LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
        WHERE s.tenant_id=? AND s.store_id=? ORDER BY s.created_at DESC LIMIT 30`,ctx.tenantId,storeId),
      stockMovements:this.all(`SELECT m.product_id,p.name,m.kind,m.quantity,m.reason,m.created_at FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
        WHERE m.tenant_id=? AND m.store_id=? ORDER BY m.created_at DESC LIMIT 50`,ctx.tenantId,storeId),
      cashHistory:this.all("SELECT id,terminal_id,expected_cents,counted_cents,difference_cents,closed_at FROM cash_sessions WHERE tenant_id=? AND store_id=? AND status='CLOSED' ORDER BY closed_at DESC LIMIT 20",ctx.tenantId,storeId)
    };
  }
}
