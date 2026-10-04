import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { fixture, PASSWORD, DEMO, key, testMfaCode, enableTestMfa } from './helpers.mjs';

const TEMP = 'SenhaTemporaria2026';

async function web(t) {
  const { db } = fixture(t);
  const server = createApp(db, { mailer: { async sendPasswordReset() {}, async sendInvite() {}, async sendPasswordChanged() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { cookie: '', csrf: '' };
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), response };
  };
  const login = async (email, password = PASSWORD) => {
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email, password, code: testMfaCode(db, 'users', email) } });
    if (result.status === 200) { session.cookie = result.response.headers.get('set-cookie').split(';')[0]; session.csrf = result.data.csrfToken; }
    return result.status;
  };
  const post = (path, body) => call(path, { method: 'POST', headers: { 'Idempotency-Key': key() }, body });
  const membership = (userId, storeId) => ({ ...db.prepare('SELECT role,active FROM memberships WHERE tenant_id=? AND user_id=? AND store_id=?').get('tenant-demo', userId, storeId) });
  return { db, call, login, post, membership };
}
const cashierInB = role => ({ storeId: DEMO.storeB, email: 'operador@jcs.local', name: 'Ignorado', role, temporaryPassword: TEMP });

test('the same person can be manager in one store and operator in another', async t => {
  const w = await web(t);
  assert.equal(await w.login('gerente@jcs.local'), 200);
  // Operador da Loja A ganha acesso à Loja B como gerente; senha e nome não mudam.
  const linked = await w.post('/api/users', cashierInB('MANAGER'));
  assert.equal(linked.status, 201);
  assert.equal(linked.data.data.linked, true);
  assert.equal(linked.data.data.name, 'Operador de demonstração');
  assert.deepEqual(w.membership(DEMO.cashier.userId, DEMO.storeB), { role: 'MANAGER', active: 1 });
  assert.deepEqual(w.membership(DEMO.cashier.userId, DEMO.storeA), { role: 'CASHIER', active: 1 });
  assert.equal(w.db.prepare('SELECT role FROM users WHERE id=?').get(DEMO.cashier.userId).role, 'MANAGER', 'account summary drives MFA');
  assert.equal((await w.post('/api/users', cashierInB('CASHIER'))).data.error.code, 'DUPLICATE_USER');

  // Agora gerente em alguma loja, precisa de MFA.
  enableTestMfa(w.db, 'users', `id='${DEMO.cashier.userId}'`);
  assert.equal(await w.login('operador@jcs.local'), 200);
  const me = (await w.call('/api/me')).data;
  assert.deepEqual(me.stores.map(s => [s.id, s.role]), [[DEMO.storeA, 'CASHIER'], [DEMO.storeB, 'MANAGER']]);
  // Gerente na B: cadastra produto lá. Operador na A: não cadastra.
  const product = { sku: 'ROLE-1', barcode: null, name: 'Teste de perfil', priceCents: 1000, initialQuantity: 1 };
  assert.equal((await w.post('/api/products', { ...product, storeId: DEMO.storeB })).status, 201);
  assert.equal((await w.post('/api/products', { ...product, sku: 'ROLE-2', storeId: DEMO.storeA })).data.error.code, 'MANAGER_REQUIRED');
  assert.equal((await w.call(`/api/stores/${DEMO.storeA}/state`)).data.users.length, 0, 'operator in A does not see the team');
  assert.ok((await w.call(`/api/stores/${DEMO.storeB}/state`)).data.users.length > 0);
  // A rede mostra só as lojas em que é gerente.
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual((await w.call(`/api/network/overview?from=${today}&to=${today}`)).data.stores.map(s => s.id), [DEMO.storeB]);
});

