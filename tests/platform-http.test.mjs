import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/http.mjs';
import { hashPassword } from '../src/security.mjs';
import { totpCode } from '../src/totp.mjs';
import { fixture, PASSWORD, key, enableTestMfa, testMfaCode } from './helpers.mjs';

const ADMIN_EMAIL = 'admin.sistema@jcs.local';
const ADMIN_PASSWORD = 'Admin-Sistema-2026';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function web(t) {
  const { db } = fixture(t);
  db.prepare('INSERT INTO platform_admins(id,email,name,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run('admin-1', ADMIN_EMAIL, 'Administrador de teste', hashPassword(ADMIN_PASSWORD), Date.now());
  enableTestMfa(db, 'platform_admins', "id='admin-1'");
  const outbox = [];
  const mailer = {
    async sendPasswordReset(message) { outbox.push({ kind: 'reset', ...message }); },
    async sendInvite(message) { outbox.push({ kind: 'invite', ...message }); }
  };
  const server = createApp(db, { mailer });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'POST', body, cookie = '', csrf = '', headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const content = await response.text();
    let data; try { data = JSON.parse(content); } catch { data = content; }
    return { response, data };
  }
  const cookieOf = result => result.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  async function adminLogin(email = ADMIN_EMAIL, password = ADMIN_PASSWORD, code = testMfaCode(db, 'platform_admins', email)) {
    const result = await call('/api/platform/login', { body: { email, password, ...(code ? { code } : {}) } });
    return { status: result.response.status, cookie: cookieOf(result), csrf: result.data.csrfToken };
  }
  async function tenantLogin(tenant, email, password) {
    const result = await call('/api/login', { body: { tenant, email, password, code: testMfaCode(db, 'users', email) } });
    return { status: result.response.status, cookie: cookieOf(result), csrf: result.data.csrfToken };
  }
  const as = session => ({
    get: path => call(path, { method: 'GET', cookie: session.cookie }),
    post: (path, body, headers = {}) => call(path, { body, cookie: session.cookie, csrf: session.csrf, headers })
  });
  async function lastLink() { await tick(); return outbox.at(-1)?.link ?? ''; }
  const tokenOf = link => link.match(/#redefinir=([\w-]{43})$/)?.[1];
  return { db, origin, outbox, call, adminLogin, tenantLogin, as, lastLink, tokenOf };
}

const NEW_TENANT = { slug: 'mercado-silva', name: 'Mercado Silva', storeName: 'Loja Centro', managerName: 'Ana Silva', managerEmail: 'ana@silva.local' };

test('admin ativa MFA TOTP e novos logins exigem código válido', async t => {
  const w=await web(t);w.db.prepare("UPDATE platform_admins SET mfa_enabled=0,mfa_secret_enc=NULL WHERE id='admin-1'").run();const admin=await w.adminLogin();
  // Sem MFA, o administrador só consegue configurar o MFA.
  assert.equal((await w.as(admin).get('/api/platform/tenants')).data.error.code,'MFA_SETUP_REQUIRED');
  const started=await w.as(admin).post('/api/platform/mfa/start',{});
  assert.match(started.data.secret,/^[A-Z2-7]{32}$/);
  assert.match(started.data.uri,/^otpauth:\/\/totp\//);
  assert.match(started.data.qrCodeDataUrl,/^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(started.data.qrCodeDataUrl.split(',')[1],'base64').subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  assert.equal((await w.as(admin).post('/api/platform/mfa/confirm',{code:totpCode(started.data.secret)})).response.status,200);
  assert.equal((await w.adminLogin(ADMIN_EMAIL,ADMIN_PASSWORD,'')).status,401);
  assert.equal((await w.adminLogin(ADMIN_EMAIL,ADMIN_PASSWORD,'000000')).status,401);
  assert.equal((await w.adminLogin(ADMIN_EMAIL,ADMIN_PASSWORD,totpCode(started.data.secret))).status,401,'confirmation code cannot be reused');
  assert.equal((await w.adminLogin(ADMIN_EMAIL,ADMIN_PASSWORD,totpCode(started.data.secret,Date.now()+30_000))).status,200);
  const stored=w.db.prepare('SELECT mfa_secret_enc,mfa_enabled FROM platform_admins WHERE id=?').get('admin-1');
  assert.equal(stored.mfa_enabled,1);assert.doesNotMatch(stored.mfa_secret_enc,new RegExp(started.data.secret));
});

test('admin page is served and admin login is separate from tenant sessions', async t => {
  const w = await web(t);
  const page = await w.call('/admin', { method: 'GET' });
  assert.equal(page.response.status, 200);
  assert.match(page.data, /Administração do sistema/);

  assert.equal((await w.adminLogin(ADMIN_EMAIL, 'senha-errada')).status, 401);
  const admin = await w.adminLogin();
  assert.equal(admin.status, 200);
  assert.match(admin.cookie, /^jcs_admin=/);
  const me = await w.as(admin).get('/api/platform/me');
  assert.equal(me.data.admin.email, ADMIN_EMAIL);
  assert.equal(me.data.admin.password_hash, undefined);

  const listed = await w.as(admin).get('/api/platform/tenants');
  assert.deepEqual(listed.data.tenants.map(row => row.slug).sort(), ['demo', 'outra']);
  assert.deepEqual(Object.keys(listed.data.tenants[0]).sort(), ['active', 'id', 'name', 'slug', 'userCount']);

  // Cookies não se cruzam: sessão de admin não serve no PDV, sessão de tenant não serve no painel.
  assert.equal((await w.as(admin).get('/api/me')).response.status, 401);
  const manager = await w.tenantLogin('demo', 'gerente@jcs.local', PASSWORD);
  assert.equal((await w.as(manager).get('/api/platform/me')).response.status, 401);
  assert.equal((await w.as(manager).get('/api/platform/tenants')).response.status, 401);
  assert.equal((await w.call('/api/platform/tenants', { method: 'GET' })).response.status, 401);
});

test('admin creates a tenant whose manager sets a password through the invite', async t => {
  const w = await web(t);
  const admin = w.as(await w.adminLogin());
  const opKey = key();
  const created = await admin.post('/api/platform/tenants', NEW_TENANT, { 'Idempotency-Key': opKey });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.tenant.slug, NEW_TENANT.slug);
  const link = await w.lastLink();
  assert.equal(w.outbox.length, 1);
  assert.equal(w.outbox[0].kind, 'invite');
  assert.equal(w.outbox[0].to, NEW_TENANT.managerEmail);
  assert.ok(link.startsWith(`${w.origin}/#redefinir=`));

  const replay = await admin.post('/api/platform/tenants', NEW_TENANT, { 'Idempotency-Key': opKey });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.tenant.id, created.data.tenant.id);
  await w.lastLink();
  assert.equal(w.outbox.length, 1, 'replay does not send a second invite');
  assert.equal((await admin.post('/api/platform/tenants', { ...NEW_TENANT, name: 'Outro' }, { 'Idempotency-Key': opKey })).data.error.code, 'KEY_REUSED');
  assert.equal((await admin.post('/api/platform/tenants', NEW_TENANT, { 'Idempotency-Key': key() })).data.error.code, 'SLUG_TAKEN');
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM tenants WHERE slug='mercado-silva'").get().n, 1);

  // Antes do convite o gerente não tem senha utilizável.
  assert.equal((await w.tenantLogin(NEW_TENANT.slug, NEW_TENANT.managerEmail, PASSWORD)).status, 401);
  const chosen = 'SenhaDaAna2026x';
  assert.equal((await w.call('/api/password/reset', { body: { token: w.tokenOf(link), newPassword: chosen } })).response.status, 200);
  enableTestMfa(w.db, 'users', `tenant_id='${created.data.tenant.id}' AND email='${NEW_TENANT.managerEmail}'`);
  const manager = await w.tenantLogin(NEW_TENANT.slug, NEW_TENANT.managerEmail, chosen);
  assert.equal(manager.status, 200);
  const managerMe = await w.as(manager).get('/api/me');
  assert.deepEqual(managerMe.data.stores.map(store => store.name), [NEW_TENANT.storeName]);
  assert.equal(managerMe.data.user.role, 'MANAGER');
  assert.equal(managerMe.data.user.company_admin, 1);

  const branchInput = { name: 'Loja Norte', managerName: 'Bruno Gerente', managerEmail: 'bruno@mercado.test' };
  const branchKey = key();
  const branch = await w.as(manager).post('/api/stores', branchInput, { 'Idempotency-Key': branchKey });
  assert.equal(branch.response.status, 201);
  assert.equal(branch.data.data.store.name, branchInput.name);
  assert.equal(w.db.prepare('SELECT name FROM terminals WHERE tenant_id=? AND store_id=?').get(created.data.tenant.id, branch.data.data.store.id).name, 'Caixa 01');
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM memberships WHERE tenant_id=? AND store_id=?').get(created.data.tenant.id, branch.data.data.store.id).n, 2);
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM stock WHERE tenant_id=? AND store_id=?').get(created.data.tenant.id, branch.data.data.store.id).n, 0);
  await w.lastLink();
  assert.equal(w.outbox.length, 2);
  assert.equal(w.outbox[1].to, branchInput.managerEmail);
  const branchReplay = await w.as(manager).post('/api/stores', branchInput, { 'Idempotency-Key': branchKey });
  assert.equal(branchReplay.response.status, 200);
  await w.lastLink();
  assert.equal(w.outbox.length, 2, 'replay does not resend the store manager invite');

  const commonManager = w.db.prepare("SELECT id FROM users WHERE tenant_id=? AND email=?").get(created.data.tenant.id, branchInput.managerEmail);
  w.db.prepare("UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE tenant_id=? AND email=?) WHERE tenant_id=? AND id=?")
    .run(created.data.tenant.id, NEW_TENANT.managerEmail, created.data.tenant.id, commonManager.id);
  enableTestMfa(w.db, 'users', `tenant_id='${created.data.tenant.id}' AND id='${commonManager.id}'`);
  const commonSession = await w.tenantLogin(NEW_TENANT.slug, branchInput.managerEmail, chosen);
  const forbidden = await w.as(commonSession).post('/api/stores', { name: 'Proibida', managerName: 'Outra', managerEmail: 'outra@mercado.test' }, { 'Idempotency-Key': key() });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.data.error.code, 'COMPANY_ADMIN_REQUIRED');

  const audit = w.db.prepare("SELECT action FROM platform_audit_events WHERE action='TENANT_CREATED'").all();
  assert.equal(audit.length, 1);
});

