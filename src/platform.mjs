// Administração do sistema, acima dos tenants.
// Escopo decidido: gerir contratantes (listar, criar com primeira loja/gerente, ativar/desativar).
// Este módulo NÃO lê vendas, caixa, clientes, produtos nem estoque de nenhum tenant.
import { randomUUID } from 'node:crypto';
import { AppError, requireThat, text, object, id as checkId, operationKey } from './errors.mjs';
import { withPostgresTransaction } from './postgres.mjs';
import { sha256, randomToken, hashPassword, verifyPassword, encryptField, decryptField } from './security.mjs';
import { totpSecret, verifyTotp, otpauthUri, totpStep, currentTotpStep } from './totp.mjs';
import { createMailer } from './mailer.mjs';

const SESSION_TTL_MS = 8 * 60 * 60_000;
const RESET_TTL_MS = 30 * 60_000;
const INVITE_TTL_MS = 24 * 60 * 60_000;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const strongPassword = value => /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
const email = (value, name = 'E-mail') => {
  const result = text(value, name, 120).toLowerCase();
  requireThat(EMAIL.test(result), 400, 'INVALID_INPUT', `${name}: formato inválido.`);
  return result;
};
const unique = error => error?.code === '23505' || /UNIQUE constraint failed/.test(error?.message ?? '');

// Mesma consulta nos dois bancos: SQL escrito com $1..$n e convertido para ? no SQLite.
function sqlite(db) {
  const prepare = (sql, params) => {
    const order = [...sql.matchAll(/\$(\d+)/g)].map(match => params[Number(match[1]) - 1]);
    return [db.prepare(sql.replace(/\$\d+/g, '?')), order];
  };
  return {
    async all(sql, params = []) { const [statement, values] = prepare(sql, params); return statement.all(...values); },
    async one(sql, params = []) { const [statement, values] = prepare(sql, params); return statement.get(...values) ?? null; },
    async run(sql, params = []) { const [statement, values] = prepare(sql, params); return { changes: Number(statement.run(...values).changes) }; }
  };
}
function postgres(client) {
  return {
    async all(sql, params = []) { return (await client.query(sql, params)).rows; },
    async one(sql, params = []) { return (await client.query(sql, params)).rows[0] ?? null; },
    async run(sql, params = []) { return { changes: (await client.query(sql, params)).rowCount }; }
  };
}

