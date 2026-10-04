import pg from 'pg';

const { Client } = pg;
if (process.env.NODE_ENV !== 'production' || process.env.PDV_SEED_CONFIRM !== 'SEED_FREDBULL_PRODUCTION') {
  throw new Error('Carga bloqueada. Exige produção e PDV_SEED_CONFIRM=SEED_FREDBULL_PRODUCTION.');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(process.env.PDV_DEMO_DATE ?? '')) {
  throw new Error('PDV_DEMO_DATE deve estar no formato AAAA-MM-DD.');
}

const tenantId = 'tenant-jcs';
const adminId = 'user-admin';
const companyId = 'company-jcs';
const demoDate = process.env.PDV_DEMO_DATE;
const stores = [
  ['store-matriz', 'FREDBULL · Matriz'],
  ['fredbull-loja-02', 'FREDBULL · Shopping Norte'],
  ['fredbull-loja-03', 'FREDBULL · Shopping Sul'],
  ['fredbull-loja-04', 'FREDBULL · Centro'],
  ['fredbull-loja-05', 'FREDBULL · Vila Nova'],
  ['fredbull-loja-06', 'FREDBULL · Jardim'],
  ['fredbull-loja-07', 'FREDBULL · Estação'],
  ['fredbull-loja-08', 'FREDBULL · Boulevard'],
  ['fredbull-loja-09', 'FREDBULL · Outlet'],
  ['fredbull-loja-10', 'FREDBULL · Praia'],
  ['fredbull-loja-11', 'FREDBULL · Aeroporto']
];
const products = [
  ['fredbull-prod-01', 'FB-CAM-001', 'Camiseta Essential Preta', 7990],
  ['fredbull-prod-02', 'FB-CAM-002', 'Camiseta Essential Branca', 7990],
  ['fredbull-prod-03', 'FB-POLO-001', 'Camisa Polo Classic', 12990],
  ['fredbull-prod-04', 'FB-JEA-001', 'Calça Jeans Slim', 18990],
  ['fredbull-prod-05', 'FB-CAR-001', 'Calça Cargo Urban', 21990],
  ['fredbull-prod-06', 'FB-BER-001', 'Bermuda Sarja', 14990],
  ['fredbull-prod-07', 'FB-JAQ-001', 'Jaqueta Corta-Vento', 27990],
  ['fredbull-prod-08', 'FB-MOL-001', 'Moletom Premium', 23990],
  ['fredbull-prod-09', 'FB-VES-001', 'Vestido Midi', 22990],
  ['fredbull-prod-10', 'FB-BOL-001', 'Bolsa Casual', 17990],
  ['fredbull-prod-11', 'FB-MOC-001', 'Mochila Urbana', 19990],
  ['fredbull-prod-12', 'FB-BON-001', 'Boné Logo', 6990],
  ['fredbull-prod-13', 'FB-CIN-001', 'Cinto Couro', 9990],
  ['fredbull-prod-14', 'FB-CAR-002', 'Carteira Compacta', 8990],
  ['fredbull-prod-15', 'FB-OCU-001', 'Óculos Solar', 15990]
];

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenantId, adminId]);
  const marker = await client.query("SELECT 1 FROM audit_events WHERE tenant_id=$1 AND id='fredbull-demo-v1'", [tenantId]);
  if (marker.rowCount) {
    const existing = await client.query("SELECT count(*) stores FROM stores WHERE tenant_id=$1 AND name LIKE 'FREDBULL · %'", [tenantId]);
    await client.query('ROLLBACK');
    console.log(JSON.stringify({ status: 'already_seeded', stores: Number(existing.rows[0].stores) }));
    process.exit(0);
  }

  await client.query('UPDATE companies SET name=$1 WHERE tenant_id=$2 AND id=$3', ['FREDBULL', tenantId, companyId]);
  for (const [storeId, name] of stores) {
    await client.query(`INSERT INTO stores(tenant_id,id,company_id,name) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,id) DO UPDATE SET company_id=excluded.company_id,name=excluded.name`, [tenantId, storeId, companyId, name]);
    await client.query("INSERT INTO memberships(tenant_id,user_id,store_id,role) VALUES($1,$2,$3,'MANAGER') ON CONFLICT DO NOTHING", [tenantId, adminId, storeId]);
  }
  for (const [productId, sku, name, price] of products) {
    await client.query(`INSERT INTO products(tenant_id,id,sku,barcode,name,price_cents,active) VALUES($1,$2,$3,NULL,$4,$5,1)
      ON CONFLICT(tenant_id,id) DO UPDATE SET sku=excluded.sku,name=excluded.name,price_cents=excluded.price_cents,active=1`,
    [tenantId, productId, sku, name, price]);
  }

  let saleCount = 0;
  let grossCents = 0;
  for (let storeIndex = 0; storeIndex < stores.length; storeIndex++) {
    const [storeId] = stores[storeIndex];
    const terminalId = `fredbull-terminal-${String(storeIndex + 1).padStart(2, '0')}`;
    const cashId = `fredbull-cash-${demoDate}-${String(storeIndex + 1).padStart(2, '0')}`;
    const sales = [];
    const numberOfSales = 8 + storeIndex;
    for (let saleIndex = 0; saleIndex < numberOfSales; saleIndex++) {
      const product = products[(storeIndex * 3 + saleIndex * 2) % products.length];
      const quantity = saleIndex % 5 === 0 ? 2 : 1;
      const subtotal = product[3] * quantity;
      const discount = saleIndex % 7 === 0 ? Math.round(subtotal * 0.1) : 0;
      const total = subtotal - discount;
      const method = ['CASH', 'PIX', 'CARD'][(storeIndex + saleIndex) % 3];
      const hour = 10 + Math.floor(saleIndex / 3);
      const minute = (storeIndex * 7 + saleIndex * 11) % 60;
      sales.push({ id: `fredbull-sale-${demoDate}-${storeIndex + 1}-${saleIndex + 1}`, product, quantity, subtotal, discount, total, method,
        createdAt: `${demoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z` });
    }
    const opening = 20000;
    const cashSales = sales.filter(sale => sale.method === 'CASH').reduce((sum, sale) => sum + sale.total, 0);
    const isOpen = storeIndex % 3 === 0;
    await client.query('INSERT INTO terminals(tenant_id,store_id,id,name) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [tenantId, storeId, terminalId, 'Caixa 01']);
    for (let productIndex = 0; productIndex < products.length; productIndex++) {
      const [productId] = products[productIndex];
      const quantity = 70 + ((storeIndex * 13 + productIndex * 7) % 45);
      await client.query('INSERT INTO stock(tenant_id,store_id,product_id,quantity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [tenantId, storeId, productId, quantity]);
      await client.query(`INSERT INTO stock_movements(tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,NULL,$5,'INITIAL','Carga fictícia FREDBULL',$6,$7) ON CONFLICT DO NOTHING`,
      [tenantId, `fredbull-stock-${storeIndex + 1}-${productIndex + 1}`, storeId, productId, quantity, adminId, `${demoDate}T08:00:00.000Z`]);
    }
    await client.query(`INSERT INTO cash_sessions(tenant_id,id,store_id,terminal_id,operator_id,status,opening_cents,counted_cents,expected_cents,difference_cents,close_reason,opened_at,closed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12)`, [tenantId, cashId, storeId, terminalId, adminId, isOpen ? 'OPEN' : 'CLOSED', opening,
      isOpen ? null : opening + cashSales, isOpen ? null : opening + cashSales, isOpen ? null : 0,
      `${demoDate}T09:00:00.000Z`, isOpen ? null : `${demoDate}T20:00:00.000Z`]);
    await client.query(`INSERT INTO cash_movements(tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,NULL,'OPENING',$5,'Fundo inicial fictício',$6,$7)`,
    [tenantId, `fredbull-opening-${storeIndex + 1}`, storeId, cashId, opening, adminId, `${demoDate}T09:00:00.000Z`]);
    for (const sale of sales) {
      const [productId, sku, name, price] = sale.product;
      await client.query(`INSERT INTO sales(tenant_id,id,store_id,cash_session_id,operator_id,customer_id,subtotal_cents,discount_cents,discount_reason,discount_author_id,total_cents,status,fiscal_status,created_at)
        VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,'CONFIRMED','TEST_NOT_ISSUED',$11)`,
      [tenantId, sale.id, storeId, cashId, adminId, sale.subtotal, sale.discount, sale.discount ? 'Campanha de demonstração' : null,
        sale.discount ? adminId : null, sale.total, sale.createdAt]);
      await client.query(`INSERT INTO sale_items(tenant_id,sale_id,product_id,sku_snapshot,name_snapshot,quantity,price_cents,line_cents)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [tenantId, sale.id, productId, sku, name, sale.quantity, price, sale.subtotal]);
      await client.query(`INSERT INTO payments(tenant_id,sale_id,method,status,amount_cents,tendered_cents,change_cents)
        VALUES($1,$2,$3,'CONFIRMED',$4,$4,0)`, [tenantId, sale.id, sale.method, sale.total]);
      await client.query(`UPDATE stock SET quantity=quantity-$1 WHERE tenant_id=$2 AND store_id=$3 AND product_id=$4`,
        [sale.quantity, tenantId, storeId, productId]);
      await client.query(`INSERT INTO stock_movements(tenant_id,id,store_id,product_id,sale_id,quantity,kind,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'SALE','Venda fictícia FREDBULL',$7,$8)`,
      [tenantId, `movement-${sale.id}`, storeId, productId, sale.id, -sale.quantity, adminId, sale.createdAt]);
      if (sale.method === 'CASH') await client.query(`INSERT INTO cash_movements(tenant_id,id,store_id,cash_session_id,sale_id,kind,amount_cents,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,$5,'SALE',$6,'Venda fictícia em dinheiro',$7,$8)`,
      [tenantId, `cash-${sale.id}`, storeId, cashId, sale.id, sale.total, adminId, sale.createdAt]);
      saleCount++;
      grossCents += sale.total;
    }
  }
  await client.query(`INSERT INTO audit_events(tenant_id,id,user_id,store_id,action,entity_id,details_json,created_at)
    VALUES($1,'fredbull-demo-v1',$2,'store-matriz','DEMO_DATA_SEEDED','FREDBULL',$3,$4)`,
  [tenantId, adminId, JSON.stringify({ stores: stores.length, sales: saleCount, demoDate }), `${demoDate}T21:00:00.000Z`]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ status: 'seeded', company: 'FREDBULL', stores: stores.length, products: products.length, sales: saleCount, grossCents, demoDate }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
