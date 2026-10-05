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
  async function login(email = 'gerente@jcs.local') {
    const code = email === 'gerente@jcs.local' ? testMfaCode(db, 'users', email) : undefined;
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email, password: PASSWORD, code } });
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

test('HTTP titular export and anonymization are manager-only, audited and keep sales', async t => {
  const w = await web(t);
  await w.login();
  const body = { storeId: DEMO.storeA, name: 'Titular LGPD', document: '987.654.321-00', phone: '(11) 97777-6666', email: 'titular@jcs.local', note: 'nota' };
  const created = await w.call('/api/customers', { method: 'POST', headers: { 'Idempotency-Key': key() }, body });
  const customerId = created.data.data.id;
  const exported = await w.call(`/api/stores/${DEMO.storeA}/customers/${customerId}/export`);
  assert.equal(exported.response.status, 200);
  assert.match(exported.response.headers.get('content-disposition'), /attachment/);
  assert.equal(exported.data.format, 'pdv-jcs.customer-export.v1');
  assert.equal(exported.data.customer.email, body.email);
  assert.deepEqual(exported.data.sales, []);
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='CUSTOMER_EXPORTED' AND entity_id=?").get(customerId).n, 1);
  assert.equal((await w.call(`/api/stores/${DEMO.otherStore}/customers/${customerId}/export`)).response.status, 403);

  const opKey = key();
  const anonymized = await w.call('/api/customers/anonymize', { method: 'POST', headers: { 'Idempotency-Key': opKey }, body: { storeId: DEMO.storeA, customerId } });
  assert.equal(anonymized.response.status, 201);
  assert.equal(anonymized.data.data.active, 0);
  const replay = await w.call('/api/customers/anonymize', { method: 'POST', headers: { 'Idempotency-Key': opKey }, body: { storeId: DEMO.storeA, customerId } });
  assert.equal(replay.data.replayed, true);
  const detail = await w.call(`/api/stores/${DEMO.storeA}/customers/${customerId}`);
  assert.equal(detail.data.name, 'Cliente anonimizado');
  assert.equal(detail.data.document, null);
  assert.equal(detail.data.email, null);
  assert.equal(detail.data.phone, null);
  assert.equal(detail.data.note, null);
  const row = w.db.prepare('SELECT document_hash,phone_hash,email_hash FROM customers WHERE id=?').get(customerId);
  assert.deepEqual({ ...row }, { document_hash: null, phone_hash: null, email_hash: null });
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='CUSTOMER_ANONYMIZED' AND entity_id=?").get(customerId).n, 1);
  // O documento fica livre para um novo cadastro.
  const again = await w.call('/api/customers', { method: 'POST', headers: { 'Idempotency-Key': key() }, body });
  assert.equal(again.response.status, 201);
});

test('HTTP operator cannot export or anonymize a titular', async t => {
  const w = await web(t);
  await w.login();
  const created = await w.call('/api/customers', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: { storeId: DEMO.storeA, name: 'Titular Operador' } });
  const customerId = created.data.data.id;
  await w.login('operador@jcs.local');
  assert.equal((await w.call(`/api/stores/${DEMO.storeA}/customers/${customerId}/export`)).response.status, 403);
  const denied = await w.call('/api/customers/anonymize', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: { storeId: DEMO.storeA, customerId } });
  assert.equal(denied.response.status, 403);
  assert.equal(w.db.prepare('SELECT active FROM customers WHERE id=?').get(customerId).active, 1);
});
