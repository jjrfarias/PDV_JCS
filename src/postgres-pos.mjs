import { randomUUID } from 'node:crypto';
import { all, one, run, withPostgresTransaction } from './postgres.mjs';
import { PostgresProducts } from './postgres-products.mjs';
import { PostgresOperations } from './postgres-operations.mjs';
import { hashPassword, sha256 } from './security.mjs';
import { requireThat, object, text, integer, id, operationKey } from './errors.mjs';

const now = () => new Date().toISOString();
const MAX_MONEY = 100_000_000;

function cashInteger(value) {
  // PostgreSQL SUM(integer) is bigint and pg returns it as text by default.
  const result = Number(value);
  requireThat(Number.isSafeInteger(result) && result >= 0, 500, 'INVALID_CASH_BALANCE', 'Saldo do caixa inválido.');
  return result;
}

// This object exists only for one transaction. It never obtains another connection.
class TransactionPos {
  constructor(client, { readOnly }) {
    this.client = client;
    this.readOnly = readOnly;
    this.products = new PostgresProducts(client);
    this.operations = new PostgresOperations(client);
  }
  one(sql, ...args) { return one(this.client, sql, args); }
  all(sql, ...args) { return all(this.client, sql, args); }
  run(sql, ...args) { return run(this.client, sql, args); }

  async user(ctx) {
    const user = await this.one(`SELECT id,name,email,role FROM users
      WHERE tenant_id=$1 AND id=$2 AND active=1${this.readOnly ? '' : ' FOR SHARE'}`, ctx.tenantId, ctx.userId);
    requireThat(user, 401, 'AUTH_REQUIRED', 'Faça login novamente.');
    return user;
  }

  async authorize(ctx, storeId) {
    const user = await this.user(ctx);
    const membership = await this.one(`SELECT 1 FROM memberships
      WHERE tenant_id=$1 AND user_id=$2 AND store_id=$3${this.readOnly ? '' : ' FOR SHARE'}`,
    ctx.tenantId, ctx.userId, storeId);
    requireThat(membership, 403, 'STORE_FORBIDDEN', 'Você não tem acesso a esta loja.');
    return user;
  }

  async me(ctx) {
    return {
      user: await this.user(ctx), tenantId: ctx.tenantId,
      stores: await this.all(`SELECT s.id,s.name FROM stores s
        JOIN memberships m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
        WHERE m.tenant_id=$1 AND m.user_id=$2 ORDER BY s.name`, ctx.tenantId, ctx.userId)
    };
  }

  async audit(ctx, storeId, action, entityId, details) {
    await this.run(`INSERT INTO audit_events
      (tenant_id,id,user_id,store_id,action,entity_id,details_json,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    ctx.tenantId, randomUUID(), ctx.userId, storeId, action, entityId, JSON.stringify(details), now());
  }

  async operation(ctx, key) {
    operationKey(key);
    const op = await this.one('SELECT * FROM operations WHERE tenant_id=$1 AND key=$2 AND user_id=$3',
      ctx.tenantId, key, ctx.userId);
    requireThat(op, 404, 'NOT_FOUND', 'Operação não encontrada para este usuário.');
    await this.authorize(ctx, op.store_id);
    return { data: JSON.parse(op.response_json), replayed: true, kind: op.kind };
  }

  async cash(ctx, cashId, { lock = false } = {}) {
    const cash = await this.one(`SELECT * FROM cash_sessions
      WHERE tenant_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, ctx.tenantId, id(cashId));
    requireThat(cash, 404, 'CASH_NOT_FOUND', 'Caixa não encontrado.');
    await this.authorize(ctx, cash.store_id);
    const sums = await this.one(`SELECT COALESCE(SUM(amount_cents),0) expected,
      COALESCE(SUM(CASE WHEN kind='SALE' THEN amount_cents ELSE 0 END),0) sales
      FROM cash_movements WHERE tenant_id=$1 AND cash_session_id=$2`, ctx.tenantId, cashId);
    return { ...cash, expected_cents: cashInteger(sums.expected), sales_cents: cashInteger(sums.sales) };
  }

