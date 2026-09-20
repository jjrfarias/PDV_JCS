import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { fixture, PASSWORD, DEMO, key } from './helpers.mjs';

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
  async function login(email = 'gerente@jcs.local', password = PASSWORD) {
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email, password } });
    if (result.response.status === 200) {
      cookie = result.response.headers.get('set-cookie').split(';')[0];
      csrf = result.data.csrfToken;
    }
    return result;
  }
  return { call, login };
}

test('HTTP user update resets password without exposing sensitive fields', async t => {
  const w = await web(t);
  assert.equal((await w.login()).response.status, 200);
  const createBody = {
    storeId: DEMO.storeA, email: 'editar.http@jcs.local',
    name: 'Editar HTTP', role: 'CASHIER', temporaryPassword: 'SenhaTemp2026'
  };
  const created = await w.call('/api/users', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: createBody });
  assert.equal(created.response.status, 201);
  const updateBody = {
    storeId: DEMO.storeA, userId: created.data.data.id, email: 'editado.http@jcs.local',
    name: 'Editado HTTP', role: 'CASHIER', active: 1, temporaryPassword: 'NovaSenha2026'
  };
  const updated = await w.call('/api/users/update', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: updateBody });
  assert.equal(updated.response.status, 201);
  assert.equal(updated.data.data.email, updateBody.email);
  assert.equal(updated.data.data.passwordReset, true);
  assert.equal(updated.data.data.temporaryPassword, undefined);
  assert.equal(updated.data.data.password_hash, undefined);
  assert.equal((await w.login(createBody.email, createBody.temporaryPassword)).response.status, 401);
  assert.equal((await w.login(updateBody.email, updateBody.temporaryPassword)).response.status, 200);
});
