import { all, one, run } from './postgres.mjs';
import { integer } from './errors.mjs';

export class PostgresProducts {
  constructor(client) { this.client = client; }

  async listForStore(tenantId, storeId) {
    return all(this.client, `SELECT p.id,p.sku,p.barcode,p.name,p.price_cents,s.quantity
      FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
      WHERE p.tenant_id=$1 AND s.store_id=$2 AND p.active=1 ORDER BY p.name`, [tenantId, storeId]);
  }

  async findForSale(tenantId, storeId, productId, { lock = false } = {}) {
    return one(this.client, `SELECT p.*,s.quantity stock_quantity
      FROM products p JOIN stock s ON s.tenant_id=p.tenant_id AND s.product_id=p.id
      WHERE p.tenant_id=$1 AND s.store_id=$2 AND p.id=$3 AND p.active=1${lock ? ' FOR SHARE OF p FOR UPDATE OF s' : ''}`,
    [tenantId, storeId, productId]);
  }

  async decrementStock(tenantId, storeId, productId, quantity) {
    integer(quantity, 'Quantidade', 1, 10_000);
    const result = await run(this.client, `UPDATE stock SET quantity=quantity-$1
      WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4 AND quantity >= $1`,
      [quantity, tenantId, storeId, productId]);
    return result.changes === 1;
  }
}