  async receipt(ctx, saleId) {
    const sale = await this.one('SELECT * FROM sales WHERE tenant_id=$1 AND id=$2', ctx.tenantId, id(saleId));
    requireThat(sale, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.');
    await this.authorize(ctx, sale.store_id);
    const store = await this.one('SELECT name FROM stores WHERE tenant_id=$1 AND id=$2', ctx.tenantId, sale.store_id);
    const operator = await this.one('SELECT name FROM users WHERE tenant_id=$1 AND id=$2', ctx.tenantId, sale.operator_id);
    return {
      ...sale, store_name: store.name, operator_name: operator.name,
      items: await this.all(`SELECT product_id,sku_snapshot,name_snapshot,quantity,price_cents,line_cents
        FROM sale_items WHERE tenant_id=$1 AND sale_id=$2 ORDER BY sku_snapshot`, ctx.tenantId, saleId),
      payment: await this.one(`SELECT method,status,amount_cents,tendered_cents,change_cents
        FROM payments WHERE tenant_id=$1 AND sale_id=$2`, ctx.tenantId, saleId)
    };
  }

  async state(ctx, storeId) {
    id(storeId);
    await this.authorize(ctx, storeId);
    const open = await this.all(`SELECT id FROM cash_sessions
      WHERE tenant_id=$1 AND store_id=$2 AND status='OPEN' ORDER BY terminal_id`, ctx.tenantId, storeId);
    const cash = [];
    for (const entry of open) cash.push(await this.cash(ctx, entry.id));
    return {
      products: await this.products.listForStore(ctx.tenantId, storeId),
      terminals: await this.all('SELECT id,name FROM terminals WHERE tenant_id=$1 AND store_id=$2 ORDER BY id', ctx.tenantId, storeId),
      users: (await this.user(ctx)).role === 'MANAGER'
        ? await this.all(`SELECT u.id,u.email,u.name,u.role,u.active
          FROM users u JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
          WHERE u.tenant_id=$1 AND m.store_id=$2 ORDER BY u.name`, ctx.tenantId, storeId)
        : [],
      cash,
      sales: await this.all(`SELECT s.id,s.total_cents,s.discount_cents,s.created_at,u.name operator_name,c.terminal_id,t.name terminal_name
        FROM sales s
        JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
        JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
        JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
        WHERE s.tenant_id=$1 AND s.store_id=$2 ORDER BY s.created_at DESC LIMIT 30`, ctx.tenantId, storeId),
      stockMovements: await this.all(`SELECT m.product_id,p.name,m.kind,m.quantity,m.reason,m.created_at
        FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
        WHERE m.tenant_id=$1 AND m.store_id=$2 ORDER BY m.created_at DESC LIMIT 50`, ctx.tenantId, storeId),
      cashHistory: await this.all(`SELECT id,terminal_id,expected_cents,counted_cents,difference_cents,closed_at
        FROM cash_sessions WHERE tenant_id=$1 AND store_id=$2 AND status='CLOSED'
        ORDER BY closed_at DESC LIMIT 20`, ctx.tenantId, storeId)
    };
  }
}

export class PostgresPos {
  constructor(pool, hooks = {}) { this.pool = pool; this.hooks = hooks; }

  async #transaction(ctx, readOnly, work) {
    requireThat(ctx && typeof ctx.tenantId === 'string' && typeof ctx.userId === 'string',
      401, 'AUTH_REQUIRED', 'Faça login novamente.');
    return withPostgresTransaction(this.pool,
      client => work(new TransactionPos(client, { readOnly })),
      { tenantId: ctx.tenantId, userId: ctx.userId, readOnly });
  }

