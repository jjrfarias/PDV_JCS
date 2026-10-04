import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { fixture, PASSWORD, DEMO, key, testMfaCode } from './helpers.mjs';

async function web(t) {
  const { db } = fixture(t);
  // O gerente de demonstração é o administrador da empresa.
  db.prepare("UPDATE users SET company_admin=1 WHERE id=?").run(DEMO.manager.userId);
  const server = createApp(db, { mailer: { async sendPasswordReset() {}, async sendInvite() {}, async sendPasswordChanged() {} } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { cookie: '', csrf: '' };
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), response };
  };
  const login = async email => {
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email, password: PASSWORD, code: testMfaCode(db, 'users', email) } });
    assert.equal(result.status, 200);
    session.cookie = result.response.headers.get('set-cookie').split(';')[0]; session.csrf = result.data.csrfToken;
  };
  const update = body => call('/api/stores/update', { method: 'POST', headers: { 'Idempotency-Key': key() }, body });
  return { db, call, login, update };
}

test('company admin lists, renames, deactivates and reactivates stores', async t => {
  const w = await web(t);
  await w.login('gerente@jcs.local');
  const listed = await w.call('/api/company/stores');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.data.stores.map(s => [s.id, s.active]), [[DEMO.storeA, 1], [DEMO.storeB, 1]]);
  assert.ok(listed.data.stores.every(s => s.terminal_count >= 1));

  const renamed = await w.update({ storeId: DEMO.storeB, name: 'Loja B · Shopping', active: 1 });
  assert.equal(renamed.status, 201);
  assert.equal((await w.call('/api/me')).data.stores.find(s => s.id === DEMO.storeB).name, 'Loja B · Shopping');
  assert.equal((await w.update({ storeId: DEMO.storeB, name: 'loja a · centro', active: 1 })).data.error.code, 'DUPLICATE_STORE');
  // Loja de outra empresa não existe para este administrador.
  assert.equal((await w.update({ storeId: DEMO.otherStore, name: 'Alheia', active: 0 })).data.error.code, 'STORE_NOT_FOUND');

  const off = await w.update({ storeId: DEMO.storeB, name: 'Loja B · Shopping', active: 0 });
  assert.equal(off.status, 201);
  assert.deepEqual((await w.call('/api/me')).data.stores.map(s => s.id), [DEMO.storeA]);
  const blocked = await w.call(`/api/stores/${DEMO.storeB}/state`);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'STORE_INACTIVE');
  assert.equal((await w.call('/api/company/stores')).data.stores.find(s => s.id === DEMO.storeB).active, 0);
  // A última loja ativa não pode ser desativada.
  assert.equal((await w.update({ storeId: DEMO.storeA, name: 'Loja A · Centro', active: 0 })).data.error.code, 'LAST_ACTIVE_STORE');

  assert.equal((await w.update({ storeId: DEMO.storeB, name: 'Loja B · Shopping', active: 1 })).status, 201);
  assert.equal((await w.call(`/api/stores/${DEMO.storeB}/state`)).status, 200);
  const audit = w.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'STORE_%' ORDER BY created_at,rowid").all().map(r => r.action);
  assert.deepEqual(audit, ['STORE_UPDATED', 'STORE_DEACTIVATED', 'STORE_REACTIVATED']);
});

test('store with an open cash register cannot be deactivated, and replays are idempotent', async t => {
  const w = await web(t);
  await w.login('gerente@jcs.local');
  const opened = await w.call('/api/cash/open', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: { storeId: DEMO.storeB, terminalId: DEMO.terminalB, openingCents: 1000 } });
  assert.equal(opened.status, 201);
  assert.equal((await w.update({ storeId: DEMO.storeB, name: 'Loja B · Bairro', active: 0 })).data.error.code, 'STORE_CASH_OPEN');

  const opKey = key();
  const body = { storeId: DEMO.storeA, name: 'Loja A · Matriz', active: 1 };
  const first = await w.call('/api/stores/update', { method: 'POST', headers: { 'Idempotency-Key': opKey }, body });
  const again = await w.call('/api/stores/update', { method: 'POST', headers: { 'Idempotency-Key': opKey }, body });
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.data.replayed, true);
  assert.equal((await w.call('/api/stores/update', { method: 'POST', headers: { 'Idempotency-Key': opKey }, body: { ...body, name: 'Outro nome' } })).data.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('only the company admin manages stores', async t => {
  const w = await web(t);
  await w.login('operador@jcs.local');
  assert.equal((await w.call('/api/company/stores')).data.error.code, 'COMPANY_ADMIN_REQUIRED');
  assert.equal((await w.update({ storeId: DEMO.storeA, name: 'Invasão', active: 0 })).data.error.code, 'COMPANY_ADMIN_REQUIRED');
  assert.equal((await w.update({ storeId: DEMO.otherStore, name: 'Outra', active: 0 })).data.error.code, 'COMPANY_ADMIN_REQUIRED');
});
