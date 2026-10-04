import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { fixture, PASSWORD, DEMO, key, testMfaCode } from './helpers.mjs';

async function web(t) {
  const { db } = fixture(t);
  const server = createApp(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '', csrf = '';
  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const content = await response.text();
    let data;
    try { data = JSON.parse(content); } catch { data = content; }
    return { response, data };
  }
  async function login() {
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email: 'gerente@jcs.local', password: PASSWORD, code: testMfaCode(db, 'users', 'gerente@jcs.local') } });
    assert.equal(result.response.status, 200);
    cookie = result.response.headers.get('set-cookie').split(';')[0];
    csrf = result.data.csrfToken;
  }
  return { db, call, login };
}

test('HTTP customer list is masked, detail is audited and operations keep no PII', async t => {
  const w = await web(t);
  await w.login();
  const body = {
    storeId: DEMO.storeA, name: 'Cliente HTTP', document: '123.456.789-01',
    phone: '(11) 98888-7777', email: 'cliente.http@jcs.local', note: 'preferencia de contato'
  };
  const created = await w.call('/api/customers', { method: 'POST', headers: { 'Idempotency-Key': key() }, body });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.data.name, undefined);
  const state = await w.call('/api/stores/store-a/state');
  const customer = state.data.customers.find(row => row.id === created.data.data.id);
  // Lista: só o suficiente para reconhecer o cliente.
  assert.equal(customer.name, body.name);
  assert.equal(customer.document, '•••8901');
  assert.equal(customer.phone, '•••7777');
  assert.equal(customer.email, 'c•••@jcs.local');
  assert.equal(customer.note, undefined);
  assert.equal(customer.has_note, true);
  assert.equal(JSON.stringify(state.data).includes(body.email), false);
  assert.equal(JSON.stringify(state.data).includes('preferencia de contato'), false);
  // Detalhe: completo, sob demanda e auditado.
  const detail = await w.call(`/api/stores/${DEMO.storeA}/customers/${customer.id}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.data.document, '12345678901');
  assert.equal(detail.data.email, body.email);
  assert.equal(detail.data.note, body.note);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='CUSTOMER_VIEWED' AND entity_id=?").get(customer.id).n, 1);
  assert.equal((await w.call(`/api/stores/${DEMO.storeB}/customers/${customer.id}`)).response.status, 404);
  assert.equal((await w.call(`/api/stores/${DEMO.otherStore}/customers/${customer.id}`)).response.status, 403);
  const raw = JSON.stringify(w.db.prepare('SELECT * FROM customers').all()) +
    JSON.stringify(w.db.prepare("SELECT response_json FROM operations WHERE kind LIKE 'CUSTOMER_%'").all());
  assert.equal(raw.includes(body.email), false);
  assert.equal(raw.includes(body.phone), false);
  const updated = await w.call('/api/customers/update', {
    method: 'POST',
    headers: { 'Idempotency-Key': key() },
    body: { ...body, customerId: customer.id, name: 'Cliente HTTP Editado', active: 0 }
  });
  assert.equal(updated.response.status, 201);
  assert.equal(updated.data.data.active, 0);
});