  async user(ctx) { return this.#transaction(ctx, true, tx => tx.user(ctx)); }
  async authorize(ctx, storeId) { return this.#transaction(ctx, true, tx => tx.authorize(ctx, storeId)); }
  async me(ctx) { return this.#transaction(ctx, true, tx => tx.me(ctx)); }
  async operation(ctx, key) { return this.#transaction(ctx, true, tx => tx.operation(ctx, key)); }
  async cash(ctx, cashId) { return this.#transaction(ctx, true, tx => tx.cash(ctx, cashId)); }
  async receipt(ctx, saleId) { return this.#transaction(ctx, true, tx => tx.receipt(ctx, saleId)); }
  async state(ctx, storeId) { return this.#transaction(ctx, true, tx => tx.state(ctx, storeId)); }

  async #mutate(ctx, kind, key, input, work) {
    operationKey(key);
    return this.#transaction(ctx, false, async tx => {
      const user = await tx.authorize(ctx, input.storeId);
      const payloadHash = sha256(JSON.stringify({ kind, input }));
      await tx.operations.lock(ctx.tenantId, key);
      const previous = await tx.operations.find(ctx.tenantId, key);
      if (previous) {
        requireThat(previous.user_id === ctx.userId && previous.store_id === input.storeId &&
          previous.kind === kind && previous.payload_hash === payloadHash,
        409, 'IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada em outra operação ou com outros dados.');
        return { data: JSON.parse(previous.response_json), replayed: true };
      }
      const data = await work(tx, user);
      await tx.operations.save({ tenantId: ctx.tenantId, key, userId: ctx.userId,
        storeId: input.storeId, kind, payloadHash, response: data });
      // A code-only hook exercises rollback of every effect, including the operation response.
      await this.hooks.beforeCommit?.(kind);
      return { data, replayed: false };
    });
  }

  async createProduct(ctx, key, raw) {
    object(raw, ['storeId', 'sku', 'barcode', 'name', 'priceCents', 'initialQuantity']);
    const input = {
      storeId: id(raw.storeId), sku: text(raw.sku, 'Código', 40).toUpperCase(),
      barcode: raw.barcode ? text(raw.barcode, 'Código de barras', 48) : null,
      name: text(raw.name, 'Nome'), priceCents: integer(raw.priceCents, 'Preço', 1),
      initialQuantity: integer(raw.initialQuantity, 'Estoque', 0, 1_000_000)
    };
    return this.#mutate(ctx, 'PRODUCT_CREATE', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente cadastra produtos neste incremento.');
      const productId = randomUUID();
      const inserted = await tx.run(`INSERT INTO products(tenant_id,id,sku,barcode,name,price_cents)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      ctx.tenantId, productId, input.sku, input.barcode, input.name, input.priceCents);
      requireThat(inserted.changes === 1, 409, 'DUPLICATE_PRODUCT', 'Código interno ou código de barras já cadastrado.');
      await tx.run('INSERT INTO stock(tenant_id,store_id,product_id,quantity) VALUES($1,$2,$3,$4)',
        ctx.tenantId, input.storeId, productId, input.initialQuantity);
      if (input.initialQuantity > 0) {
        await tx.run(`INSERT INTO stock_movements
          (tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,$5,'INITIAL','Cadastro com estoque inicial',$6,$7)`,
        ctx.tenantId, randomUUID(), input.storeId, productId, input.initialQuantity, ctx.userId, now());
      }
      await tx.audit(ctx, input.storeId, 'PRODUCT_CREATED', productId,
        { initialQuantity: input.initialQuantity, priceCents: input.priceCents });
      return { id: productId, ...input };
    });
  }

  async createUser(ctx, key, raw) {
    object(raw, ['storeId', 'email', 'name', 'role', 'temporaryPassword']);
    const input = {
      storeId: id(raw.storeId),
      email: text(raw.email, 'E-mail', 120).toLowerCase(),
      name: text(raw.name, 'Nome', 120),
      role: text(raw.role, 'Perfil', 20),
      temporaryPassword: text(raw.temporaryPassword, 'Senha temporária', 200, 12)
    };
    requireThat(['MANAGER', 'CASHIER'].includes(input.role), 400, 'INVALID_ROLE', 'Perfil inválido.');
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email), 400, 'INVALID_EMAIL', 'E-mail inválido.');
    requireThat(/[A-Z]/.test(input.temporaryPassword) && /[a-z]/.test(input.temporaryPassword) && /\d/.test(input.temporaryPassword),
      400, 'WEAK_PASSWORD', 'A senha temporária deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    return this.#mutate(ctx, 'USER_CREATE', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente cadastra usuários.');
      const userId = randomUUID();
      const inserted = await tx.run(`INSERT INTO users(tenant_id,id,email,name,password_hash,role,active)
        VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT DO NOTHING`,
      ctx.tenantId, userId, input.email, input.name, hashPassword(input.temporaryPassword), input.role);
      requireThat(inserted.changes === 1, 409, 'DUPLICATE_USER', 'E-mail já cadastrado.');
      await tx.run('INSERT INTO memberships(tenant_id,user_id,store_id) VALUES($1,$2,$3)',
        ctx.tenantId, userId, input.storeId);
      await tx.audit(ctx, input.storeId, 'USER_CREATED', userId, { email: input.email, role: input.role });
      return { id: userId, email: input.email, name: input.name, role: input.role, active: 1, storeId: input.storeId };
    });
  }

  async openCash(ctx, key, raw) {
    object(raw, ['storeId', 'terminalId', 'openingCents']);
    const input = { storeId: id(raw.storeId), terminalId: id(raw.terminalId), openingCents: integer(raw.openingCents, 'Fundo inicial') };
    return this.#mutate(ctx, 'CASH_OPEN', key, input, async tx => {
      const terminal = await tx.one(`SELECT 1 FROM terminals
        WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE`, ctx.tenantId, input.storeId, input.terminalId);
      requireThat(terminal, 404, 'TERMINAL_NOT_FOUND', 'Terminal não encontrado nesta loja.');
      const open = await tx.one(`SELECT 1 FROM cash_sessions
        WHERE tenant_id=$1 AND terminal_id=$2 AND status='OPEN'`, ctx.tenantId, input.terminalId);
      requireThat(!open, 409, 'CASH_ALREADY_OPEN', 'Este terminal já tem um caixa aberto.');
      const cashId = randomUUID();
      await tx.run(`INSERT INTO cash_sessions(tenant_id,id,store_id,terminal_id,operator_id,status,opening_cents,opened_at)
        VALUES($1,$2,$3,$4,$5,'OPEN',$6,$7)`,
      ctx.tenantId, cashId, input.storeId, input.terminalId, ctx.userId, input.openingCents, now());
      await tx.run(`INSERT INTO cash_movements
        (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,actor_id,created_at)
        VALUES($1,$2,$3,$4,NULL,'OPENING',$5,$6,$7)`,
      ctx.tenantId, randomUUID(), input.storeId, cashId, input.openingCents, ctx.userId, now());
      await tx.audit(ctx, input.storeId, 'CASH_OPENED', cashId, { openingCents: input.openingCents });
      return tx.cash(ctx, cashId);
    });
  }

  async closeCash(ctx, key, raw) {
    object(raw, ['storeId', 'cashSessionId', 'countedCents', 'reason']);
    const input = {
      storeId: id(raw.storeId), cashSessionId: id(raw.cashSessionId), countedCents: integer(raw.countedCents, 'Valor contado'),
      reason: raw.reason ? text(raw.reason, 'Motivo', 200) : null
    };
    return this.#mutate(ctx, 'CASH_CLOSE', key, input, async tx => {
      const cash = await tx.cash(ctx, input.cashSessionId, { lock: true });
      requireThat(cash.store_id === input.storeId, 409, 'CASH_STORE_MISMATCH', 'Caixa de outra loja.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'O fechamento deve ser feito pelo operador que abriu este caixa.');
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Este caixa já foi fechado.');
      const difference = input.countedCents - cash.expected_cents;
      requireThat(difference === 0 || (input.reason?.length ?? 0) >= 3, 400, 'CLOSE_REASON_REQUIRED', 'Informe o motivo da diferença de caixa.');
      await tx.run(`UPDATE cash_sessions SET status='CLOSED',counted_cents=$1,expected_cents=$2,
        difference_cents=$3,close_reason=$4,closed_at=$5 WHERE tenant_id=$6 AND id=$7`,
      input.countedCents, cash.expected_cents, difference, input.reason, now(), ctx.tenantId, input.cashSessionId);
      await tx.audit(ctx, input.storeId, 'CASH_CLOSED', input.cashSessionId, {
        expectedCents: cash.expected_cents, countedCents: input.countedCents, differenceCents: difference, reason: input.reason
      });
      return tx.cash(ctx, input.cashSessionId);
    });
  }

  async sell(ctx, key, raw) {
    object(raw, ['storeId', 'cashSessionId', 'items', 'discountCents', 'discountReason', 'tenderedCents']);
    requireThat(Array.isArray(raw.items) && raw.items.length > 0 && raw.items.length <= 100,
      400, 'INVALID_ITEMS', 'Informe entre 1 e 100 produtos.');
    const items = raw.items.map(item => {
      object(item, ['productId', 'quantity']);
      return { productId: id(item.productId), quantity: integer(item.quantity, 'Quantidade', 1, 10_000) };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    requireThat(new Set(items.map(item => item.productId)).size === items.length,
      400, 'DUPLICATE_ITEM', 'Agrupe a quantidade do mesmo produto em uma única linha.');
    const input = {
      storeId: id(raw.storeId), cashSessionId: id(raw.cashSessionId), items,
      discountCents: integer(raw.discountCents ?? 0, 'Desconto'),
      discountReason: raw.discountReason ? text(raw.discountReason, 'Motivo', 200) : null,
      tenderedCents: integer(raw.tenderedCents, 'Valor entregue', 1)
    };
    return this.#mutate(ctx, 'SALE', key, input, async (tx, user) => {
      // This row serializes selling/closing only this till, including balance-limit checks.
      const cash = await tx.cash(ctx, input.cashSessionId, { lock: true });
      requireThat(cash.store_id === input.storeId, 409, 'CASH_STORE_MISMATCH', 'Caixa de outra loja.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Abra o caixa antes de vender.');
      const lines = [];
      // A stable product order avoids lock-order deadlocks across different tills.
      for (const item of input.items) {
        const product = await tx.products.findForSale(ctx.tenantId, input.storeId, item.productId, { lock: true });
        requireThat(product, 404, 'PRODUCT_NOT_FOUND', 'Produto não disponível nesta loja.');
        requireThat(product.stock_quantity >= item.quantity, 409, 'INSUFFICIENT_STOCK', `Estoque insuficiente: ${product.name}.`);
        lines.push({ ...item, sku: product.sku, name: product.name, priceCents: product.price_cents,
          lineCents: integer(product.price_cents * item.quantity, 'Total do item', 1) });
      }
      const subtotal = integer(lines.reduce((sum, line) => sum + line.lineCents, 0), 'Subtotal', 1);
      if (input.discountCents > 0) {
        requireThat(user.role === 'MANAGER', 403, 'DISCOUNT_FORBIDDEN', 'Este operador não tem permissão para desconto.');
        requireThat((input.discountReason?.length ?? 0) >= 3, 400, 'DISCOUNT_REASON_REQUIRED', 'Informe o motivo do desconto.');
        requireThat(input.discountCents * 100 <= subtotal * 20, 400, 'DISCOUNT_LIMIT', 'Limite de desconto neste laboratório: 20%.');
      }
      const total = subtotal - input.discountCents;
      requireThat(total > 0 && input.tenderedCents >= total, 400, 'INSUFFICIENT_CASH', 'Valor entregue menor que o total da venda.');
      requireThat(cash.expected_cents + total <= MAX_MONEY, 409, 'CASH_LIMIT', 'Limite monetário do caixa atingido neste laboratório.');
      const saleId = randomUUID();
      await tx.run(`INSERT INTO sales
        (tenant_id,id,store_id,cash_session_id,operator_id,subtotal_cents,discount_cents,discount_reason,
          discount_author_id,total_cents,status,fiscal_status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CONFIRMED','TEST_NOT_ISSUED',$11)`,
      ctx.tenantId, saleId, input.storeId, input.cashSessionId, ctx.userId, subtotal, input.discountCents,
      input.discountCents > 0 ? input.discountReason : null, input.discountCents > 0 ? ctx.userId : null, total, now());
      for (const line of lines) {
        const changed = await tx.products.decrementStock(ctx.tenantId, input.storeId, line.productId, line.quantity);
        requireThat(changed, 409, 'INSUFFICIENT_STOCK', 'Saldo mudou. Consulte o estoque.');
        await tx.run(`INSERT INTO sale_items
          (tenant_id,sale_id,product_id,sku_snapshot,name_snapshot,quantity,price_cents,line_cents)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        ctx.tenantId, saleId, line.productId, line.sku, line.name, line.quantity, line.priceCents, line.lineCents);
        await tx.run(`INSERT INTO stock_movements
          (tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6,'SALE','Venda confirmada de teste',$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, line.productId, saleId, -line.quantity, ctx.userId, now());
      }
      await tx.run(`INSERT INTO payments(tenant_id,sale_id,method,status,amount_cents,tendered_cents,change_cents)
        VALUES($1,$2,'CASH','CONFIRMED',$3,$4,$5)`,
      ctx.tenantId, saleId, total, input.tenderedCents, input.tenderedCents - total);
      await tx.run(`INSERT INTO cash_movements
        (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,'SALE',$6,$7,$8)`,
      ctx.tenantId, randomUUID(), input.storeId, input.cashSessionId, saleId, total, ctx.userId, now());
      await tx.audit(ctx, input.storeId, 'SALE_CONFIRMED', saleId,
        { totalCents: total, discountCents: input.discountCents, discountReason: input.discountReason });
      return tx.receipt(ctx, saleId);
    });
  }
}
