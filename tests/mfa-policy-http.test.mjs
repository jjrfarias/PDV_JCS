import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { fixture, PASSWORD, DEMO, key, testMfaCode } from './helpers.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function web(t, options) {
  const { db } = fixture(t, options);
  const outbox = [];
  const mailer = Object.fromEntries(['sendPasswordReset', 'sendInvite', 'sendPasswordChanged'].map(kind => [kind, async message => { outbox.push({ kind, ...message }); }]));
  const server = createApp(db, { mailer });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { cookie: '', csrf: '' };
  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json(), response };
  }
  async function login(email, password = PASSWORD) {
    const result = await call('/api/login', { method: 'POST', body: { tenant: 'demo', email, password, code: testMfaCode(db, 'users', email) } });
    assert.equal(result.status, 200);
    session.cookie = result.response.headers.get('set-cookie').split(';')[0]; session.csrf = result.data.csrfToken;
  }
  return { db, outbox, call, login };
}

test('manager without MFA can only set up MFA, change password or log out', async t => {
  const w = await web(t, { mfa: false });
  await w.login('gerente@jcs.local');
  assert.equal((await w.call('/api/me')).status, 200);
  for (const path of [`/api/stores/${DEMO.storeA}/state`, '/api/network/overview?from=2026-10-01&to=2026-10-01']) {
    const blocked = await w.call(path);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.error.code, 'MFA_SETUP_REQUIRED');
  }
  const write = await w.call('/api/products', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: {} });
  assert.equal(write.data.error.code, 'MFA_SETUP_REQUIRED');
  assert.equal((await w.call('/api/me/mfa/start', { method: 'POST', body: {} })).status, 200);
  assert.equal((await w.call('/api/logout', { method: 'POST', body: {} })).status, 200);
});

test('cashiers are not required to use MFA', async t => {
  const w = await web(t, { mfa: false });
  await w.login('operador@jcs.local');
  assert.equal((await w.call(`/api/stores/${DEMO.storeA}/state`)).status, 200);
});

test('account owner is told by e-mail when the password changes', async t => {
  const w = await web(t);
  // Troca pela própria pessoa.
  await w.login('gerente@jcs.local');
  assert.equal((await w.call('/api/me/password', { method: 'POST', body: { currentPassword: PASSWORD, newPassword: 'NovaSenhaGerente2026' } })).status, 200);
  await tick();
  assert.deepEqual(w.outbox.map(m => [m.kind, m.to]), [['sendPasswordChanged', 'gerente@jcs.local']]);

  // Redefinição pelo gerente para outra pessoa: avisa o dono da conta, não o gerente.
  const reset = await w.call('/api/users/update', { method: 'POST', headers: { 'Idempotency-Key': key() }, body: {
    storeId: DEMO.storeA, userId: DEMO.cashier.userId, email: 'operador@jcs.local', name: 'Operador de demonstração', role: 'CASHIER', active: 1, temporaryPassword: 'SenhaTemporaria2026' } });
  assert.equal(reset.status, 201);
  await tick();
  assert.deepEqual(w.outbox.at(-1), { kind: 'sendPasswordChanged', to: 'operador@jcs.local' });

  // Redefinição por link de recuperação.
  assert.equal((await w.call('/api/password/forgot', { method: 'POST', body: { tenant: 'demo', email: 'operador@jcs.local' } })).status, 200);
  await tick();
  const token = w.outbox.at(-1).link.match(/#redefinir=([\w-]{43})$/)[1];
  assert.equal((await w.call('/api/password/reset', { method: 'POST', body: { token, newPassword: 'OutraSenhaOperador2026' } })).status, 200);
  await tick();
  assert.deepEqual(w.outbox.at(-1), { kind: 'sendPasswordChanged', to: 'operador@jcs.local' });
  // Nenhum aviso carrega senha nem link.
  assert.ok(w.outbox.filter(m => m.kind === 'sendPasswordChanged').every(m => Object.keys(m).join() === 'kind,to'));
});