test('an operator never reaches a store without access, even in the same company', async t => {
  const w = await web(t);
  assert.equal(await w.login('operador@jcs.local'), 200);
  assert.deepEqual((await w.call('/api/me')).data.stores.map(s => s.id), [DEMO.storeA]);
  assert.equal((await w.call(`/api/stores/${DEMO.storeB}/state`)).data.error.code, 'STORE_FORBIDDEN');
  assert.equal((await w.post('/api/cash/open', { storeId: DEMO.storeB, terminalId: DEMO.terminalB, openingCents: 1000 })).data.error.code, 'STORE_FORBIDDEN');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal((await w.call(`/api/network/overview?from=${today}&to=${today}`)).data.error.code, 'MANAGER_REQUIRED');
});

test('a store manager changes only their store; identity of shared people needs the company admin', async t => {
  const w = await web(t);
  assert.equal(await w.login('gerente@jcs.local'), 200);
  // Gerente só da Loja B e operador compartilhado entre A e B.
  const created = await w.post('/api/users', { storeId: DEMO.storeB, email: 'gerente.b@jcs.local', name: 'Gerente B', role: 'MANAGER', temporaryPassword: TEMP });
  assert.equal(created.status, 201);
  assert.equal((await w.post('/api/users', cashierInB('CASHIER'))).status, 201);
  // Quem gerencia as duas lojas edita os dados da pessoa; a tela recebe a regra pronta.
  assert.equal((await w.call(`/api/stores/${DEMO.storeB}/state`)).data.users.find(u => u.id === DEMO.cashier.userId).locked_stores, 0);
  enableTestMfa(w.db, 'users', "email='gerente.b@jcs.local'");
  assert.equal(await w.login('gerente.b@jcs.local', TEMP), 200);
  const base = { storeId: DEMO.storeB, userId: DEMO.cashier.userId, email: 'operador@jcs.local', name: 'Operador de demonstração', role: 'CASHIER', active: 1 };
  assert.equal((await w.call(`/api/stores/${DEMO.storeB}/state`)).data.users.find(u => u.id === DEMO.cashier.userId).locked_stores, 1);
  // Mudar nome, e-mail ou senha de quem também trabalha na Loja A: recusado.
  assert.equal((await w.post('/api/users/update', { ...base, name: 'Outro nome' })).data.error.code, 'USER_SHARED');
  assert.equal((await w.post('/api/users/update', { ...base, temporaryPassword: 'NovaSenhaTemp2026' })).data.error.code, 'USER_SHARED');
  // Perfil e acesso na própria loja: permitido, sem afetar a Loja A.
  assert.equal((await w.post('/api/users/update', { ...base, role: 'MANAGER' })).status, 201);
  assert.deepEqual(w.membership(DEMO.cashier.userId, DEMO.storeA), { role: 'CASHIER', active: 1 });
  assert.equal((await w.post('/api/users/update', { ...base, active: 0 })).status, 201);
  assert.deepEqual(w.membership(DEMO.cashier.userId, DEMO.storeB), { role: 'CASHIER', active: 0 });
  assert.equal(w.db.prepare('SELECT role,active FROM users WHERE id=?').get(DEMO.cashier.userId).active, 1, 'still works in store A');
  // Gerente da B não alcança a Loja A.
  assert.equal((await w.post('/api/users/update', { ...base, storeId: DEMO.storeA })).data.error.code, 'STORE_FORBIDDEN');
});

test('removing the last store access turns the account off', async t => {
  const w = await web(t);
  assert.equal(await w.login('gerente@jcs.local'), 200);
  const base = { storeId: DEMO.storeA, userId: DEMO.cashier.userId, email: 'operador@jcs.local', name: 'Operador de demonstração', role: 'CASHIER' };
  assert.equal((await w.post('/api/users/update', { ...base, active: 0 })).status, 201);
  assert.equal(w.db.prepare('SELECT active FROM users WHERE id=?').get(DEMO.cashier.userId).active, 0);
  assert.equal(await w.login('operador@jcs.local'), 401);
  assert.equal(await w.login('gerente@jcs.local'), 200);
  assert.equal((await w.post('/api/users/update', { ...base, active: 1 })).status, 201);
  assert.equal(await w.login('operador@jcs.local'), 200);
});
