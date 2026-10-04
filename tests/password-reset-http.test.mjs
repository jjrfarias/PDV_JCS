import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { sha256 } from '../src/security.mjs';
import { fixture, PASSWORD } from './helpers.mjs';
import { connect } from '../src/database.mjs';

const NEW_PASSWORD = 'NovaSenhaRecuperada2026';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function web(t) {
  const { db } = fixture(t);
  const outbox = [];
  const mailer = { async sendPasswordReset(message) { outbox.push(message); } };
  const server = createApp(db, { mailer });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'POST', body, cookie = '', headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, data: await response.json() };
  }
  async function login(email = 'gerente@jcs.local', password = PASSWORD, tenant = 'demo') {
    const result = await call('/api/login', { body: { tenant, email, password } });
    return { status: result.response.status, cookie: result.response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  const forgot = (email = 'gerente@jcs.local', tenant = 'demo') => call('/api/password/forgot', { body: { tenant, email } });
  const reset = (token, newPassword = NEW_PASSWORD) => call('/api/password/reset', { body: { token, newPassword } });
  async function lastToken() {
    await tick();
    const link = outbox.at(-1)?.link ?? '';
    return link.match(/#redefinir=([\w-]{43})$/)?.[1];
  }
  return { db, origin, outbox, call, login, forgot, reset, lastToken };
}

test('password reset by e-mail link changes the password once and ends sessions', async t => {
  const w = await web(t);
  const before = await w.login();
  assert.equal(before.status, 200);

  const requested = await w.forgot('GERENTE@jcs.local');
  assert.equal(requested.response.status, 200);
  assert.deepEqual(requested.data, { ok: true });
  const token = await w.lastToken();
  assert.ok(token, 'link sent with token in URL fragment');
  assert.equal(w.outbox.length, 1);
  assert.equal(w.outbox[0].to, 'gerente@jcs.local');
  assert.ok(w.outbox[0].link.startsWith(`${w.origin}/#redefinir=`));

  const stored = w.db.prepare('SELECT token_hash FROM password_resets').all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].token_hash, sha256(token));
  assert.notEqual(stored[0].token_hash, token);

  const done = await w.reset(token);
  assert.equal(done.response.status, 200);
  assert.equal((await w.call('/api/me', { method: 'GET', cookie: before.cookie })).response.status, 401);
  assert.equal((await w.login()).status, 401);
  assert.equal((await w.login('gerente@jcs.local', NEW_PASSWORD)).status, 200);

  const reused = await w.reset(token, 'OutraSenhaNova2026');
  assert.equal(reused.response.status, 400);
  assert.equal(reused.data.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await w.login('gerente@jcs.local', NEW_PASSWORD)).status, 200);

  const audit = w.db.prepare("SELECT action,details_json FROM audit_events WHERE action LIKE 'PASSWORD_RESET_%' ORDER BY action").all();
  assert.deepEqual(audit.map(row => row.action), ['PASSWORD_RESET_COMPLETED', 'PASSWORD_RESET_REQUESTED']);
  assert.ok(audit.every(row => row.details_json === '{}'));
});

test('password reset answers the same for unknown accounts and other tenants', async t => {
  const w = await web(t);
  const unknown = await w.forgot('ninguem@jcs.local');
  const otherTenant = await w.forgot('gerente@jcs.local', 'outra');
  const missingTenant = await w.forgot('gerente@jcs.local', 'inexistente');
  for (const result of [unknown, otherTenant, missingTenant]) {
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.data, { ok: true });
  }
  await w.lastToken();
  assert.equal(w.outbox.length, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM password_resets').get().n, 0);
});

test('a new request invalidates the previous link', async t => {
  const w = await web(t);
  await w.forgot();
  const first = await w.lastToken();
  await w.forgot();
  const second = await w.lastToken();
  assert.notEqual(first, second);
  assert.equal((await w.reset(first)).data.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await w.reset(second)).response.status, 200);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM password_resets').get().n, 2, 'history is kept, not deleted');
});

test('weak password keeps the link usable and expired links are refused', async t => {
  const w = await web(t);
  await w.forgot();
  const token = await w.lastToken();
  const weak = await w.reset(token, 'curta');
  assert.equal(weak.response.status, 400);
  assert.equal((await w.reset(token, 'semnumeroesemmaiuscula')).data.error.code, 'WEAK_PASSWORD');

  w.db.prepare('UPDATE password_resets SET expires_at=?').run(Date.now() - 1);
  const expired = await w.reset(token);
  assert.equal(expired.response.status, 400);
  assert.equal(expired.data.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await w.login()).status, 200);
});

test('inactive users cannot finish a reset', async t => {
  const w = await web(t);
  await w.forgot('operador@jcs.local');
  const token = await w.lastToken();
  w.db.prepare("UPDATE users SET active=0 WHERE email='operador@jcs.local'").run();
  assert.equal((await w.reset(token)).data.error.code, 'INVALID_RESET_TOKEN');
});

test('password reset rejects malformed tokens, foreign origins and abuse', async t => {
  const w = await web(t);
  assert.equal((await w.reset('nao-e-um-token')).data.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await w.reset('a'.repeat(43))).data.error.code, 'INVALID_RESET_TOKEN');
  const foreign = await w.call('/api/password/forgot', { body: { tenant: 'demo', email: 'gerente@jcs.local' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.response.status, 403);
  const extra = await w.call('/api/password/forgot', { body: { tenant: 'demo', email: 'gerente@jcs.local', tenantId: 'x' } });
  assert.equal(extra.response.status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await w.forgot()).response.status, 200);
  const limited = await w.forgot();
  assert.equal(limited.response.status, 429);
  assert.equal(limited.data.error.code, 'RESET_RATE_LIMIT');
});

test('local SQLite database at version 8 upgrades to password resets and platform admin', async t => {
  const { db, filename } = fixture(t, { file: true });
  // Reproduz um banco real da versão 8: sem recuperação de senha, sem plataforma e tenants sem coluna active.
  db.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE password_resets; DROP TABLE platform_audit_events; DROP TABLE platform_operations;
    DROP TABLE platform_password_resets; DROP TABLE platform_sessions; DROP TABLE platform_admins;
    CREATE TABLE tenants_v8 (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL) STRICT;
    INSERT INTO tenants_v8 SELECT id,slug,name FROM tenants; DROP TABLE tenants; ALTER TABLE tenants_v8 RENAME TO tenants;
    PRAGMA user_version=8;`);
  db.close();
  const upgraded = connect(filename);
  const version = upgraded.prepare('PRAGMA user_version').get().user_version;
  const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('password_resets','platform_admins','platform_sessions','platform_password_resets','platform_operations','platform_audit_events') ORDER BY name").all().map(row => row.name);
  const active = upgraded.prepare('SELECT DISTINCT active FROM tenants').all().map(row => row.active);
  upgraded.close();
  assert.equal(version, 11);
  assert.deepEqual(tables, ['password_resets','platform_admins','platform_audit_events','platform_operations','platform_password_resets','platform_sessions']);
  assert.deepEqual(active, [1]);
});
