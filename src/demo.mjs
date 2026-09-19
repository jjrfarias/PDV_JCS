import { randomBytes } from 'node:crypto';
import { hashPassword } from './security.mjs';
import { transaction } from './database.mjs';

export const DEMO = {
  manager: { tenantId: 'tenant-demo', userId: 'user-manager' },
  cashier: { tenantId: 'tenant-demo', userId: 'user-cashier' },
  other: { tenantId: 'tenant-other', userId: 'user-other' },
  storeA: 'store-a', storeB: 'store-b', otherStore: 'store-other',
  terminalA: 'terminal-a', terminalA2: 'terminal-a2', terminalB: 'terminal-b', product: 'product-25'
};

// Somente seed inicial: não repõe estoque nem sobrescreve dados a cada reinício.
export function seedDemo(db, testPassword) {
  if (db.prepare('SELECT 1 FROM tenants LIMIT 1').get()) return null;
  const credentials = [
    { tenant:'demo', email:'gerente@jcs.local', name:'Gerente de demonstração', id:'user-manager', tenantId:'tenant-demo', role:'MANAGER' },
    { tenant:'demo', email:'operador@jcs.local', name:'Operador de demonstração', id:'user-cashier', tenantId:'tenant-demo', role:'CASHIER' },
    { tenant:'outra', email:'gerente@outra.local', name:'Outro contratante fictício', id:'user-other', tenantId:'tenant-other', role:'MANAGER' }
  ].map(u => ({ ...u, password: testPassword ?? randomBytes(15).toString('base64url') }));
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM tenants LIMIT 1').get()) return null;
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    run('INSERT INTO tenants VALUES(?,?,?)','tenant-demo','demo','Comércio de demonstração');
    run('INSERT INTO tenants VALUES(?,?,?)','tenant-other','outra','Outro contratante fictício');
    run('INSERT INTO companies VALUES(?,?,?)','tenant-demo','company-demo','Empresa de teste');
    run('INSERT INTO companies VALUES(?,?,?)','tenant-other','company-other','Empresa separada de teste');
    for (const [tenantId, store, company, name] of [
      ['tenant-demo','store-a','company-demo','Loja A · Centro'],
      ['tenant-demo','store-b','company-demo','Loja B · Bairro'],
      ['tenant-other','store-other','company-other','Loja de outro contratante']]) run('INSERT INTO stores VALUES(?,?,?,?)',tenantId,store,company,name);
    for (const u of credentials) run('INSERT INTO users(tenant_id,id,email,name,password_hash,role) VALUES(?,?,?,?,?,?)',u.tenantId,u.id,u.email,u.name,hashPassword(u.password),u.role);
    for (const [tenant,user,store] of [
      ['tenant-demo','user-manager','store-a'],['tenant-demo','user-manager','store-b'],
      ['tenant-demo','user-cashier','store-a'],['tenant-other','user-other','store-other']]) run('INSERT INTO memberships VALUES(?,?,?)',tenant,user,store);
    for (const [tenant,store,terminal,name] of [
      ['tenant-demo','store-a','terminal-a','Caixa 01'],['tenant-demo','store-a','terminal-a2','Caixa 02'],
      ['tenant-demo','store-b','terminal-b','Caixa 01'],['tenant-other','store-other','terminal-other','Caixa 01']]) run('INSERT INTO terminals VALUES(?,?,?,?)',tenant,store,terminal,name);
    run('INSERT INTO products(tenant_id,id,sku,barcode,name,price_cents) VALUES(?,?,?,?,?,?)', 'tenant-demo','product-25','DEMO-001','7890000000017','Produto de teste · R$ 25,00',2500);
    run('INSERT INTO products(tenant_id,id,sku,barcode,name,price_cents) VALUES(?,?,?,?,?,?)', 'tenant-other','product-other','OUT-001','7890000000024','Produto de outra empresa',1000);
    for (const [tenant,store,product,qty,actor] of [
      ['tenant-demo','store-a','product-25',10,'user-manager'],
      ['tenant-demo','store-b','product-25',30,'user-manager'],
      ['tenant-other','store-other','product-other',7,'user-other']]) {
      run('INSERT INTO stock VALUES(?,?,?,?)',tenant,store,product,qty);
      run('INSERT INTO stock_movements VALUES(?,?,?,?,?,?,?,?,?,?)',tenant,`initial-${store}`,store,product,null,qty,'INITIAL','Carga inicial de demonstração',actor,new Date().toISOString());
    }
    return credentials;
  });
}
