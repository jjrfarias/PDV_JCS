import { randomUUID } from 'node:crypto';
import { all, one, run, withPostgresTransaction } from './postgres.mjs';
import { PostgresProducts } from './postgres-products.mjs';
import { PostgresOperations } from './postgres-operations.mjs';
import { decryptField, encryptField, fieldDigest, hashPassword, sha256 } from './security.mjs';
import { AppError, requireThat, object, text, integer, id, operationKey } from './errors.mjs';
import { hourlySales } from './pos.mjs';
import { reportRange } from './time.mjs';
import { customerSummary } from './privacy.mjs';
import { createMailer } from './mailer.mjs';

const now = () => new Date().toISOString();
const MAX_MONEY = 100_000_000;
const INVITE_TTL_MS = 24 * 60 * 60_000;
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
function saleReturnInput(raw) {
  object(raw, ['storeId', 'saleId', 'items', 'reason']);
  requireThat(Array.isArray(raw.items) && raw.items.length > 0 && raw.items.length <= 100,
    400, 'INVALID_ITEMS', 'Informe os produtos para devolução.');
  const items = raw.items.map(item => {
    object(item, ['productId', 'quantity']);
    return { productId: id(item.productId), quantity: integer(item.quantity, 'Quantidade', 1, 10_000) };
  }).sort((a, b) => a.productId.localeCompare(b.productId));
  requireThat(new Set(items.map(item => item.productId)).size === items.length,
    400, 'DUPLICATE_ITEM', 'Agrupe a quantidade do mesmo produto em uma única linha.');
  return { storeId: id(raw.storeId), saleId: id(raw.saleId), items, reason: text(raw.reason, 'Motivo', 200, 3) };
}
function proratedReturnCents(sale, lineCents) {
  return integer(Math.floor(lineCents * cashInteger(sale.total_cents) / cashInteger(sale.subtotal_cents)), 'Total da devolução', 1);
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
    const user = await this.one(`SELECT id,name,email,role,company_admin,mfa_enabled FROM users
      WHERE tenant_id=$1 AND id=$2 AND active=1${this.readOnly ? '' : ' FOR SHARE'}`, ctx.tenantId, ctx.userId);
    requireThat(user, 401, 'AUTH_REQUIRED', 'Faça login novamente.');
    return user;
  }

  async authorize(ctx, storeId) {
    const user = await this.user(ctx);
    const membership = await this.one(`SELECT role FROM memberships
      WHERE tenant_id=$1 AND user_id=$2 AND store_id=$3 AND active=1${this.readOnly ? '' : ' FOR SHARE'}`,
    ctx.tenantId, ctx.userId, storeId);
    requireThat(membership, 403, 'STORE_FORBIDDEN', 'Você não tem acesso a esta loja.');
    // Loja desativada não opera: venda, caixa, estoque e cadastros ficam bloqueados.
    requireThat(await this.one('SELECT 1 FROM stores WHERE tenant_id=$1 AND id=$2 AND active=1', ctx.tenantId, storeId), 403, 'STORE_INACTIVE', 'Esta loja está desativada.');
    // O perfil vale só para esta loja; account_role é o resumo da conta.
    return { ...user, account_role: user.role, role: membership.role };
  }

  async me(ctx) {
    return {
      user: await this.user(ctx), tenantId: ctx.tenantId,
      stores: await this.all(`SELECT s.id,s.name,m.role FROM stores s
        JOIN memberships m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
        WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active=1 AND s.active=1 ORDER BY s.name`, ctx.tenantId, ctx.userId)
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

  async cashDetail(ctx, cashId) {
    const cash = await this.cash(ctx, cashId);
    const terminal = await this.one('SELECT name FROM terminals WHERE tenant_id=$1 AND id=$2', ctx.tenantId, cash.terminal_id);
    const operator = await this.one('SELECT name FROM users WHERE tenant_id=$1 AND id=$2', ctx.tenantId, cash.operator_id);
    const movements = (await this.all(`SELECT m.kind,m.amount_cents,m.reason,m.created_at,u.name actor_name
      FROM cash_movements m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
      WHERE m.tenant_id=$1 AND m.cash_session_id=$2 ORDER BY m.created_at`, ctx.tenantId, cash.id))
      .map(row => ({ ...row, amount_cents: cashInteger(row.amount_cents) }));
    const sales = (await this.all(`SELECT s.id,s.created_at,s.total_cents,p.method,
        x.created_at canceled_at,COALESCE(SUM(r.total_cents),0) returned_cents
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.cash_session_id=$2
      GROUP BY s.id,s.created_at,s.total_cents,p.method,x.created_at
      ORDER BY s.created_at`, ctx.tenantId, cash.id))
      .map(row => ({ ...row, total_cents: cashInteger(row.total_cents), returned_cents: cashInteger(row.returned_cents) }));
    return { cash: { ...cash, terminal_name: terminal?.name ?? cash.terminal_id, operator_name: operator?.name ?? cash.operator_id }, movements, sales };
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
      returns: (await this.all(`SELECT r.id,r.total_cents,r.reason,r.payment_method,r.created_at,u.name actor_name
        FROM sale_returns r JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.actor_id
        WHERE r.tenant_id=$1 AND r.sale_id=$2 ORDER BY r.created_at`, ctx.tenantId, saleId))
        .map(row => ({ ...row, total_cents: cashInteger(row.total_cents) })),
      return_items: (await this.all(`SELECT i.return_id,i.product_id,i.quantity,i.amount_cents,p.name_snapshot
        FROM sale_return_items i JOIN sale_items p ON p.tenant_id=i.tenant_id AND p.sale_id=i.sale_id AND p.product_id=i.product_id
        WHERE i.tenant_id=$1 AND i.sale_id=$2 ORDER BY p.sku_snapshot`, ctx.tenantId, saleId))
        .map(row => ({ ...row, quantity: cashInteger(row.quantity), amount_cents: cashInteger(row.amount_cents) })),
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
      users: (await this.authorize(ctx, storeId)).role === 'MANAGER'
        ? (await this.all(`SELECT u.id,u.email,u.name,m.role,u.company_admin,m.active,
            (SELECT COUNT(*) FROM memberships o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.store_id<>m.store_id AND o.active=1) other_stores,
            (SELECT COUNT(*) FROM memberships o WHERE o.tenant_id=u.tenant_id AND o.user_id=u.id AND o.store_id<>m.store_id AND o.active=1
            AND NOT EXISTS(SELECT 1 FROM memberships e WHERE e.tenant_id=o.tenant_id AND e.user_id=$3 AND e.store_id=o.store_id AND e.active=1 AND e.role='MANAGER')) locked_stores
          FROM users u JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
          WHERE u.tenant_id=$1 AND m.store_id=$2 ORDER BY m.active DESC,u.name`, ctx.tenantId, storeId, ctx.userId)).map(row => ({ ...row, other_stores: Number(row.other_stores), locked_stores: Number(row.locked_stores) }))
        : [],
      customers: (await this.all(`SELECT * FROM customers
        WHERE tenant_id=$1 AND store_id=$2 ORDER BY updated_at DESC LIMIT 100`, ctx.tenantId, storeId))
        .map(row => customerSummary(this.customerRow(row))),
      cash,
      sales: (await this.all(`SELECT s.id,s.customer_id,s.total_cents,s.discount_cents,s.created_at,u.name operator_name,c.terminal_id,t.name terminal_name,
          x.created_at canceled_at,x.reason cancel_reason,COALESCE(SUM(r.total_cents),0) returned_cents
        FROM sales s
        JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
        JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
        JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
        LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
        LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
        WHERE s.tenant_id=$1 AND s.store_id=$2
        GROUP BY s.id,s.customer_id,s.total_cents,s.discount_cents,s.created_at,u.name,c.terminal_id,t.name,x.created_at,x.reason
        ORDER BY s.created_at DESC LIMIT 30`, ctx.tenantId, storeId))
        .map(row => ({ ...row, total_cents: cashInteger(row.total_cents),
          discount_cents: cashInteger(row.discount_cents), returned_cents: cashInteger(row.returned_cents) })),
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
    const sales = await this.all(`SELECT s.id,s.created_at,s.customer_id,s.total_cents,s.discount_cents,p.method,u.name operator_name,t.name terminal_name,
        x.created_at canceled_at,x.reason cancel_reason,COALESCE(SUM(r.total_cents),0) returned_cents
      FROM sales s
      JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.operator_id
      JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.id=s.cash_session_id
      JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4
      GROUP BY s.id,s.created_at,s.customer_id,s.total_cents,s.discount_cents,p.method,u.name,t.name,x.created_at,x.reason
      ORDER BY s.created_at`, ctx.tenantId, storeId, range.start, range.end);
    const normalizedSales = sales.map(sale => ({ ...sale,
      total_cents: cashInteger(sale.total_cents), discount_cents: cashInteger(sale.discount_cents),
      returned_cents: cashInteger(sale.returned_cents) }));
    const active = normalizedSales.filter(sale => !sale.canceled_at);
    const summary = {
      sale_count: normalizedSales.length, active_sale_count: active.length,
      canceled_sale_count: normalizedSales.length - active.length,
      gross_cents: active.reduce((sum, sale) => sum + sale.total_cents - sale.returned_cents, 0),
      discount_cents: active.reduce((sum, sale) => sum + sale.discount_cents, 0),
      canceled_cents: normalizedSales.filter(sale => sale.canceled_at).reduce((sum, sale) => sum + sale.total_cents, 0),
      returned_cents: active.reduce((sum, sale) => sum + sale.returned_cents, 0)
    };
    const payments = (await this.all(`SELECT p.method,COUNT(*) sale_count,COALESCE(SUM(p.amount_cents-COALESCE(r.returned_cents,0)),0) amount_cents
      FROM sales s JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN (SELECT tenant_id,sale_id,SUM(total_cents) returned_cents FROM sale_returns GROUP BY tenant_id,sale_id) r
        ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4 AND x.sale_id IS NULL
      GROUP BY p.method ORDER BY p.method`, ctx.tenantId, storeId, range.start, range.end))
      .map(row => ({ ...row, sale_count: cashInteger(row.sale_count), amount_cents: cashInteger(row.amount_cents) }));
    const products = (await this.all(`SELECT i.product_id,i.sku_snapshot sku,i.name_snapshot name,COALESCE(SUM(i.quantity-COALESCE(r.quantity,0)),0) quantity,
        COALESCE(SUM(i.line_cents-COALESCE(r.amount_cents,0)),0) total_cents
      FROM sales s JOIN sale_items i ON i.tenant_id=s.tenant_id AND i.sale_id=s.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
      LEFT JOIN (SELECT tenant_id,sale_id,product_id,SUM(quantity) quantity,SUM(amount_cents) amount_cents
        FROM sale_return_items GROUP BY tenant_id,sale_id,product_id) r
        ON r.tenant_id=i.tenant_id AND r.sale_id=i.sale_id AND r.product_id=i.product_id
      WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.created_at>=$3 AND s.created_at<$4 AND x.sale_id IS NULL
      GROUP BY i.product_id,i.sku_snapshot,i.name_snapshot HAVING COALESCE(SUM(i.quantity-COALESCE(r.quantity,0)),0)>0
      ORDER BY total_cents DESC,name LIMIT 50`,
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

  async networkOverview(ctx, from, to) {
    const me = await this.me(ctx);
    // A rede mostra só as lojas em que a pessoa é gerente.
    me.stores = me.stores.filter(store => store.role === 'MANAGER');
    requireThat(me.stores.length > 0, 403, 'MANAGER_REQUIRED', 'Somente gerente acompanha a rede de lojas.');
    const range = reportRange(from, to);
    // Uma consulta para toda a rede evita dezenas de idas sequenciais ao PostgreSQL (uma série por loja).
    const sales = (await this.all(`SELECT s.store_id,s.id,s.created_at,s.total_cents,s.discount_cents,p.method,
          x.created_at canceled_at,COALESCE(SUM(r.total_cents),0) returned_cents
        FROM sales s
        JOIN memberships m ON m.tenant_id=s.tenant_id AND m.store_id=s.store_id AND m.user_id=$2
        JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
        LEFT JOIN sale_cancellations x ON x.tenant_id=s.tenant_id AND x.sale_id=s.id
        LEFT JOIN sale_returns r ON r.tenant_id=s.tenant_id AND r.sale_id=s.id
        WHERE s.tenant_id=$1 AND s.created_at>=$3 AND s.created_at<$4
        GROUP BY s.store_id,s.id,s.created_at,s.total_cents,s.discount_cents,p.method,x.created_at
        ORDER BY s.created_at`, ctx.tenantId, ctx.userId, range.start, range.end)).map(sale => ({ ...sale,
      created_at: sale.created_at instanceof Date ? sale.created_at.toISOString() : sale.created_at,
      canceled_at: sale.canceled_at instanceof Date ? sale.canceled_at.toISOString() : sale.canceled_at,
      total_cents: cashInteger(sale.total_cents), discount_cents: cashInteger(sale.discount_cents),
      returned_cents: cashInteger(sale.returned_cents) }));
    const openCash = new Map((await this.all(`SELECT c.store_id,COUNT(*) open_cash_count
        FROM cash_sessions c
        JOIN memberships m ON m.tenant_id=c.tenant_id AND m.store_id=c.store_id AND m.user_id=$2
        WHERE c.tenant_id=$1 AND c.status='OPEN' GROUP BY c.store_id`, ctx.tenantId, ctx.userId))
      .map(row => [row.store_id, cashInteger(row.open_cash_count)]));
    const stores = me.stores.map(store => {
      const storeSales = sales.filter(sale => sale.store_id === store.id), active = storeSales.filter(sale => !sale.canceled_at);
      const storePayments = new Map();
      for (const sale of active) {
        const payment = storePayments.get(sale.method) ?? { method: sale.method, sale_count: 0, amount_cents: 0 };
        payment.sale_count++; payment.amount_cents += sale.total_cents - sale.returned_cents; storePayments.set(sale.method, payment);
      }
      return { ...store,
        sale_count: storeSales.length, active_sale_count: active.length, canceled_sale_count: storeSales.length - active.length,
        gross_cents: active.reduce((sum, sale) => sum + sale.total_cents - sale.returned_cents, 0),
        discount_cents: active.reduce((sum, sale) => sum + sale.discount_cents, 0),
        canceled_cents: storeSales.filter(sale => sale.canceled_at).reduce((sum, sale) => sum + sale.total_cents, 0),
        returned_cents: active.reduce((sum, sale) => sum + sale.returned_cents, 0),
        open_cash_count: openCash.get(store.id) ?? 0,
        last_sale_at: storeSales.at(-1)?.created_at ?? null,
        payments: [...storePayments.values()], hourly: hourlySales(storeSales) };
    });
    const payments = new Map();
    for (const store of stores) for (const payment of store.payments) {
      const current = payments.get(payment.method) ?? { method: payment.method, sale_count: 0, amount_cents: 0 };
      current.sale_count += Number(payment.sale_count); current.amount_cents += Number(payment.amount_cents); payments.set(payment.method, current);
    }
    const totals = stores.reduce((sum, store) => ({
      sale_count: sum.sale_count + store.sale_count, active_sale_count: sum.active_sale_count + store.active_sale_count,
      canceled_sale_count: sum.canceled_sale_count + store.canceled_sale_count, gross_cents: sum.gross_cents + store.gross_cents,
      discount_cents: sum.discount_cents + store.discount_cents, returned_cents: sum.returned_cents + store.returned_cents,
      open_cash_count: sum.open_cash_count + store.open_cash_count
    }), { sale_count: 0, active_sale_count: 0, canceled_sale_count: 0, gross_cents: 0, discount_cents: 0, returned_cents: 0, open_cash_count: 0 });
    return { generated_at: now(), range, totals: { ...totals,
      ticket_average_cents: totals.active_sale_count ? Math.round(totals.gross_cents / totals.active_sale_count) : 0 },
    payments: [...payments.values()], hourly: hourlySales(sales), stores };
  }

  async stockLookup(ctx, query = '') {
    await this.user(ctx);
    const term = String(query ?? '').trim().slice(0, 120);
    const pattern = `%${term.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = await this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,
        s.id store_id,s.name store_name,st.quantity,
        COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved_quantity, st.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) available_quantity
      FROM products p
      JOIN stock st ON st.tenant_id=p.tenant_id AND st.product_id=p.id
      JOIN stores s ON s.tenant_id=st.tenant_id AND s.id=st.store_id
      WHERE p.tenant_id=$1 AND p.active=1 AND s.active=1
        AND ($2='' OR p.name ILIKE $3 ESCAPE '\\' OR p.sku ILIKE $3 ESCAPE '\\' OR COALESCE(p.barcode,'') ILIKE $3 ESCAPE '\\')
      ORDER BY p.name,s.name LIMIT 250`, ctx.tenantId, term, pattern);
    const products = new Map();
    for (const row of rows) {
      const product = products.get(row.id) ?? { id: row.id, sku: row.sku, barcode: row.barcode,
        name: row.name, price_cents: cashInteger(row.price_cents), total_quantity: 0, stores: [] };
      const quantity = cashInteger(row.quantity), reserved_quantity = cashInteger(row.reserved_quantity), available_quantity = quantity - reserved_quantity;
      product.total_quantity += quantity; product.total_available_quantity = (product.total_available_quantity ?? 0) + available_quantity;
      product.stores.push({ id: row.store_id, name: row.store_name, quantity, reserved_quantity, available_quantity });
      products.set(row.id, product);
    }
    return { query: term, products: [...products.values()] };
  }

  async networkOperations(ctx, from, to) {
    const me = await this.me(ctx), stores = me.stores.filter(store => store.role === 'MANAGER');
    requireThat(stores.length > 0, 403, 'MANAGER_REQUIRED', 'Somente gerente acompanha a operação da rede.');
    const range = reportRange(from, to);
    const membership = `JOIN memberships access ON access.tenant_id=$1 AND access.user_id=$2 AND access.store_id=s.id AND access.active=1 AND access.role='MANAGER'`;
    const stock = (await this.all(`SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.id store_id,s.name store_name,st.quantity, COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved_quantity, st.quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=st.tenant_id AND r.pickup_store_id=st.store_id AND r.product_id=st.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0) available_quantity
      FROM stores s ${membership}
      JOIN stock st ON st.tenant_id=s.tenant_id AND st.store_id=s.id
      JOIN products p ON p.tenant_id=st.tenant_id AND p.id=st.product_id
      WHERE s.tenant_id=$1 AND s.active=1 AND p.active=1 ORDER BY p.name,s.name`, ctx.tenantId, ctx.userId))
      .map(row => { const quantity=cashInteger(row.quantity),reserved_quantity=cashInteger(row.reserved_quantity);return {...row,price_cents:cashInteger(row.price_cents),quantity,reserved_quantity,available_quantity:quantity-reserved_quantity}; });
    const movements = (await this.all(`SELECT m.id,m.created_at,m.kind,m.quantity,m.reason,p.sku,p.name,
        s.id store_id,s.name store_name,u.name actor_name
      FROM stores s ${membership}
      JOIN stock_movements m ON m.tenant_id=s.tenant_id AND m.store_id=s.id
      JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
      JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.actor_id
      WHERE s.tenant_id=$1 AND m.created_at>=$3 AND m.created_at<$4
      ORDER BY m.created_at DESC LIMIT 300`, ctx.tenantId, ctx.userId, range.start, range.end))
      .map(row => ({ ...row, quantity: cashInteger(row.quantity), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at }));
    const sales = (await this.all(`SELECT sale.id,sale.created_at,sale.total_cents,sale.discount_cents,
        s.id store_id,s.name store_name,u.name operator_name,pay.method,x.created_at canceled_at,
        COALESCE(SUM(ret.total_cents),0) returned_cents
      FROM stores s ${membership}
      JOIN sales sale ON sale.tenant_id=s.tenant_id AND sale.store_id=s.id
      JOIN users u ON u.tenant_id=sale.tenant_id AND u.id=sale.operator_id
      JOIN payments pay ON pay.tenant_id=sale.tenant_id AND pay.sale_id=sale.id
      LEFT JOIN sale_cancellations x ON x.tenant_id=sale.tenant_id AND x.sale_id=sale.id
      LEFT JOIN sale_returns ret ON ret.tenant_id=sale.tenant_id AND ret.sale_id=sale.id
      WHERE s.tenant_id=$1 AND sale.created_at>=$3 AND sale.created_at<$4
      GROUP BY sale.id,sale.created_at,sale.total_cents,sale.discount_cents,s.id,s.name,u.name,pay.method,x.created_at
      ORDER BY sale.created_at DESC LIMIT 300`, ctx.tenantId, ctx.userId, range.start, range.end))
      .map(row => ({ ...row, total_cents: cashInteger(row.total_cents), discount_cents: cashInteger(row.discount_cents),
        returned_cents: cashInteger(row.returned_cents), created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        canceled_at: row.canceled_at instanceof Date ? row.canceled_at.toISOString() : row.canceled_at }));
    const closures = (await this.all(`SELECT c.id,c.closed_at,c.expected_cents,c.counted_cents,c.difference_cents,c.close_reason,
        s.id store_id,s.name store_name,t.name terminal_name,u.name operator_name
      FROM stores s ${membership}
      JOIN cash_sessions c ON c.tenant_id=s.tenant_id AND c.store_id=s.id
      JOIN terminals t ON t.tenant_id=c.tenant_id AND t.id=c.terminal_id
      JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.operator_id
      WHERE s.tenant_id=$1 AND c.status='CLOSED' AND c.closed_at>=$3 AND c.closed_at<$4
      ORDER BY c.closed_at DESC LIMIT 300`, ctx.tenantId, ctx.userId, range.start, range.end))
      .map(row => ({ ...row, expected_cents: cashInteger(row.expected_cents), counted_cents: cashInteger(row.counted_cents),
        difference_cents: cashInteger(row.difference_cents), closed_at: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at }));
    const transfers=(await this.all(`SELECT x.*,p.sku,p.name product_name,o.name origin_name,d.name destination_name,u.name requested_by_name
      FROM stock_transfers x JOIN products p ON p.tenant_id=x.tenant_id AND p.id=x.product_id
      JOIN stores o ON o.tenant_id=x.tenant_id AND o.id=x.origin_store_id JOIN stores d ON d.tenant_id=x.tenant_id AND d.id=x.destination_store_id
      JOIN users u ON u.tenant_id=x.tenant_id AND u.id=x.requested_by
      WHERE x.tenant_id=$1 AND (x.created_at>=$3 AND x.created_at<$4 OR x.status IN('REQUESTED','APPROVED','IN_TRANSIT'))
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=x.tenant_id AND m.user_id=$2 AND m.active=1 AND m.role='MANAGER' AND m.store_id IN(x.origin_store_id,x.destination_store_id))
      ORDER BY CASE x.status WHEN 'IN_TRANSIT' THEN 1 WHEN 'REQUESTED' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END,x.created_at DESC LIMIT 300`,ctx.tenantId,ctx.userId,range.start,range.end))
      .map(row=>({...row,quantity:cashInteger(row.quantity),created_at:row.created_at instanceof Date?row.created_at.toISOString():row.created_at}));
    const reservations=(await this.all(`SELECT r.*,p.sku,p.name product_name,requesting.name requesting_store_name,pickup.name pickup_store_name,u.name requested_by_name,c.name_enc customer_name_enc
      FROM stock_reservations r JOIN products p ON p.tenant_id=r.tenant_id AND p.id=r.product_id
      JOIN stores requesting ON requesting.tenant_id=r.tenant_id AND requesting.id=r.requesting_store_id
      JOIN stores pickup ON pickup.tenant_id=r.tenant_id AND pickup.id=r.pickup_store_id
      JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.requested_by JOIN customers c ON c.tenant_id=r.tenant_id AND c.id=r.customer_id
      WHERE r.tenant_id=$1 AND (r.created_at>=$3 AND r.created_at<$4 OR r.status IN('REQUESTED','CONFIRMED'))
        AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=r.tenant_id AND m.user_id=$2 AND m.active=1 AND m.role='MANAGER' AND m.store_id IN(r.requesting_store_id,r.pickup_store_id))
      ORDER BY CASE r.status WHEN 'REQUESTED' THEN 1 WHEN 'CONFIRMED' THEN 2 ELSE 3 END,r.created_at DESC LIMIT 300`,ctx.tenantId,ctx.userId,range.start,range.end))
      .map(row=>({...row,quantity:cashInteger(row.quantity),customer_name:decryptField(row.customer_name_enc),customer_name_enc:undefined,created_at:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,expires_at:row.expires_at instanceof Date?row.expires_at.toISOString():row.expires_at}));
    return { range, stores, stock, movements, sales, closures, transfers, reservations };
  }

  async customerDetail(ctx, storeId, customerId) {
    id(storeId); id(customerId);
    await this.authorize(ctx, storeId);
    const row = await this.one('SELECT * FROM customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3', ctx.tenantId, storeId, customerId);
    requireThat(row, 404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta loja.');
    await this.audit(ctx, storeId, 'CUSTOMER_VIEWED', customerId, {});
    return this.customerRow(row);
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
  constructor(pool, hooks = {}) { this.pool = pool; this.hooks = hooks; this.mailer = hooks.mailer ?? createMailer(); }

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
  async cashDetail(ctx, cashId) { return this.#transaction(ctx, true, tx => tx.cashDetail(ctx, cashId)); }
  async receipt(ctx, saleId) { return this.#transaction(ctx, true, tx => tx.receipt(ctx, saleId)); }
  async state(ctx, storeId) { return this.#transaction(ctx, true, tx => tx.state(ctx, storeId)); }
  // Não é somente leitura: grava a auditoria da consulta.
  async customerDetail(ctx, storeId, customerId) { return this.#transaction(ctx, false, tx => tx.customerDetail(ctx, storeId, customerId)); }
  async report(ctx, storeId, from, to) { return this.#transaction(ctx, true, tx => tx.report(ctx, storeId, from, to)); }
  async networkOverview(ctx, from, to) { return this.#transaction(ctx, true, tx => tx.networkOverview(ctx, from, to)); }
  async stockLookup(ctx, query) { return this.#transaction(ctx, true, tx => tx.stockLookup(ctx, query)); }
  async networkOperations(ctx, from, to) { return this.#transaction(ctx, true, tx => tx.networkOperations(ctx, from, to)); }
  async auditReportExport(ctx, storeId, range, section) {
    id(storeId);
    return this.#transaction(ctx, false, async tx => {
      await tx.authorize(ctx, storeId);
      await tx.audit(ctx, storeId, 'REPORT_EXPORTED', storeId,
        { from: range.from, to: range.to, section });
    });
  }

  async companyStores(ctx) {
    return this.#transaction(ctx, true, async tx => {
      requireThat(Number((await tx.user(ctx)).company_admin) === 1, 403, 'COMPANY_ADMIN_REQUIRED', 'Somente o administrador da empresa gerencia lojas.');
      const rows = await tx.all(`SELECT s.id,s.name,s.active,
          (SELECT COUNT(*) FROM terminals t WHERE t.tenant_id=s.tenant_id AND t.store_id=s.id) terminal_count,
          (SELECT COUNT(*) FROM memberships m JOIN users u ON u.tenant_id=m.tenant_id AND u.id=m.user_id WHERE m.tenant_id=s.tenant_id AND m.store_id=s.id AND u.active=1) user_count,
          (SELECT COUNT(*) FROM cash_sessions c WHERE c.tenant_id=s.tenant_id AND c.store_id=s.id AND c.status='OPEN') open_cash_count
        FROM stores s WHERE s.tenant_id=$1 ORDER BY s.active DESC,s.name`, ctx.tenantId);
      return { stores: rows.map(row => ({ id: row.id, name: row.name, active: Number(row.active), terminal_count: Number(row.terminal_count), user_count: Number(row.user_count), open_cash_count: Number(row.open_cash_count) })) };
    });
  }

  async updateStore(ctx, key, raw) {
    object(raw, ['storeId', 'name', 'active']); operationKey(key);
    const input = { storeId: id(raw.storeId), name: text(raw.name, 'Nome da loja', 120, 2), active: raw.active };
    requireThat(input.active === 0 || input.active === 1, 400, 'INVALID_INPUT', 'Status inválido.');
    return this.#transaction(ctx, false, async tx => {
      requireThat(Number((await tx.user(ctx)).company_admin) === 1, 403, 'COMPANY_ADMIN_REQUIRED', 'Somente o administrador da empresa gerencia lojas.');
      const payloadHash = sha256(JSON.stringify({ kind: 'STORE_UPDATE', input })); await tx.operations.lock(ctx.tenantId, key);
      const previous = await tx.operations.find(ctx.tenantId, key);
      if (previous) {
        requireThat(previous.user_id === ctx.userId && previous.kind === 'STORE_UPDATE' && previous.payload_hash === payloadHash, 409, 'IDEMPOTENCY_CONFLICT', 'Esta chave já foi usada em outra operação ou com outros dados.');
        return { data: JSON.parse(previous.response_json), replayed: true };
      }
      const current = await tx.one('SELECT id,name,active FROM stores WHERE tenant_id=$1 AND id=$2 FOR UPDATE', ctx.tenantId, input.storeId);
      requireThat(current, 404, 'STORE_NOT_FOUND', 'Loja não encontrada.');
      requireThat(await tx.one('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND store_id=$3', ctx.tenantId, ctx.userId, input.storeId), 403, 'STORE_FORBIDDEN', 'Você não tem acesso a esta loja.');
      requireThat(!(await tx.one('SELECT 1 FROM stores WHERE tenant_id=$1 AND lower(name)=lower($2) AND id<>$3', ctx.tenantId, input.name, input.storeId)), 409, 'DUPLICATE_STORE', 'Já existe uma loja com este nome.');
      if (input.active === 0 && Number(current.active) === 1) {
        requireThat(!(await tx.one("SELECT 1 FROM cash_sessions WHERE tenant_id=$1 AND store_id=$2 AND status='OPEN'", ctx.tenantId, input.storeId)), 409, 'STORE_CASH_OPEN', 'Feche os caixas abertos desta loja antes de desativá-la.');
        requireThat(Number((await tx.one('SELECT COUNT(*) n FROM stores WHERE tenant_id=$1 AND active=1 AND id<>$2', ctx.tenantId, input.storeId)).n) > 0, 409, 'LAST_ACTIVE_STORE', 'A empresa precisa de pelo menos uma loja ativa.');
      }
      await tx.run('UPDATE stores SET name=$1,active=$2 WHERE tenant_id=$3 AND id=$4', input.name, input.active, ctx.tenantId, input.storeId);
      const action = Number(current.active) === input.active ? 'STORE_UPDATED' : input.active === 1 ? 'STORE_REACTIVATED' : 'STORE_DEACTIVATED';
      await tx.audit(ctx, input.storeId, action, input.storeId, { renamed: current.name !== input.name, active: input.active });
      const data = { store: { id: input.storeId, name: input.name, active: input.active } };
      await tx.operations.save({ tenantId: ctx.tenantId, key, userId: ctx.userId, storeId: input.storeId, kind: 'STORE_UPDATE', payloadHash, response: data });
      return { data, replayed: false };
    });
  }

  async createStore(ctx, key, raw, origin) {
    object(raw, ['name', 'managerName', 'managerEmail']); operationKey(key);
    const input={name:text(raw.name,'Nome da loja',120,2),managerName:text(raw.managerName,'Nome do gerente',120,2),managerEmail:text(raw.managerEmail,'E-mail do gerente',120).toLowerCase()};
    requireThat(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.managerEmail),400,'INVALID_EMAIL','E-mail inválido.');
    const ids={storeId:`store-${randomUUID()}`,terminalId:`terminal-${randomUUID()}`,managerId:`user-${randomUUID()}`,resetId:randomUUID()};
    const inviteToken=`${randomUUID()}${randomUUID()}`.replaceAll('-',''),createdAt=Date.now();let created=false;
    const result=await this.#transaction(ctx,false,async tx=>{
      const user=await tx.user(ctx);requireThat(Number(user.company_admin)===1,403,'COMPANY_ADMIN_REQUIRED','Somente o administrador da empresa pode criar lojas.');
      const payloadHash=sha256(JSON.stringify({kind:'STORE_CREATE',input}));await tx.operations.lock(ctx.tenantId,key);
      const previous=await tx.operations.find(ctx.tenantId,key);
      if(previous){requireThat(previous.user_id===ctx.userId&&previous.kind==='STORE_CREATE'&&previous.payload_hash===payloadHash,409,'IDEMPOTENCY_CONFLICT','Esta chave já foi usada em outra operação ou com outros dados.');return {data:JSON.parse(previous.response_json),replayed:true};}
      requireThat(!(await tx.one('SELECT 1 FROM stores WHERE tenant_id=$1 AND lower(name)=lower($2)',ctx.tenantId,input.name)),409,'DUPLICATE_STORE','Já existe uma loja com este nome.');
      requireThat(!(await tx.one('SELECT 1 FROM users WHERE tenant_id=$1 AND email=$2',ctx.tenantId,input.managerEmail)),409,'DUPLICATE_USER','E-mail já cadastrado.');
      const company=await tx.one('SELECT id,name FROM companies WHERE tenant_id=$1 ORDER BY id LIMIT 1',ctx.tenantId);requireThat(company,404,'COMPANY_NOT_FOUND','Empresa não encontrada.');
      await tx.run('INSERT INTO stores(tenant_id,id,company_id,name) VALUES($1,$2,$3,$4)',ctx.tenantId,ids.storeId,company.id,input.name);
      await tx.run('INSERT INTO terminals(tenant_id,store_id,id,name) VALUES($1,$2,$3,$4)',ctx.tenantId,ids.storeId,ids.terminalId,'Caixa 01');
      await tx.run("INSERT INTO users(tenant_id,id,email,name,password_hash,role,company_admin) VALUES($1,$2,$3,$4,$5,'MANAGER',0)",ctx.tenantId,ids.managerId,input.managerEmail,input.managerName,hashPassword(inviteToken));
      await tx.run("INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES($1,$2,$3,'MANAGER')",ctx.tenantId,ctx.userId,ids.storeId);await tx.run("INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES($1,$2,$3,'MANAGER')",ctx.tenantId,ids.managerId,ids.storeId);
      await tx.run('INSERT INTO stock(tenant_id,store_id,product_id,quantity) SELECT tenant_id,$1,id,0 FROM products WHERE tenant_id=$2',ids.storeId,ctx.tenantId);
      await tx.run('INSERT INTO password_resets(tenant_id,id,user_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',ctx.tenantId,ids.resetId,ids.managerId,sha256(inviteToken),createdAt+INVITE_TTL_MS,createdAt);
      await tx.audit(ctx,ids.storeId,'STORE_CREATED',ids.storeId,{terminalId:ids.terminalId,managerId:ids.managerId});
      const data={store:{id:ids.storeId,name:input.name},terminal:{id:ids.terminalId,name:'Caixa 01'},manager:{id:ids.managerId,name:input.managerName,email:input.managerEmail,invited:true}};
      await tx.operations.save({tenantId:ctx.tenantId,key,userId:ctx.userId,storeId:ids.storeId,kind:'STORE_CREATE',payloadHash,response:data});created=true;return {data,replayed:false};
    });
    if(created){const tenant=await this.#transaction(ctx,true,tx=>tx.one('SELECT name,slug FROM tenants WHERE id=$1',ctx.tenantId));Promise.resolve(this.mailer.sendInvite({to:input.managerEmail,link:`${origin}/#redefinir=${inviteToken}`,tenantName:tenant.name,tenantSlug:tenant.slug})).catch(()=>{});}
    return result;
  }

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

  // Resumo da conta: gerente se for gerente em alguma loja ativa; conta inativa se não restar loja.
  static async syncAccount(tx, tenantId, userId) {
    await tx.run(`UPDATE users SET
      role=CASE WHEN EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=users.tenant_id AND m.user_id=users.id AND m.active=1 AND m.role='MANAGER') THEN 'MANAGER' ELSE 'CASHIER' END,
      active=CASE WHEN EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=users.tenant_id AND m.user_id=users.id AND m.active=1) THEN 1 ELSE 0 END
      WHERE tenant_id=$1 AND id=$2`, tenantId, userId);
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
      const existing = await tx.one('SELECT id,name,email,active FROM users WHERE tenant_id=$1 AND email=$2 FOR UPDATE', ctx.tenantId, input.email);
      if (existing) {
        // Pessoa já existe na empresa: ganha acesso a esta loja com o perfil escolhido. Senha e nome não mudam.
        requireThat(!(await tx.one('SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND store_id=$3', ctx.tenantId, existing.id, input.storeId)), 409, 'DUPLICATE_USER', 'Esta pessoa já está vinculada a esta loja. Use Editar.');
        requireThat(Number(existing.active) === 1, 409, 'USER_INACTIVE', 'Esta conta está desativada. Fale com o administrador da empresa.');
        await tx.run('INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES($1,$2,$3,$4)', ctx.tenantId, existing.id, input.storeId, input.role);
        await PostgresPos.syncAccount(tx, ctx.tenantId, existing.id);
        await tx.audit(ctx, input.storeId, 'USER_LINKED', existing.id, { role: input.role });
        return { id: existing.id, email: existing.email, name: existing.name, role: input.role, active: 1, storeId: input.storeId, linked: true };
      }
      const userId = randomUUID();
      await tx.run(`INSERT INTO users(tenant_id,id,email,name,password_hash,role,active)
        VALUES($1,$2,$3,$4,$5,$6,1)`, ctx.tenantId, userId, input.email, input.name, hashPassword(input.temporaryPassword), input.role);
      await tx.run('INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES($1,$2,$3,$4)', ctx.tenantId, userId, input.storeId, input.role);
      await tx.audit(ctx, input.storeId, 'USER_CREATED', userId, { email: input.email, role: input.role });
      return { id: userId, email: input.email, name: input.name, role: input.role, active: 1, storeId: input.storeId, linked: false };
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
      const current = await tx.one(`SELECT u.id,u.name,u.email,u.company_admin,m.role,m.active FROM users u
        JOIN memberships m ON m.tenant_id=u.tenant_id AND m.user_id=u.id
        WHERE u.tenant_id=$1 AND u.id=$2 AND m.store_id=$3 FOR UPDATE OF u, m`, ctx.tenantId, input.userId, input.storeId);
      requireThat(current, 404, 'USER_NOT_FOUND', 'Usuário não encontrado nesta loja.');
      requireThat(Number(current.company_admin) !== 1, 403, 'COMPANY_ADMIN_PROTECTED', 'O administrador da empresa não pode ser alterado pela gestão da loja.');
      requireThat(!(input.userId === ctx.userId && input.active === 0), 400, 'SELF_DEACTIVATE_FORBIDDEN', 'Não é permitido remover seu próprio acesso.');
      requireThat(!(input.userId === ctx.userId && input.role !== 'MANAGER'), 400, 'SELF_ROLE_CHANGE_FORBIDDEN', 'Não é permitido remover seu próprio perfil de gerente.');
      const identityChanged = input.email !== current.email || input.name !== current.name || Boolean(input.temporaryPassword);
      if (identityChanged && Number(user.company_admin) !== 1) {
        // Nome, e-mail e senha são da pessoa: só muda quem gerencia todas as lojas dela.
        const elsewhere = await tx.one(`SELECT 1 FROM memberships o WHERE o.tenant_id=$1 AND o.user_id=$2 AND o.store_id<>$3 AND o.active=1
          AND NOT EXISTS(SELECT 1 FROM memberships e WHERE e.tenant_id=o.tenant_id AND e.user_id=$4 AND e.store_id=o.store_id AND e.active=1 AND e.role='MANAGER')`,
        ctx.tenantId, input.userId, input.storeId, ctx.userId);
        requireThat(!elsewhere, 403, 'USER_SHARED', 'Esta pessoa também trabalha em outra loja. Nome, e-mail e senha só podem ser alterados pelo administrador da empresa.');
      }
      requireThat(!(await tx.one('SELECT 1 FROM users WHERE tenant_id=$1 AND email=$2 AND id<>$3', ctx.tenantId, input.email, input.userId)), 409, 'DUPLICATE_USER', 'E-mail já cadastrado.');
      const passwordHash = input.temporaryPassword ? hashPassword(input.temporaryPassword) : null;
      if (identityChanged) await tx.run('UPDATE users SET email=$1,name=$2 WHERE tenant_id=$3 AND id=$4', input.email, input.name, ctx.tenantId, input.userId);
      if (passwordHash) await tx.run('UPDATE users SET password_hash=$1 WHERE tenant_id=$2 AND id=$3', passwordHash, ctx.tenantId, input.userId);
      await tx.run('UPDATE memberships SET role=$1,active=$2 WHERE tenant_id=$3 AND user_id=$4 AND store_id=$5', input.role, input.active, ctx.tenantId, input.userId, input.storeId);
      await PostgresPos.syncAccount(tx, ctx.tenantId, input.userId);
      if (passwordHash || input.active !== Number(current.active) || current.role !== input.role) {
        await tx.run('DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', ctx.tenantId, input.userId);
      }
      await tx.audit(ctx, input.storeId, 'USER_UPDATED', input.userId,
        { role: input.role, access: input.active, identityChanged, passwordReset: Boolean(passwordHash) });
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

  async transferStock(ctx, key, raw) {
    const action = String(raw?.action ?? 'REQUEST').toUpperCase();
    if (action === 'REQUEST') {
      object(raw, ['action','storeId','originStoreId','destinationStoreId','productId','quantity','note']);
      const input = { action, storeId:id(raw.storeId), originStoreId:id(raw.originStoreId), destinationStoreId:id(raw.destinationStoreId),
        productId:id(raw.productId), quantity:integer(raw.quantity,'Quantidade',1,10000), note:raw.note?text(raw.note,'Observação',200):null };
      requireThat(input.storeId === input.destinationStoreId,400,'INVALID_INPUT','A solicitação deve partir da loja de destino.');
      requireThat(input.originStoreId !== input.destinationStoreId,400,'INVALID_INPUT','Escolha lojas diferentes.');
      return this.#mutate(ctx,'TRANSFER_REQUEST',key,input,async(tx,user)=>{
        requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente solicita transferência.');
        const product=await tx.one(`SELECT p.name,o.quantity origin_quantity FROM products p
          JOIN stock o ON o.tenant_id=p.tenant_id AND o.product_id=p.id AND o.store_id=$1
          JOIN stock d ON d.tenant_id=p.tenant_id AND d.product_id=p.id AND d.store_id=$2
          WHERE p.tenant_id=$3 AND p.id=$4 AND p.active=1 FOR UPDATE OF o,d`,input.originStoreId,input.destinationStoreId,ctx.tenantId,input.productId);
        requireThat(product,404,'PRODUCT_NOT_FOUND','Produto não disponível nas duas lojas.');requireThat(cashInteger(product.origin_quantity)>=input.quantity,409,'INSUFFICIENT_STOCK','A loja de origem não possui saldo suficiente.');
        const transferId=randomUUID(),createdAt=now();await tx.run(`INSERT INTO stock_transfers
          (tenant_id,id,origin_store_id,destination_store_id,product_id,quantity,status,note,requested_by,created_at)
          VALUES($1,$2,$3,$4,$5,$6,'REQUESTED',$7,$8,$9)`,ctx.tenantId,transferId,input.originStoreId,input.destinationStoreId,input.productId,input.quantity,input.note,ctx.userId,createdAt);
        await tx.audit(ctx,input.destinationStoreId,'TRANSFER_REQUESTED',transferId,{originStoreId:input.originStoreId,productId:input.productId,quantity:input.quantity});
        return {id:transferId,status:'REQUESTED',productName:product.name};
      });
    }
    object(raw,['action','storeId','transferId']);const input={action,storeId:id(raw.storeId),transferId:id(raw.transferId)};
    return this.#mutate(ctx,`TRANSFER_${action}`,key,input,async(tx,user)=>{
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente movimenta transferências.');
      const transfer=await tx.one('SELECT * FROM stock_transfers WHERE tenant_id=$1 AND id=$2 FOR UPDATE',ctx.tenantId,input.transferId);requireThat(transfer,404,'TRANSFER_NOT_FOUND','Transferência não encontrada.');const timestamp=now();
      if(action==='APPROVE'){requireThat(input.storeId===transfer.origin_store_id,403,'STORE_FORBIDDEN','A loja de origem deve aprovar.');requireThat(transfer.status==='REQUESTED',409,'TRANSFER_STATUS','Esta transferência não aguarda aprovação.');await tx.run("UPDATE stock_transfers SET status='APPROVED',approved_by=$1,approved_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.transferId);}
      else if(action==='SHIP'){requireThat(input.storeId===transfer.origin_store_id,403,'STORE_FORBIDDEN','A loja de origem deve enviar.');requireThat(transfer.status==='APPROVED',409,'TRANSFER_STATUS','A transferência precisa estar aprovada.');const changed=await tx.run(`UPDATE stock SET quantity=quantity-$1 WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity-COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r WHERE r.tenant_id=stock.tenant_id AND r.pickup_store_id=stock.store_id AND r.product_id=stock.product_id AND r.status='CONFIRMED' AND r.expires_at>CURRENT_TIMESTAMP),0)>=$1`,transfer.quantity,ctx.tenantId,transfer.origin_store_id,transfer.product_id);requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo insuficiente na loja de origem.');await tx.run("UPDATE stock_transfers SET status='IN_TRANSIT',shipped_by=$1,shipped_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.transferId);await tx.run(`INSERT INTO stock_movements(tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at) VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,ctx.tenantId,randomUUID(),transfer.origin_store_id,transfer.product_id,-cashInteger(transfer.quantity),`Transferência enviada ${transfer.id}`,ctx.userId,timestamp);}
      else if(action==='RECEIVE'){requireThat(input.storeId===transfer.destination_store_id,403,'STORE_FORBIDDEN','A loja de destino deve receber.');requireThat(transfer.status==='IN_TRANSIT',409,'TRANSFER_STATUS','A transferência ainda não foi enviada.');await tx.run('UPDATE stock SET quantity=quantity+$1 WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4',transfer.quantity,ctx.tenantId,transfer.destination_store_id,transfer.product_id);await tx.run("UPDATE stock_transfers SET status='RECEIVED',received_by=$1,received_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.transferId);await tx.run(`INSERT INTO stock_movements(tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at) VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,ctx.tenantId,randomUUID(),transfer.destination_store_id,transfer.product_id,cashInteger(transfer.quantity),`Transferência recebida ${transfer.id}`,ctx.userId,timestamp);}
      else if(action==='CANCEL'){requireThat(input.storeId===transfer.origin_store_id||input.storeId===transfer.destination_store_id,403,'STORE_FORBIDDEN','Somente uma loja envolvida pode cancelar.');requireThat(['REQUESTED','APPROVED'].includes(transfer.status),409,'TRANSFER_STATUS','Transferência enviada não pode ser cancelada.');await tx.run("UPDATE stock_transfers SET status='CANCELED',canceled_by=$1,canceled_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.transferId);}
      else throw new AppError(400,'INVALID_INPUT','Ação de transferência inválida.');
      const status=action==='APPROVE'?'APPROVED':action==='SHIP'?'IN_TRANSIT':action==='RECEIVE'?'RECEIVED':'CANCELED';await tx.audit(ctx,input.storeId,`TRANSFER_${status}`,input.transferId,{status});return {id:input.transferId,status};
    });
  }

  async reserveStock(ctx, key, raw) {
    const action = String(raw?.action ?? 'REQUEST').toUpperCase();
    if (action === 'REQUEST') {
      object(raw, ['action','storeId','pickupStoreId','productId','customerId','quantity','expiresHours']);
      const input = { action, storeId:id(raw.storeId), pickupStoreId:id(raw.pickupStoreId), productId:id(raw.productId),
        customerId:id(raw.customerId), quantity:integer(raw.quantity,'Quantidade',1,100), expiresHours:integer(raw.expiresHours,'Prazo',1,168) };
      requireThat(input.storeId !== input.pickupStoreId,400,'INVALID_INPUT','Escolha outra loja para retirada.');
      return this.#mutate(ctx,'RESERVATION_REQUEST',key,input,async(tx)=>{
        const customer=await tx.one('SELECT 1 FROM customers WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND active=1',ctx.tenantId,input.storeId,input.customerId);
        requireThat(customer,404,'CUSTOMER_NOT_FOUND','Selecione um cliente ativo desta loja.');
        const product=await tx.one(`SELECT p.name,st.quantity FROM products p JOIN stock st ON st.tenant_id=p.tenant_id AND st.product_id=p.id
          JOIN stores pickup ON pickup.tenant_id=st.tenant_id AND pickup.id=st.store_id
          WHERE p.tenant_id=$1 AND p.id=$2 AND st.store_id=$3 AND p.active=1 AND pickup.active=1`,ctx.tenantId,input.productId,input.pickupStoreId);
        requireThat(product,404,'PRODUCT_NOT_FOUND','Produto nao disponivel na loja de retirada.');
        const reservationId=randomUUID(),createdAt=now(),expiresAt=new Date(Date.now()+input.expiresHours*3600000).toISOString();
        await tx.run(`INSERT INTO stock_reservations(tenant_id,id,requesting_store_id,pickup_store_id,product_id,customer_id,quantity,status,requested_by,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'REQUESTED',$8,$9,$10)`,ctx.tenantId,reservationId,input.storeId,input.pickupStoreId,input.productId,input.customerId,input.quantity,ctx.userId,createdAt,expiresAt);
        await tx.audit(ctx,input.storeId,'RESERVATION_REQUESTED',reservationId,{pickupStoreId:input.pickupStoreId,productId:input.productId,quantity:input.quantity});
        return {id:reservationId,status:'REQUESTED',productName:product.name,expiresAt};
      });
    }
    object(raw,['action','storeId','reservationId']);
    const input={action,storeId:id(raw.storeId),reservationId:id(raw.reservationId)};
    return this.#mutate(ctx,`RESERVATION_${action}`,key,input,async(tx,user)=>{
      requireThat(user.role==='MANAGER',403,'MANAGER_REQUIRED','Somente gerente da loja de retirada movimenta reservas.');
      const reservation=await tx.one('SELECT * FROM stock_reservations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',ctx.tenantId,input.reservationId);
      requireThat(reservation,404,'RESERVATION_NOT_FOUND','Reserva nao encontrada.');
      requireThat(input.storeId===reservation.pickup_store_id,403,'STORE_FORBIDDEN','A loja de retirada deve movimentar a reserva.');
      const timestamp=now();
      if(action==='CONFIRM'){
        requireThat(reservation.status==='REQUESTED',409,'RESERVATION_STATUS','Esta reserva nao aguarda confirmacao.');
        requireThat(new Date(reservation.expires_at)>new Date(),409,'RESERVATION_EXPIRED','O prazo desta reserva venceu.');
        const stock=await tx.one('SELECT quantity FROM stock WHERE tenant_id=$1 AND store_id=$2 AND product_id=$3 FOR UPDATE',ctx.tenantId,input.storeId,reservation.product_id);
        const held=await tx.one(`SELECT COALESCE(SUM(quantity),0) quantity FROM stock_reservations
          WHERE tenant_id=$1 AND pickup_store_id=$2 AND product_id=$3 AND status='CONFIRMED' AND expires_at>$4`,ctx.tenantId,input.storeId,reservation.product_id,timestamp);
        requireThat(stock&&cashInteger(stock.quantity)-cashInteger(held.quantity)>=cashInteger(reservation.quantity),409,'INSUFFICIENT_STOCK','Saldo disponivel insuficiente para confirmar a reserva.');
        await tx.run("UPDATE stock_reservations SET status='CONFIRMED',confirmed_by=$1,confirmed_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.reservationId);
      } else if(action==='COLLECT'){
        requireThat(reservation.status==='CONFIRMED',409,'RESERVATION_STATUS','A reserva precisa estar confirmada.');
        requireThat(new Date(reservation.expires_at)>new Date(),409,'RESERVATION_EXPIRED','O prazo desta reserva venceu.');
        const changed=await tx.run('UPDATE stock SET quantity=quantity-$1 WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity>=$1',reservation.quantity,ctx.tenantId,input.storeId,reservation.product_id);
        requireThat(changed.changes===1,409,'INSUFFICIENT_STOCK','Saldo fisico insuficiente.');
        await tx.run("UPDATE stock_reservations SET status='COLLECTED',collected_by=$1,collected_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.reservationId);
        await tx.run(`INSERT INTO stock_movements(tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,ctx.tenantId,randomUUID(),input.storeId,reservation.product_id,-cashInteger(reservation.quantity),`Retirada da reserva ${reservation.id}`,ctx.userId,timestamp);
      } else if(action==='CANCEL'){
        requireThat(['REQUESTED','CONFIRMED'].includes(reservation.status),409,'RESERVATION_STATUS','Esta reserva nao pode mais ser cancelada.');
        await tx.run("UPDATE stock_reservations SET status='CANCELED',canceled_by=$1,canceled_at=$2 WHERE tenant_id=$3 AND id=$4",ctx.userId,timestamp,ctx.tenantId,input.reservationId);
      } else throw new AppError(400,'INVALID_INPUT','Acao de reserva invalida.');
      const status=action==='CONFIRM'?'CONFIRMED':action==='COLLECT'?'COLLECTED':'CANCELED';
      await tx.audit(ctx,input.storeId,`RESERVATION_${status}`,input.reservationId,{status});
      return {id:input.reservationId,status};
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
    const body = { customerId: null, ...raw };
    object(body, ['storeId', 'cashSessionId', 'items', 'discountCents', 'discountReason', 'tenderedCents', 'paymentMethod', 'customerId']);
    requireThat(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 100,
      400, 'INVALID_ITEMS', 'Informe entre 1 e 100 produtos.');
    const items = body.items.map(item => {
      object(item, ['productId', 'quantity']);
      return { productId: id(item.productId), quantity: integer(item.quantity, 'Quantidade', 1, 10_000) };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    requireThat(new Set(items.map(item => item.productId)).size === items.length,
      400, 'DUPLICATE_ITEM', 'Agrupe a quantidade do mesmo produto em uma única linha.');
    const paymentMethod = text(body.paymentMethod ?? 'CASH', 'Forma de pagamento', 20).toUpperCase();
    requireThat(PAYMENT_METHODS.has(paymentMethod), 400, 'INVALID_PAYMENT_METHOD', 'Forma de pagamento invalida.');
    const input = {
      storeId: id(body.storeId), cashSessionId: id(body.cashSessionId), items, paymentMethod,
      customerId: body.customerId ? id(body.customerId) : null,
      discountCents: integer(body.discountCents ?? 0, 'Desconto'),
      discountReason: body.discountReason ? text(body.discountReason, 'Motivo', 200) : null,
      tenderedCents: paymentMethod === 'CASH' ? integer(body.tenderedCents, 'Valor entregue', 1) : 0
    };
    return this.#mutate(ctx, 'SALE', key, input, async (tx, user) => {
      // This row serializes selling/closing only this till, including balance-limit checks.
      const cash = await tx.cash(ctx, input.cashSessionId, { lock: true });
      requireThat(cash.store_id === input.storeId, 409, 'CASH_STORE_MISMATCH', 'Caixa de outra loja.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'Use um caixa aberto pelo seu usuário.');
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Abra o caixa antes de vender.');
      if (input.customerId) {
        const customer = await tx.one(`SELECT 1 FROM customers
          WHERE tenant_id=$1 AND store_id=$2 AND id=$3 AND active=1 FOR SHARE`,
        ctx.tenantId, input.storeId, input.customerId);
        requireThat(customer, 404, 'CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta loja.');
      }
      const lines = [];
      // A stable product order avoids lock-order deadlocks across different tills.
      for (const item of input.items) {
        const product = await tx.products.findForSale(ctx.tenantId, input.storeId, item.productId, { lock: true });
        requireThat(product, 404, 'PRODUCT_NOT_FOUND', 'Produto não disponível nesta loja.');
        const held=await tx.one("SELECT COALESCE(SUM(quantity),0) quantity FROM stock_reservations WHERE tenant_id=$1 AND pickup_store_id=$2 AND product_id=$3 AND status='CONFIRMED' AND expires_at>CURRENT_TIMESTAMP",ctx.tenantId,input.storeId,item.productId);
        requireThat(cashInteger(product.stock_quantity)-cashInteger(held.quantity)>=item.quantity,409,'INSUFFICIENT_STOCK',`Estoque disponivel insuficiente: ${product.name}.`);
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
        (tenant_id,id,store_id,cash_session_id,operator_id,customer_id,subtotal_cents,discount_cents,discount_reason,
          discount_author_id,total_cents,status,fiscal_status,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONFIRMED','TEST_NOT_ISSUED',$12)`,
      ctx.tenantId, saleId, input.storeId, input.cashSessionId, ctx.userId, input.customerId, subtotal, input.discountCents,
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
        { totalCents: total, paymentMethod: input.paymentMethod, discountCents: input.discountCents,
          discountReason: input.discountReason, hasCustomer: Boolean(input.customerId) });
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

  async returnSale(ctx, key, raw) {
    const input = saleReturnInput(raw);
    return this.#mutate(ctx, 'SALE_RETURN', key, input, async (tx, user) => {
      requireThat(user.role === 'MANAGER', 403, 'MANAGER_REQUIRED', 'Somente gerente registra devolução.');
      const sale = await tx.one(`SELECT s.*,p.method,p.amount_cents FROM sales s
        JOIN payments p ON p.tenant_id=s.tenant_id AND p.sale_id=s.id
        WHERE s.tenant_id=$1 AND s.store_id=$2 AND s.id=$3 FOR UPDATE OF s FOR SHARE OF p`,
      ctx.tenantId, input.storeId, input.saleId);
      requireThat(sale, 404, 'SALE_NOT_FOUND', 'Venda não encontrada nesta loja.');
      const canceled = await tx.one('SELECT 1 FROM sale_cancellations WHERE tenant_id=$1 AND sale_id=$2 FOR UPDATE',
        ctx.tenantId, input.saleId);
      requireThat(!canceled, 409, 'SALE_CANCELED', 'Venda cancelada não aceita devolução.');
      const cash = await tx.cash(ctx, sale.cash_session_id, { lock: true });
      requireThat(cash.status === 'OPEN', 409, 'CASH_CLOSED', 'Abra o caixa da venda antes de registrar devolução.');
      requireThat(cash.operator_id === ctx.userId, 403, 'CASH_OWNER_REQUIRED', 'A devolução deve ser feita pelo operador do caixa aberto.');
      const saleRows = await tx.all(`SELECT i.*,
          COALESCE((SELECT SUM(r.quantity) FROM sale_return_items r
            WHERE r.tenant_id=i.tenant_id AND r.sale_id=i.sale_id AND r.product_id=i.product_id),0) returned_quantity
        FROM sale_items i
        WHERE i.tenant_id=$1 AND i.sale_id=$2
        ORDER BY i.product_id FOR UPDATE`, ctx.tenantId, input.saleId);
      const saleItems = new Map(saleRows.map(row => [row.product_id, { ...row,
        quantity: cashInteger(row.quantity), returned_quantity: cashInteger(row.returned_quantity),
        price_cents: cashInteger(row.price_cents), line_cents: cashInteger(row.line_cents) }]));
      const lines = input.items.map(item => {
        const original = saleItems.get(item.productId);
        requireThat(original, 404, 'SALE_ITEM_NOT_FOUND', 'Produto não pertence a esta venda.');
        const available = original.quantity - original.returned_quantity;
        requireThat(item.quantity <= available, 409, 'RETURN_QUANTITY_EXCEEDED', 'Quantidade maior que o saldo disponível para devolução.');
        const lineCents = original.price_cents * item.quantity;
        return { ...item, sku: original.sku_snapshot, name: original.name_snapshot,
          priceCents: original.price_cents, amountCents: proratedReturnCents(sale, lineCents) };
      });
      const previous = await tx.one('SELECT COALESCE(SUM(total_cents),0) total FROM sale_returns WHERE tenant_id=$1 AND sale_id=$2',
        ctx.tenantId, input.saleId);
      const previousTotal = cashInteger(previous.total);
      let total = lines.reduce((sum, line) => sum + line.amountCents, 0);
      const returningAll = input.items.every(item => item.quantity === saleItems.get(item.productId).quantity - saleItems.get(item.productId).returned_quantity) &&
        [...saleItems.values()].every(item => input.items.some(line => line.productId === item.product_id) || item.quantity === item.returned_quantity);
      if (returningAll) total = cashInteger(sale.total_cents) - previousTotal;
      requireThat(total > 0 && previousTotal + total <= cashInteger(sale.total_cents),
        409, 'RETURN_TOTAL_EXCEEDED', 'Valor de devolução maior que o saldo da venda.');
      if (sale.method === 'CASH') requireThat(cash.expected_cents - total >= 0, 409, 'CASH_NEGATIVE', 'Dinheiro esperado insuficiente para esta devolução.');
      const returnId = randomUUID();
      const createdAt = now();
      await tx.run(`INSERT INTO sale_returns
        (tenant_id,id,store_id,sale_id,cash_session_id,actor_id,payment_method,total_cents,reason,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ctx.tenantId, returnId, input.storeId, input.saleId, sale.cash_session_id, ctx.userId, sale.method, total, input.reason, createdAt);
      for (const line of lines) {
        const changed = await tx.run(`UPDATE stock SET quantity=quantity+$1
          WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity+$1 BETWEEN 0 AND 1000000`,
        line.quantity, ctx.tenantId, input.storeId, line.productId);
        requireThat(changed.changes === 1, 409, 'STOCK_LIMIT', 'Devolução deixaria o estoque fora do limite permitido.');
        await tx.run(`INSERT INTO sale_return_items
          (tenant_id,return_id,sale_id,product_id,quantity,amount_cents)
          VALUES($1,$2,$3,$4,$5,$6)`,
        ctx.tenantId, returnId, input.saleId, line.productId, line.quantity, line.amountCents);
        await tx.run(`INSERT INTO stock_movements
          (tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,$5,'ADJUSTMENT',$6,$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, line.productId, line.quantity, `Devolução de venda: ${input.reason}`, ctx.userId, createdAt);
      }
      if (sale.method === 'CASH') {
        await tx.run(`INSERT INTO cash_movements
          (tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,NULL,'WITHDRAWAL',$5,$6,$7,$8)`,
        ctx.tenantId, randomUUID(), input.storeId, sale.cash_session_id, -total, `Devolução de venda: ${input.reason}`, ctx.userId, createdAt);
      }
      await tx.audit(ctx, input.storeId, 'SALE_RETURNED', returnId,
        { saleId: input.saleId, totalCents: total, paymentMethod: sale.method, reason: input.reason });
      return tx.receipt(ctx, input.saleId);
    });
  }
}
