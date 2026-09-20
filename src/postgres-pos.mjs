import { randomUUID } from 'node:crypto';
import { all, one, run, withPostgresTransaction } from './postgres.mjs';
import { PostgresProducts } from './postgres-products.mjs';
import { PostgresOperations } from './postgres-operations.mjs';
import { decryptField, encryptField, fieldDigest, hashPassword, sha256 } from './security.mjs';
import { requireThat, object, text, integer, id, operationKey } from './errors.mjs';

const now = () => new Date().toISOString();
const MAX_MONEY = 100_000_000;
const PAYMENT_METHODS = new Set(['CASH', 'PIX', 'CARD']);
const CASH_ADJUSTMENTS = new Set(['SUPPLY', 'WITHDRAWAL']);
const onlyDigits = value => value ? String(value).replace(/\D/g, '') : null;
function customerInput(raw, { updating = false } = {}) {
  object(raw, updating ? ['storeId', 'customerId', 'name', 'document', 'phone', 'email', 'note', 'active'] : ['storeId', 'name', 'document', 'phone', 'email', 'note']);
  const email = raw.email ? text(raw.email, 'E-mail', 120).toLowerCase() : null;
  if (email) requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), 400, 'INVALID_EMAIL', 'E-mail inválido.');
  const document = onlyDigits(raw.document);
  if (document) requireThat(document.length >= 11 && document.length <= 14, 400, 'INVALID_DOCUMENT', 'Documento deve ter CPF ou CNPJ.');
  const phone = onlyDigits(raw.phone);
  if (phone) requireThat(phone.length >= 10 && phone.length <= 13, 400, 'INVALID_PHONE', 'Telefone inválido.');
  return {
    storeId: id(raw.storeId), customerId: updating ? id(raw.customerId) : undefined,
    name: text(raw.name, 'Nome do cliente', 120), document, phone, email,
    note: raw.note ? text(raw.note, 'Observação', 300) : null,
    active: updating ? integer(raw.active, 'Status', 0, 1) : 1
  };
}
function reportRange(from, to) {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  requireThat(date.test(from) && date.test(to), 400, 'INVALID_PERIOD', 'Informe datas no formato AAAA-MM-DD.');
  const start = new Date(`${from}T00:00:00.000Z`);
  const endDay = new Date(`${to}T00:00:00.000Z`);
  requireThat(!Number.isNaN(start.getTime()) && !Number.isNaN(endDay.getTime()) && endDay >= start,
    400, 'INVALID_PERIOD', 'Período inválido.');
  const days = Math.floor((endDay - start) / 86_400_000) + 1;
  requireThat(days <= 366, 400, 'PERIOD_TOO_LONG', 'Relatório limitado a 366 dias.');
  const end = new Date(endDay.getTime() + 86_400_000);
  return { from, to, start: start.toISOString(), end: end.toISOString() };
}