test('tenant creation validates input', async t => {
  const w = await web(t);
  const admin = w.as(await w.adminLogin());
  for (const [patch, code] of [[{ slug: 'Com Espaco' }, 'INVALID_SLUG'], [{ managerEmail: 'sem-arroba' }, 'INVALID_INPUT']]) {
    const result = await admin.post('/api/platform/tenants', { ...NEW_TENANT, ...patch }, { 'Idempotency-Key': key() });
    assert.equal(result.response.status, 400);
    assert.equal(result.data.error.code, code);
  }
  assert.equal((await admin.post('/api/platform/tenants', { ...NEW_TENANT, tenantId: 'x' }, { 'Idempotency-Key': key() })).data.error.code, 'UNKNOWN_FIELD');
  assert.equal((await admin.post('/api/platform/tenants', NEW_TENANT)).data.error.code, 'INVALID_KEY');
});

test('deactivating a tenant ends its sessions and blocks login and recovery', async t => {
  const w = await web(t);
  const admin = w.as(await w.adminLogin());
  const manager = await w.tenantLogin('demo', 'gerente@jcs.local', PASSWORD);
  const other = await w.tenantLogin('outra', 'gerente@outra.local', PASSWORD);
  assert.equal((await w.as(manager).get('/api/me')).response.status, 200);

  const off = await admin.post('/api/platform/tenants/status', { tenantId: 'tenant-demo', active: 0 }, { 'Idempotency-Key': key() });
  assert.equal(off.response.status, 201);
  assert.equal((await w.as(manager).get('/api/me')).response.status, 401);
  assert.equal((await w.tenantLogin('demo', 'gerente@jcs.local', PASSWORD)).status, 401);
  assert.equal((await w.call('/api/password/forgot', { body: { tenant: 'demo', email: 'gerente@jcs.local' } })).response.status, 200);
  await w.lastLink();
  assert.equal(w.outbox.length, 0);
  // Outro tenant não é afetado.
  assert.equal((await w.as(other).get('/api/me')).response.status, 200);

  assert.equal((await admin.post('/api/platform/tenants/status', { tenantId: 'tenant-demo', active: 1 }, { 'Idempotency-Key': key() })).response.status, 201);
  assert.equal((await w.tenantLogin('demo', 'gerente@jcs.local', PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/platform/tenants/status', { tenantId: 'nao-existe', active: 0 }, { 'Idempotency-Key': key() })).data.error.code, 'TENANT_NOT_FOUND');
});

test('platform mutations require CSRF and same origin', async t => {
  const w = await web(t);
  const session = await w.adminLogin();
  const noCsrf = await w.call('/api/platform/tenants', { body: NEW_TENANT, cookie: session.cookie, headers: { 'Idempotency-Key': key() } });
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.data.error.code, 'CSRF_FORBIDDEN');
  const foreign = await w.call('/api/platform/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, headers: { Origin: 'https://evil.example' } });
  assert.equal(foreign.response.status, 403);
});

test('admin recovers the password through a link to the admin page', async t => {
  const w = await web(t);
  const before = await w.adminLogin();
  assert.deepEqual((await w.call('/api/platform/password/forgot', { body: { email: 'ninguem@jcs.local' } })).data, { ok: true });
  await w.lastLink();
  assert.equal(w.outbox.length, 0);
  assert.deepEqual((await w.call('/api/platform/password/forgot', { body: { email: ADMIN_EMAIL.toUpperCase() } })).data, { ok: true });
  const link = await w.lastLink();
  assert.ok(link.startsWith(`${w.origin}/admin#redefinir=`));
  const token = w.tokenOf(link);
  // Token de administrador não vale no fluxo de tenant.
  assert.equal((await w.call('/api/password/reset', { body: { token, newPassword: 'NovaSenhaAdmin2026' } })).data.error.code, 'INVALID_RESET_TOKEN');
  assert.equal((await w.call('/api/platform/password/reset', { body: { token, newPassword: 'NovaSenhaAdmin2026' } })).response.status, 200);
  assert.equal((await w.as(before).get('/api/platform/me')).response.status, 401);
  assert.equal((await w.adminLogin()).status, 401);
  assert.equal((await w.adminLogin(ADMIN_EMAIL, 'NovaSenhaAdmin2026')).status, 200);
  assert.equal((await w.call('/api/platform/password/reset', { body: { token, newPassword: 'OutraSenhaAdmin2026' } })).data.error.code, 'INVALID_RESET_TOKEN');
});
