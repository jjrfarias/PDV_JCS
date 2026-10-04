import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, clientIp } from '../src/http.mjs';
import { fixture, PASSWORD, testMfaCode } from './helpers.mjs';

const railway = { NODE_ENV: 'production', RAILWAY_ENVIRONMENT: 'production' };
const req = (realIp, remote = '10.0.0.5') => ({ headers: realIp === undefined ? {} : { 'x-real-ip': realIp }, socket: { remoteAddress: remote } });

test('client IP comes from the Railway edge header only in production on Railway', () => {
  assert.equal(clientIp(req('203.0.113.7'), railway), '203.0.113.7');
  assert.equal(clientIp(req('2001:db8::1'), railway), '2001:db8::1');
  // Cabeçalho ausente ou inválido: volta para a conexão direta.
  assert.equal(clientIp(req(undefined), railway), '10.0.0.5');
  assert.equal(clientIp(req('1.2.3.4, 5.6.7.8'), railway), '10.0.0.5');
  assert.equal(clientIp(req('<script>'), railway), '10.0.0.5');
  // Fora da Railway o cabeçalho pode ser forjado e é ignorado.
  assert.equal(clientIp(req('203.0.113.7'), { NODE_ENV: 'production' }), '10.0.0.5');
  assert.equal(clientIp(req('203.0.113.7'), { RAILWAY_ENVIRONMENT: 'production' }), '10.0.0.5');
});

test('logins, failures and logouts are recorded per tenant with IP and no secrets', async t => {
  const { db } = fixture(t);
  const server = createApp(db);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, extra = {}) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const events = () => db.prepare('SELECT tenant_id,user_id,action,ip FROM access_events ORDER BY created_at,rowid').all();

  assert.equal((await post('/api/login', { tenant: 'demo', email: 'ninguem@jcs.local', password: 'x' })).status, 401);
  assert.equal(events().length, 0, 'unknown account has no tenant to own the record');

  assert.equal((await post('/api/login', { tenant: 'demo', email: 'gerente@jcs.local', password: 'senha-errada' })).status, 401);
  const ok = await post('/api/login', { tenant: 'demo', email: 'gerente@jcs.local', password: PASSWORD, code: testMfaCode(db, 'users', 'gerente@jcs.local') });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await ok.json();
  assert.equal((await post('/api/logout', {}, { Cookie: cookie, 'X-CSRF-Token': csrfToken })).status, 200);

  const recorded = events();
  assert.deepEqual(recorded.map(row => row.action), ['LOGIN_FAILED', 'LOGIN_SUCCEEDED', 'LOGOUT']);
  assert.ok(recorded.every(row => row.tenant_id === 'tenant-demo' && row.user_id === 'user-manager'));
  assert.ok(recorded.every(row => row.ip === '127.0.0.1' || row.ip === '::ffff:127.0.0.1'));
  const raw = JSON.stringify(db.prepare('SELECT * FROM access_events').all());
  assert.equal(raw.includes(PASSWORD), false);
  assert.equal(raw.includes('senha-errada'), false);
  assert.equal(raw.includes(cookie.split('=')[1]), false);
});