function cashInteger(value) {
  // PostgreSQL SUM(integer) is bigint and pg returns it as text by default.
  const result = Number(value);
  requireThat(Number.isSafeInteger(result), 500, 'INVALID_CASH_BALANCE', 'Saldo do caixa inválido.');
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
    const payments = await this.one(`SELECT
      COALESCE(SUM(p.amount_cents),0) total,
      COALESCE(SUM(CASE WHEN p.method='CASH' THEN p.amount_cents ELSE 0 END),0) cash_total,
      COALESCE(SUM(CASE WHEN p.method='PIX' THEN p.amount_cents ELSE 0 END),0) pix_total,
      COALESCE(SUM(CASE WHEN p.method='CARD' THEN p.amount_cents ELSE 0 END),0) card_total
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.cash_session_id=$2 AND x.sale_id IS NULL`, ctx.tenantId, cashId);
    return { ...cash, expected_cents: cashInteger(sums.expected), sales_cents: cashInteger(sums.sales),
      total_sales_cents: cashInteger(payments.total), cash_sales_cents: cashInteger(payments.cash_total),
      pix_sales_cents: cashInteger(payments.pix_total), card_sales_cents: cashInteger(payments.card_total) };
  }

  async receipt(ctx, saleId) {
    const sale = await this.one('SELECT * FROM sales WHERE tenant_id=$1 AND id=$2', ctx.tenantId, id(saleId));
    requireThat(sale, 404, 'SALE_NOT_FOUND', 'Venda não encontrada.');
    await this.authorize(ctx, sale.store_id);
    const store = await this.one('SELECT name FROM stores WHERE tenant_id=$1 AND id=$2', ctx.tenantId, sale.store_id);
    const operator = await this.one('SELECT name FROM users WHERE tenant_id=$1 AND id=$2', ctx.tenantId, sale.operator_id);
    return {
      ...sale, store_name: store.name, operator_name: operator.name,
      cancellation: await this.one(`SELECT reason,created_at,u.name actor_name FROM sale_cancellations c
        JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.actor_id
        WHERE c.tenant_id=$1 AND c.sale_id=$2`, ctx.tenantId, saleId),
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
      customers: (await this.all(`SELECT * FROM customers
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY updated_at DESC LIMIT 100`, ctx.tenantId, storeId))
        .map(row => this.customerRow(row)),
      cash,
      sales: await this.all(`SELECT s.id,s.total_cents,s.discount_cents,s.created_at,u.name operator_name,c.terminal_id,t.name terminal_name,
          x.created_at canceled_at,x.reason cancel_reason
        FROM sales s
        JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
        JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
        JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
        LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
        WHERE s.tenant_id=$1 AND s.store_id=$2 ORDER BY s.created_at DESC LIMIT 30`, ctx.tenantId, storeId),
      stockMovements: await this.all(`SELECT m.product_id,p.name,m.kind,m.quantity,m.reason,m.created_at
        FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
        WHERE m.tenant_id=$1 AND m.store_id=$2 ORDER BY m.created_at DESC LIMIT 50`, ctx.tenantId, storeId),
      cashMovements: await this.all(`SELECT m.id,m.cash_session_id,m.kind,m.amount_cents,m.reason,m.created_at,u.name actor_name
        FROM cash_movements m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
        WHERE m.tenant_id=$1 AND m.store_id=$2 ORDER BY m.created_at DESC LIMIT 50`, ctx.tenantId, storeId),
      cashHistory: await this.all(`SELECT id,terminal_id,expected_cents,counted_cents,difference_cents,closed_at
        FROM cash_sessions WHERE tenant_id=$1 AND store_id=$2 AND status='CLOSED'
        ORDER BY closed_at DESC LIMIT 20`, ctx.tenantId, storeId)
    };
  }

  async report(ctx, storeId, from, to) {
    id(storeId);
    await this.authorize(ctx, storeId);
    const range = reportRange(from, to);
    const sales = await this.all(`SELECT s.id,s.created_at,s.total_cents,s.discount_cents,p.method,u.name operator_name,t.name terminal_name,
        x.created_at canceled_at,x.reason cancel_reason
      FROM sales s
      JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
      JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
      JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4
      ORDER BY s.created_at`, ctx.tenantId, storeId, range.start, range.end);
    const normalizedSales = sales.map(sale => ({ ...sale,
      total_cents: cashInteger(sale.total_cents), discount_cents: cashInteger(sale.discount_cents) }));
    const active = normalizedSales.filter(sale => !sale.canceled_at);
    const summary = {
      sale_count: normalizedSales.length, active_sale_count: active.length,
      canceled_sale_count: normalizedSales.length - active.length,
      gross_cents: active.reduce((sum, sale) => sum + sale.total_cents, 0),
      discount_cents: active.reduce((sum, sale) => sum + sale.discount_cents, 0),
      canceled_cents: normalizedSales.filter(sale => sale.canceled_at).reduce((sum, sale) => sum + sale.total_cents, 0)
    };
    const payments = (await this.all(`SELECT p.method,COUNT(*) sale_count,COALESCE(SUM(p.amount_cents),0) amount_cents
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4 AND x.sale_id IS NULL
      GROUP BY p.method ORDER BY p.method`, ctx.tenantId, storeId, range.start, range.end))
      .map(row => ({ ...row, sale_count: cashInteger(row.sale_count), amount_cents: cashInteger(row.amount_cents) }));
    const products = (await this.all(`SELECT i.product_id,i.sku_snapshot sku,i.name_snapshot name,COALESCE(SUM(i.quantity),0) quantity,
        COALESCE(SUM(i.line_cents),0) total_cents
      FROM sales s JOIN sale_items i ON i.tenant_id=s.tenant_id AND i.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4 AND x.sale_id IS NULL
      GROUP BY i.product_id,i.sku_snapshot,i.name_snapshot ORDER BY total_cents DESC,name LIMIT 50`,
    ctx.tenantId, storeId, range.start, range.end))
      .map(row => ({ ...row, quantity: cashInteger(row.quantity), total_cents: cashInteger(row.total_cents) }));
    const operators = (await this.all(`SELECT u.name operator_name,COUNT(*) sale_count,COALESCE(SUM(s.total_cents),0) total_cents
      FROM sales s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4 AND x.sale_id IS NULL
      GROUP BY u.name ORDER BY total_cents DESC,u.name`, ctx.tenantId, storeId, range.start, range.end))
      .map(row => ({ ...row, sale_count: cashInteger(row.sale_count), total_cents: cashInteger(row.total_cents) }));
    const cashClosures = (await this.all(`SELECT c.closed_at,t.name terminal_name,c.expected_cents,c.counted_cents,c.difference_cents,c.close_reason
      FROM cash_sessions c JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      WHERE c.tenant_id=$1 AND c.store_id=$2 AND c.status='CLOSED' AND c.closed_at>=$3 AND c.closed_at<$4
      ORDER BY c.closed_at`, ctx.tenantId, storeId, range.start, range.end))
      .map(row => ({ ...row, expected_cents: cashInteger(row.expected_cents),
        counted_cents: cashInteger(row.counted_cents), difference_cents: cashInteger(row.difference_cents) }));
    return { range, summary, payments, products, operators, cashClosures, sales: normalizedSales };
  }

  customerRow(row) {
    return row ? {
      id: row.id, store_id: row.store_id, name: decryptField(row.name_enc),
      document: decryptField(row.document_enc), phone: decryptField(row.phone_enc), email: decryptField(row.email_enc),
      note: decryptField(row.note_enc), active: row.active,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    } : null;
  }

  customerMutationResult(row) {
    return {
      id: row.id, storeId: row.store_id, active: row.active,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
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
  async report(ctx, storeId, from, to) { return this.#transaction(ctx, true, tx => tx.report(ctx, storeId, from, to)); }

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

  async updateProduct(ctx, key, raw) {
    object(raw, ['storeId', 'productId', 'sku', 'barcode', 'name', 'priceCents', 'active']);
    const input = {
      storeId: id(raw.storeId), productId: id(raw.productId),
      sku: text(raw.sku, 'Código', 40).toUpperCase(),
      barcode: raw.barcode ? text(raw.barcode, 'Código de barras', 48) : null,
      name: text(raw.name, 'Nome'), priceCents: integer(raw.priceCents, 'Preço', 1),
      active: integer(raw.active, 'Status', 0, 1)
    };
    return this.#mutate(ctx, 'PRODUCT_UPDATE', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente altera produtos.');
      const current = await tx.one(`SELECT p.* FROM products p
        JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE p.tenant_id=$1 AND s.store_id=$2 AND p.id=$3 FOR UPDATE OF p`,
      ctx.tenantId, input.storeId, input.productId);
      requireThat(current, 404, 'PRODUCT_NOT_FOUND', 'Produto não disponível nesta loja.');
      const duplicate = await tx.one(`SELECT 1 FROM products
        WHERE tenant_id=$1 AND id<>$2 AND (sku=$3 OR (barcode IS NOT NULL AND barcode=$4))`,
      ctx.tenantId, input.productId, input.sku, input.barcode);
      requireThat(!duplicate, 409, 'DUPLICATE_PRODUCT', 'Código interno ou código de barras já cadastrado.');
      await tx.run(`UPDATE products SET sku=$1,barcode=$2,name=$3,price_cents=$4,active=$5
        WHERE tenant_id=$6 AND id=$7`,
      input.sku, input.barcode, input.name, input.priceCents, input.active, ctx.tenantId, input.productId);
      await tx.audit(ctx, input.storeId, 'PRODUCT_UPDATED', input.productId,
        { sku: input.sku, barcode: input.barcode, name: input.name, priceCents: input.priceCents, active: input.active });
      return { id: input.productId, sku: input.sku, barcode: input.barcode, name: input.name,
        price_cents: input.priceCents, active: input.active };
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

  async updateUser(ctx, key, raw) {
    object(raw, ['storeId', 'userId', 'email', 'name', 'role', 'active', 'temporaryPassword']);
    const input = {
      storeId: id(raw.storeId), userId: id(raw.userId),
      email: text(raw.email, 'E-mail', 120).toLowerCase(),
      name: text(raw.name, 'Nome', 120),
      role: text(raw.role, 'Perfil', 20),
      active: integer(raw.active, 'Status', 0, 1),
      temporaryPassword: raw.temporaryPassword ? text(raw.temporaryPassword, 'Senha temporária', 200, 12) : null
    };
    requireThat(['MANAGER', 'CASHIER'].includes(input.role), 400, 'INVALID_ROLE', 'Perfil inválido.');
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email), 400, 'INVALID_EMAIL', 'E-mail inválido.');
    if (input.temporaryPassword) {
      requireThat(/[A-Z]/.test(input.temporaryPassword) && /[a-z]/.test(input.temporaryPassword) && /\d/.test(input.temporaryPassword),
        400, 'WEAK_PASSWORD', 'A senha temporária deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    }
    return this.#mutate(ctx, 'USER_UPDATE', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente altera usuários.');
      const current = await tx.one(`SELECT u.id,u.role FROM users u
        JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE u.tenant_id=$1 AND u.id=$2 AND m.store_id=$3 FOR UPDATE OF u`,
      ctx.tenantId, input.userId, input.storeId);
      requireThat(current, 404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta loja.');
      requireThat(!(input.userId === ctx.userId && input.active === 0), 400, 'SELF_DEACTIVATE_FORBIDDEN', 'Não é permitido inativar seu próprio usuário.');
      requireThat(!(input.userId === ctx.userId && input.role !== 'MANAGER'), 400, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Não é permitido remover seu próprio perfil de gerente.');
      const duplicate = await tx.one('SELECT 1 FROM users WHERE tenant_id=$1 AND email=$2 AND id<>$3',
        ctx.tenantId, input.email, input.userId);
      requireThat(!duplicate, 409, 'DUPLICATE_USER', 'E-mail já cadastrado.');
      const passwordHash = input.temporaryPassword ? hashPassword(input.temporaryPassword) : null;
      if (passwordHash) {
        await tx.run(`UPDATE users SET email=$1,name=$2,role=$3,active=$4,password_hash=$5
          WHERE tenant_id=$6 AND id=$7`,
        input.email, input.name, input.role, input.active, passwordHash, ctx.tenantId, input.userId);
      } else {
        await tx.run('UPDATE users SET email=$1,name=$2,role=$3,active=$4 WHERE tenant_id=$5 AND id=$6',
          input.email, input.name, input.role, input.active, ctx.tenantId, input.userId);
      }
      if (passwordHash || input.active === 0 || current.role !== input.role) {
        await tx.run('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', ctx.tenantId, input.userId);
      }
      await tx.audit(ctx, input.storeId, 'USER_UPDATED', input.userId,
        { role: input.role, active: input.active, passwordReset: Boolean(passwordHash) });
      return { id: input.userId, email: input.email, name: input.name, role: input.role,
        active: input.active, storeId: input.storeId, passwordReset: Boolean(passwordHash) };
    });
  }

  async createCustomer(ctx, key, raw) {
    const input = customerInput(raw);
    return this.#mutate(ctx, 'CUSTOMER_CREATE', key, input, async tx => {
      if (input.document) {
        const duplicate = await tx.one('SELECT 1 FROM customers WHERE tenant_id=$1 AND document_hash=$2',
          ctx.tenantId, fieldDigest(input.document));
        requireThat(!duplicate, 409, 'DUPLICATE_CUSTOMER', 'Documento já cadastrado.');
      }
      const customerId = randomUUID(), createdAt = now();
      await tx.run(`INSERT INTO customers
        (tenant_id,id,store_id,name_enc,document_hash,document_enc,phone_hash,phone_enc,email_hash,email_enc,note_enc,active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$12)`,
      ctx.tenantId, customerId, input.storeId, encryptField(input.name),
      fieldDigest(input.document), encryptField(input.document), fieldDigest(input.phone), encryptField(input.phone),
      fieldDigest(input.email), encryptField(input.email), encryptField(input.note), createdAt);
      await tx.audit(ctx, input.storeId, 'CUSTOMER_CREATED', customerId,
        { active: 1, hasDocument: Boolean(input.document), hasEmail: Boolean(input.email) });
      return tx.customerMutationResult(await tx.one('SELECT id,store_id,active,created_at,updated_at FROM customers WHERE tenant_id=$1 AND id=$2', ctx.tenantId, customerId));
    });
  }

  async updateCustomer(ctx, key, raw) {
    const input = customerInput(raw, { updating: true });
    return this.#mutate(ctx, 'CUSTOMER_UPDATE', key, input, async tx => {
      const current = await tx.one('SELECT 1 FROM customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3 FOR UPDATE',
        ctx.tenantId, input.storeId, input.customerId);
      requireThat(current, 404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta loja.');
      if (input.document) {
        const duplicate = await tx.one('SELECT 1 FROM customers WHERE tenant_id=$1 AND document_hash=$2 AND id<>$3',
          ctx.tenantId, fieldDigest(input.document), input.customerId);
        requireThat(!duplicate, 409, 'DUPLICATE_CUSTOMER', 'Documento já cadastrado.');
      }
      const updatedAt = now();
      await tx.run(`UPDATE customers SET name_enc=$1,document_hash=$2,document_enc=$3,phone_hash=$4,phone_enc=$5,
          email_hash=$6,email_enc=$7,note_enc=$8,active=$9,updated_at=$10
        WHERE tenant_id=$11 AND id=$12`,
      encryptField(input.name), fieldDigest(input.document), encryptField(input.document), fieldDigest(input.phone),
      encryptField(input.phone), fieldDigest(input.email), encryptField(input.email), encryptField(input.note),
      input.active, updatedAt, ctx.tenantId, input.customerId);
      await tx.audit(ctx, input.storeId, 'CUSTOMER_UPDATED', input.customerId,
        { active: input.active, hasDocument: Boolean(input.document), hasEmail: Boolean(input.email) });
      return tx.customerMutationResult(await tx.one('SELECT id,store_id,active,created_at,updated_at FROM customers WHERE tenant_id=$1 AND id=$2', ctx.tenantId, input.customerId));
    });
  }

  async adjustStock(ctx, key, raw) {
    object(raw, ['storeId', 'productId', 'quantity', 'reason']);
    const input = {
      storeId: id(raw.storeId), productId: id(raw.productId),
      quantity: integer(raw.quantity, 'Quantidade', -1_000_000, 1_000_000),
      reason: text(raw.reason, 'Motivo', 200, 3)
    };
    requireThat(input.quantity !== 0, 400, 'INVALID_INPUT', 'Quantidade deve ser diferente de zero.');
    return this.#mutate(ctx, 'STOCK_ADJUST', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente ajusta estoque.');
      const product = await tx.one(`SELECT p.name,s.quantity FROM products p
        JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
        WHERE p.tenant_id=$1 AND s.store_id=$2 AND p.id=$3 AND p.active=1 FOR UPDATE`,
      ctx.tenantId, input.storeId, input.productId);
      requireThat(product, 404, 'PRODUCT_NOT_FOUND', 'Produto não disponível nesta loja.');
      const changed = await tx.run(`UPDATE stock SET quantity=quantity+$1
        WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity+$1 BETWEEN 0 AND 1000000`,
      input.quantity, ctx.tenantId, input.storeId, input.productId);
      requireThat(changed.changes === 1, 409, 'STOCK_LIMIT', 'Ajuste deixaria o estoque fora do limite permitido.');
      await tx.run(`INSERT INTO stock_movements
        (tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,
      ctx.tenantId, randomUUID(), input.storeId, input.productId, input.quantity, input.reason, ctx.userId, now());
      await tx.audit(ctx, input.storeId, 'STOCK_ADJUSTED', input.productId,
        { quantity: input.quantity, reason: input.reason });
      const updated = await tx.one('SELECT quantity FROM stock WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3',
        ctx.tenantId, input.storeId, input.productId);
      return { productId: input.productId, name: product.name, quantity: updated.quantity, adjustment: input.quantity, reason: input.reason };
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
        (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,NULL,'OPENING',$5,'Fundo inicial',$6,$7)`,
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

  async moveCash(ctx, key, raw) {
    object(raw, ['storeId', 'cashSessionId', 'kind', 'amountCents', 'reason']);
    const kind = text(raw.kind, 'Tipo de movimento', 20).toUpperCase();
    requireThat(CASH_ADJUSTMENTS.has(kind), 400, 'INVALID_CASH_MOVEMENT', 'Tipo de movimento de caixa inválido.');
    const input = {
      storeId: id(raw.storeId), cashSessionId: id(raw.cashSessionId), kind,
      amountCents: integer(raw.amountCents, 'Valor', 1), reason: text(raw.reason, 'Motivo', 200, 3)
    };
    return this.#mutate(ctx, 'CASH_MOVE', key, input, async tx => {
      const cash = await tx.cash(ctx, input.cashSessionId, { lock: true });
      requireThat(cash.store_id === input.storeId, 409, 'CASH_STORE_MISMATCH', 'Caixa de outra loja.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Este caixa já foi fechado.');
      const signed = input.kind === 'WITHDRAWAL' ? -input.amountCents : input.amountCents;
      const expected = cash.expected_cents + signed;
      requireThat(expected >= 0, 409, 'CASH_NEGATIVE', 'Sangria maior que o dinheiro esperado no caixa.');
      requireThat(expected <= MAX_MONEY, 409, 'CASH_LIMIT', 'Limite monetario do caixa atingido neste laboratorio.');
      const movementId = randomUUID();
      await tx.run(`INSERT INTO cash_movements
        (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9)`,
      ctx.tenantId, movementId, input.storeId, input.cashSessionId, input.kind, signed, input.reason, ctx.userId, now());
      await tx.audit(ctx, input.storeId, input.kind === 'WITHDRAWAL' ? 'CASH_WITHDRAWAL' : 'CASH_SUPPLY',
        movementId, { amountCents: input.amountCents, reason: input.reason });
      return tx.cash(ctx, input.cashSessionId);
    });
  }

  async sell(ctx, key, raw) {
    object(raw, ['storeId', 'cashSessionId', 'items', 'discountCents', 'discountReason', 'tenderedCents', 'paymentMethod']);
    requireThat(Array.isArray(raw.items) && raw.items.length > 0 && raw.items.length <= 100,
      400, 'INVALID_ITEMS', 'Informe entre 1 e 100 produtos.');
    const items = raw.items.map(item => {
      object(item, ['productId', 'quantity']);
      return { productId: id(item.productId), quantity: integer(item.quantity, 'Quantidade', 1, 10_000) };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    requireThat(new Set(items.map(item => item.productId)).size === items.length,
      400, 'DUPLICATE_ITEM', 'Agrupe a quantidade do mesmo produto em uma única linha.');
    const paymentMethod = text(raw.paymentMethod ?? 'CASH', 'Forma de pagamento', 20).toUpperCase();
    requireThat(PAYMENT_METHODS.has(paymentMethod), 400, 'INVALID_PAYMENT_METHOD', 'Forma de pagamento invalida.');
    const input = {
      storeId: id(raw.storeId), cashSessionId: id(raw.cashSessionId), items, paymentMethod,
      discountCents: integer(raw.discountCents ?? 0, 'Desconto'),
      discountReason: raw.discountReason ? text(raw.discountReason, 'Motivo', 200) : null,
      tenderedCents: paymentMethod === 'CASH' ? integer(raw.tenderedCents, 'Valor entregue', 1) : 0
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
      const tenderedCents = input.paymentMethod === 'CASH' ? input.tenderedCents : total;
      const changeCents = input.paymentMethod === 'CASH' ? input.tenderedCents - total : 0;
      requireThat(total > 0 && (input.paymentMethod !== 'CASH' || input.tenderedCents >= total), 400, 'INSUFFICIENT_CASH', 'Valor entregue menor que o total da venda.');
      requireThat(input.paymentMethod !== 'CASH' || cash.expected_cents + total <= MAX_MONEY, 409, 'CASH_LIMIT', 'Limite monetario do caixa atingido neste laboratorio.');
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
        VALUES($1,$2,$3,'CONFIRMED',$4,$5,$6)`,
      ctx.tenantId, saleId, input.paymentMethod, total, tenderedCents, changeCents);
      if (input.paymentMethod === 'CASH') {
        await tx.run(`INSERT INTO cash_movements
          (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,$5,'SALE',$6,'Venda em dinheiro',$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, input.cashSessionId, saleId, total, ctx.userId, now());
      }
      await tx.audit(ctx, input.storeId, 'SALE_CONFIRMED', saleId,
        { totalCents: total, paymentMethod: input.paymentMethod, discountCents: input.discountCents, discountReason: input.discountReason });
      return tx.receipt(ctx, saleId);
    });
  }

  async cancelSale(ctx, key, raw) {
    object(raw, ['storeId', 'saleId', 'reason']);
    const input = { storeId: id(raw.storeId), saleId: id(raw.saleId), reason: text(raw.reason, 'Motivo', 200, 3) };
    return this.#mutate(ctx, 'SALE_CANCEL', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente cancela venda confirmada.');
      const sale = await tx.one(`SELECT s.*,p.method,p.amount_cents FROM sales s
        JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
        WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 FOR UPDATE OF s FOR SHARE OF p`,
      ctx.tenantId, input.storeId, input.saleId);
      requireThat(sale, 404, 'SALE_NOT_FOUND', 'Venda não encontrada nesta loja.');
      const previous = await tx.one('SELECT 1 FROM sale_cancellations WHERE tenant_id=$1 AND sale_id=$2 FOR UPDATE',
        ctx.tenantId, input.saleId);
      requireThat(!previous, 409, 'SALE_ALREADY_CANCELED', 'Venda já cancelada.');
      const cash = await tx.cash(ctx, sale.cash_session_id, { lock: true });
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Abra o caixa da venda antes de cancelar.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'O cancelamento deve ser feito pelo operador do caixa aberto.');
      const items = await tx.all(`SELECT product_id,quantity FROM sale_items
        WHERE tenant_id=$1 AND sale_id=$2 ORDER BY product_id`, ctx.tenantId, input.saleId);
      for (const item of items) {
        const changed = await tx.run(`UPDATE stock SET quantity=quantity+$1
          WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity+$1 BETWEEN 0 AND 1000000`,
        item.quantity, ctx.tenantId, input.storeId, item.product_id);
        requireThat(changed.changes === 1, 409, 'STOCK_LIMIT', 'Cancelamento deixaria o estoque fora do limite permitido.');
        await tx.run(`INSERT INTO stock_movements
          (tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, item.product_id, item.quantity, `Cancelamento de venda: ${input.reason}`, ctx.userId, now());
      }
      if (sale.method === 'CASH') {
        requireThat(cash.expected_cents - cashInteger(sale.amount_cents) >= 0, 409, 'CASH_NEGATIVE', 'Dinheiro esperado insuficiente para estornar esta venda.');
        await tx.run(`INSERT INTO cash_movements
          (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,'WITHDRAWAL',$5,$6,$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, sale.cash_session_id, -cashInteger(sale.amount_cents), `Cancelamento de venda: ${input.reason}`, ctx.userId, now());
      }
      await tx.run(`INSERT INTO sale_cancellations
        (tenant_id,sale_id,store_id,cash_session_id,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
      ctx.tenantId, input.saleId, input.storeId, sale.cash_session_id, input.reason, ctx.userId, now());
      await tx.audit(ctx, input.storeId, 'SALE_CANCELED', input.saleId,
        { reason: input.reason, paymentMethod: sale.method, totalCents: cashInteger(sale.total_cents) });
      return tx.receipt(ctx, input.saleId);
    });
  }
}