export class Platform {
  constructor(db, { mailer = createMailer() } = {}) {
    this.db = db; this.mailer = mailer; this.pg = typeof db.query === 'function';
    this.limits = new Map(); this.dummyHash = hashPassword(randomToken());
    this.q = this.pg ? postgres(db) : sqlite(db);
  }
  // No SQLite, o trabalho só faz chamadas síncronas ao banco entre BEGIN e COMMIT; nenhuma E/S real é aguardada.
  async tx(scope, work) {
    if (this.pg) return withPostgresTransaction(this.db, client => work(postgres(client)), scope);
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = await work(this.q); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  limit(keys, code, message) {
    const now = Date.now();
    for (const [key, entry] of this.limits) if (entry.until <= now) this.limits.delete(key);
    for (const [key, max] of keys) {
      const entry = this.limits.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      requireThat(entry.count < max, 429, code, message);
      entry.count++; this.limits.set(key, entry);
    }
  }
  async audit(q, adminId, action, entityId, details = {}) {
    await q.run('INSERT INTO platform_audit_events(id,admin_id,action,entity_id,details_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), adminId, action, entityId, JSON.stringify(details), Date.now()]);
  }
  send(kind, message) {
    // Sem await: a resposta não depende do provedor. Falhas ficam no log sem link nem endereço.
    Promise.resolve().then(() => this.mailer[kind](message)).catch(error => console.error('Falha ao enviar e-mail da plataforma:',
      String(error?.message ?? '').startsWith('MAIL_PROVIDER_') ? error.message : (error?.name ?? 'Error')));
  }

  async login(input, ip) {
    object(input, ['email', 'password', 'code']);
    const address = text(input.email, 'E-mail', 120).toLowerCase();
    const password = text(input.password, 'Senha', 200, 1);
    this.limit([[`admin-ip:${ip}`, 20], [`admin-account:${ip}:${address}`, 5]], 'LOGIN_RATE_LIMIT', 'Muitas tentativas. Tente novamente em 15 minutos.');
    const admin = await this.q.one('SELECT * FROM platform_admins WHERE email=$1 AND active=1', [address]);
    const valid = await verifyPassword(password, admin?.password_hash ?? this.dummyHash);
    requireThat(admin && valid, 401, 'INVALID_LOGIN', 'E-mail ou senha inválidos.');
    let mfaStep = null;
    if (admin.mfa_enabled === 1) {
      mfaStep = totpStep(decryptField(admin.mfa_secret_enc), input.code);
      requireThat(mfaStep !== null, 401, 'MFA_REQUIRED',
        input.code ? 'Código de autenticação inválido.' : 'Informe o código do aplicativo autenticador.');
    }
    const token = randomToken(); const csrfToken = randomToken(); const now = Date.now();
    await this.tx({}, async q => {
      const current = await q.one('SELECT active,password_hash FROM platform_admins WHERE id=$1', [admin.id]);
      requireThat(current?.active === 1 && current.password_hash === admin.password_hash, 401, 'INVALID_LOGIN', 'Acesso indisponível.');
      if (mfaStep !== null) {
        const used = await q.run('UPDATE platform_admins SET mfa_last_step=$1 WHERE id=$2 AND (mfa_last_step IS NULL OR mfa_last_step<$1)', [mfaStep, admin.id]);
        requireThat(used.changes === 1, 401, 'MFA_CODE_REUSED', 'Este código já foi usado. Aguarde o próximo código do aplicativo.');
      }
      await q.run('DELETE FROM platform_sessions WHERE expires_at<$1', [now]);
      await q.run('INSERT INTO platform_sessions(token_hash,admin_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)', [sha256(token), admin.id, csrfToken, now + SESSION_TTL_MS]);
      await this.audit(q, admin.id, 'PLATFORM_LOGIN', admin.id);
    });
    return { token, csrfToken };
  }
  async resolve(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('jcs_admin='))?.slice(10);
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const session = await this.q.one(`SELECT s.token_hash,s.admin_id,s.csrf_token FROM platform_sessions s
      JOIN platform_admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND a.active=1`, [sha256(token), Date.now()]);
    return session ? { adminId: session.admin_id, csrfToken: session.csrf_token, tokenHash: session.token_hash } : null;
  }
  async logout(ctx) { await this.q.run('DELETE FROM platform_sessions WHERE token_hash=$1 AND admin_id=$2', [ctx.tokenHash, ctx.adminId]); }
  // Administrador sem MFA ativo só pode configurar o MFA ou sair.
  async mfaSetupPending(ctx) {
    const admin = await this.q.one('SELECT mfa_enabled FROM platform_admins WHERE id=$1', [ctx.adminId]);
    return admin?.mfa_enabled !== 1;
  }
  async me(ctx) {
    const admin = await this.q.one('SELECT id,email,name,mfa_enabled FROM platform_admins WHERE id=$1 AND active=1', [ctx.adminId]);
    requireThat(admin, 401, 'AUTH_REQUIRED', 'Faça login para continuar.');
    return { admin, csrfToken: ctx.csrfToken };
  }
  async beginMfa(ctx) {
    const admin=await this.q.one('SELECT id,email FROM platform_admins WHERE id=$1 AND active=1',[ctx.adminId]);
    requireThat(admin,401,'AUTH_REQUIRED','Faça login novamente.');
    const secret=totpSecret();
    await this.q.run('UPDATE platform_admins SET mfa_pending_secret_enc=$1 WHERE id=$2',[encryptField(secret),ctx.adminId]);
    return { secret, uri: otpauthUri(secret,admin.email) };
  }
  async confirmMfa(ctx,input) {
    object(input,['code']);const code=text(input.code,'Código',6,6);
    await this.tx({},async q=>{const admin=await q.one('SELECT mfa_pending_secret_enc FROM platform_admins WHERE id=$1',[ctx.adminId]);
      requireThat(admin?.mfa_pending_secret_enc,400,'MFA_NOT_STARTED','Inicie a configuração novamente.');
      requireThat(verifyTotp(decryptField(admin.mfa_pending_secret_enc),code),400,'INVALID_MFA_CODE','Código de autenticação inválido.');
      await q.run(`UPDATE platform_admins SET mfa_secret_enc=mfa_pending_secret_enc,mfa_pending_secret_enc=NULL,mfa_enabled=1,mfa_last_step=${currentTotpStep()} WHERE id=$1`,[ctx.adminId]);
      await q.run('DELETE FROM platform_sessions WHERE admin_id=$1 AND token_hash<>$2',[ctx.adminId,ctx.tokenHash]);
      await this.audit(q,ctx.adminId,'PLATFORM_MFA_ENABLED',ctx.adminId);
    });return {ok:true};
  }

  // Resposta idêntica com ou sem conta, para não revelar quem administra o sistema.
  async requestPasswordReset(input, ip, origin) {
    object(input, ['email']);
    const address = text(input.email, 'E-mail', 120).toLowerCase();
    this.limit([[`admin-reset-ip:${ip}`, 10], [`admin-reset-account:${address}`, 3]], 'RESET_RATE_LIMIT', 'Muitos pedidos de recuperação. Tente novamente em 15 minutos.');
    const admin = await this.q.one('SELECT id,email FROM platform_admins WHERE email=$1 AND active=1', [address]);
    if (!admin) return { ok: true };
    const token = randomToken(); const resetId = randomUUID(); const now = Date.now();
    await this.tx({}, async q => {
      await q.run('UPDATE platform_password_resets SET used_at=$1 WHERE admin_id=$2 AND used_at IS NULL', [now, admin.id]);
      await q.run('INSERT INTO platform_password_resets(id,admin_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',
        [resetId, admin.id, sha256(token), now + RESET_TTL_MS, now]);
      await this.audit(q, admin.id, 'PLATFORM_PASSWORD_RESET_REQUESTED', resetId);
    });
    this.send('sendPasswordReset', { to: admin.email, link: `${origin}/admin#redefinir=${token}` });
    return { ok: true };
  }
  async resetPassword(input, ip) {
    object(input, ['token', 'newPassword']);
    this.limit([[`admin-reset-confirm-ip:${ip}`, 20]], 'RESET_RATE_LIMIT', 'Muitas tentativas. Tente novamente em 15 minutos.');
    const invalid = () => { throw new AppError(400, 'INVALID_RESET_TOKEN', 'Link de recuperação inválido ou expirado. Solicite um novo.'); };
    const token = typeof input.token === 'string' ? input.token : '';
    if (!/^[\w-]{43}$/.test(token)) invalid();
    const newPassword = text(input.newPassword, 'Nova senha', 200, 12);
    requireThat(strongPassword(newPassword), 400, 'WEAK_PASSWORD', 'A nova senha deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    let changed = null;
    const passwordHash = hashPassword(newPassword); const now = Date.now();
    await this.tx({}, async q => {
      const found = await q.one(`SELECT r.id,r.admin_id FROM platform_password_resets r JOIN platform_admins a ON a.id=r.admin_id
        WHERE r.token_hash=$1 AND r.used_at IS NULL AND r.expires_at>$2 AND a.active=1`, [sha256(token), now]);
      if (!found) invalid();
      const used = await q.run('UPDATE platform_password_resets SET used_at=$1 WHERE id=$2 AND used_at IS NULL', [now, found.id]);
      if (used.changes !== 1) invalid();
      await q.run('UPDATE platform_admins SET password_hash=$1 WHERE id=$2', [passwordHash, found.admin_id]);
      await q.run('DELETE FROM platform_sessions WHERE admin_id=$1', [found.admin_id]);
      await this.audit(q, found.admin_id, 'PLATFORM_PASSWORD_RESET_COMPLETED', found.id);
      changed = (await q.one('SELECT email FROM platform_admins WHERE id=$1', [found.admin_id]))?.email ?? null;
    });
    if (changed) this.send('sendPasswordChanged', { to: changed });
    return { ok: true };
  }

  async listTenants() {
    const rows = this.pg
      ? await this.q.all('SELECT * FROM public.pdv_platform_tenants()')
      : await this.q.all('SELECT t.id,t.slug,t.name,t.active,(SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) user_count FROM tenants t ORDER BY t.name');
    return { tenants: rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, active: Number(row.active), userCount: Number(row.user_count) })) };
  }

  // Idempotência: mesma chave + mesmo conteúdo + mesmo administrador devolve a resposta gravada.
  async mutate(ctx, kind, key, input, scope, work) {
    operationKey(key);
    const payloadHash = sha256(JSON.stringify(input));
    return this.tx(scope, async q => {
      const previous = await q.one('SELECT admin_id,kind,payload_hash,response_json FROM platform_operations WHERE key=$1', [key]);
      if (previous) {
        requireThat(previous.admin_id === ctx.adminId && previous.kind === kind && previous.payload_hash === payloadHash,
          409, 'KEY_REUSED', 'Esta chave já foi usada em outra operação.');
        return { ...JSON.parse(previous.response_json), replayed: true };
      }
      const response = await work(q);
      await q.run('INSERT INTO platform_operations(key,admin_id,kind,payload_hash,response_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [key, ctx.adminId, kind, payloadHash, JSON.stringify(response), Date.now()]);
      return response;
    });
  }

  async createTenant(ctx, key, raw, origin) {
    object(raw, ['slug', 'name', 'storeName', 'managerName', 'managerEmail']);
    const slug = text(raw.slug, 'Identificador da empresa', 40, 3).toLowerCase();
    requireThat(SLUG.test(slug), 400, 'INVALID_SLUG', 'Identificador: use 3 a 40 letras minúsculas, números ou hífen.');
    const input = {
      slug, name: text(raw.name, 'Nome da empresa', 120, 2), storeName: text(raw.storeName, 'Nome da loja', 120, 2),
      managerName: text(raw.managerName, 'Nome do gerente', 120, 2), managerEmail: email(raw.managerEmail, 'E-mail do gerente')
    };
    const tenantId = `tenant-${randomUUID()}`, companyId = `company-${randomUUID()}`, storeId = `store-${randomUUID()}`;
    const terminalId = `terminal-${randomUUID()}`, userId = `user-${randomUUID()}`, resetId = randomUUID();
    const inviteToken = randomToken(); const now = Date.now();
    // O gerente nunca recebe senha definida por terceiros: a conta nasce com senha inutilizável e ele cria a sua pelo convite.
    const unusable = hashPassword(randomToken());
    let created = false;
    let result;
    try {
      result = await this.mutate(ctx, 'CREATE_TENANT', key, input, { tenantId }, async q => {
        await q.run('INSERT INTO tenants(id,slug,name) VALUES($1,$2,$3)', [tenantId, input.slug, input.name]);
        await q.run('INSERT INTO companies(tenant_id,id,name) VALUES($1,$2,$3)', [tenantId, companyId, input.name]);
        await q.run('INSERT INTO stores(tenant_id,id,company_id,name) VALUES($1,$2,$3,$4)', [tenantId, storeId, companyId, input.storeName]);
        await q.run('INSERT INTO terminals(tenant_id,store_id,id,name) VALUES($1,$2,$3,$4)', [tenantId, storeId, terminalId, 'Caixa 01']);
        await q.run(`INSERT INTO users(tenant_id,id,email,name,password_hash,role,company_admin) VALUES($1,$2,$3,$4,$5,'MANAGER',1)`,
          [tenantId, userId, input.managerEmail, input.managerName, unusable]);
        await q.run('INSERT INTO memberships(tenant_id,user_id,store_id) VALUES($1,$2,$3)', [tenantId, userId, storeId]);
        await q.run('INSERT INTO password_resets(tenant_id,id,user_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [tenantId, resetId, userId, sha256(inviteToken), now + INVITE_TTL_MS, now]);
        await this.audit(q, ctx.adminId, 'TENANT_CREATED', tenantId, { slug: input.slug, storeId });
        created = true;
        return { tenant: { id: tenantId, slug: input.slug, name: input.name, active: 1 }, store: { id: storeId, name: input.storeName },
          administrator: { id: userId, email: input.managerEmail, invited: true } };
      });
    } catch (error) {
      if (unique(error)) throw new AppError(409, 'SLUG_TAKEN', 'Já existe uma empresa com este identificador.');
      throw error;
    }
    if (created) this.send('sendInvite', { to: input.managerEmail, link: `${origin}/#redefinir=${inviteToken}`, tenantName: input.name, tenantSlug: input.slug, profile: 'administrador da empresa' });
    return result;
  }

  async setTenantActive(ctx, key, raw) {
    object(raw, ['tenantId', 'active']);
    const input = { tenantId: checkId(raw.tenantId), active: raw.active };
    requireThat(input.active === 0 || input.active === 1, 400, 'INVALID_INPUT', 'Status inválido.');
    return this.mutate(ctx, 'SET_TENANT_ACTIVE', key, input, { tenantId: input.tenantId }, async q => {
      const updated = await q.run('UPDATE tenants SET active=$1 WHERE id=$2', [input.active, input.tenantId]);
      requireThat(updated.changes === 1, 404, 'TENANT_NOT_FOUND', 'Empresa não encontrada.');
      // Desativar encerra imediatamente todas as sessões do tenant.
      if (input.active === 0) await q.run('DELETE FROM sessions WHERE tenant_id=$1', [input.tenantId]);
      await this.audit(q, ctx.adminId, input.active ? 'TENANT_ACTIVATED' : 'TENANT_DEACTIVATED', input.tenantId);
      return { tenant: { id: input.tenantId, active: input.active } };
    });
  }
}
