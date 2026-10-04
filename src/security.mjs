import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requireThat, text, object } from './errors.mjs';
import { one, run, withPostgresTransaction } from './postgres.mjs';
import { transaction } from './database.mjs';
import { createMailer } from './mailer.mjs';
import { totpSecret, verifyTotp, otpauthUri } from './totp.mjs';

const RESET_TTL_MS = 30 * 60_000;
const strongPassword = value => /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);

const derive = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
function fieldKey() {
  const raw = process.env.JCS_FIELD_ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {}
  return null;
}
export const hasFieldEncryptionKey = () => Boolean(fieldKey());
export function encryptField(value) {
  if (value === null || value === undefined || value === '') return null;
  const key = fieldKey();
  requireThat(key, 500, 'FIELD_ENCRYPTION_KEY_REQUIRED', 'Chave de criptografia de dados sensíveis não configurada.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}
export function decryptField(value) {
  if (!value) return null;
  const key = fieldKey();
  requireThat(key, 500, 'FIELD_ENCRYPTION_KEY_REQUIRED', 'Chave de criptografia de dados sensíveis não configurada.');
  const [version, iv, tag, encrypted] = String(value).split(':');
  requireThat(version === 'v1' && iv && tag && encrypted, 500, 'INVALID_ENCRYPTED_FIELD', 'Dado sensível inválido.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}
export function fieldDigest(value) {
  if (!value) return null;
  const key = fieldKey();
  requireThat(key, 500, 'FIELD_ENCRYPTION_KEY_REQUIRED', 'Chave de criptografia de dados sensíveis não configurada.');
  return createHmac('sha256', key).update(String(value)).digest('hex');
}
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64, SCRYPT).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [algorithm, salt, hash] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(hash)) return false;
  const candidate = await derive(password, salt, 64, SCRYPT);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
export class Auth {
  constructor(db, { mailer = createMailer() } = {}) {
    this.db = db; this.mailer = mailer; this.limits = new Map(); this.dummyHash = hashPassword(randomToken());
  }
  limit(keys, code, messageText) {
    const now = Date.now();
    for (const [key, entry] of this.limits) if (entry.until <= now) this.limits.delete(key);
    for (const [key, max] of keys) {
      const entry = this.limits.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      requireThat(entry.count < max, 429, code, messageText);
      entry.count++;
      this.limits.set(key, entry);
    }
  }
  auditReset(runner, action, tenantId, userId, resetId) {
    // Auditoria sem token nem e-mail. Vincula à primeira loja do usuário, exigida pela tabela.
    const iso = new Date().toISOString();
    if (typeof this.db.query === 'function') {
      return one(runner, 'SELECT store_id FROM memberships WHERE tenant_id=$1 AND user_id=$2 ORDER BY store_id LIMIT 1', [tenantId, userId])
        .then(store => store && run(runner, `INSERT INTO audit_events(tenant_id,id,user_id,store_id,action,entity_id,details_json,created_at)
          VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, [tenantId, randomUUID(), userId, store.store_id, action, resetId, iso]));
    }
    const store = this.db.prepare('SELECT store_id FROM memberships WHERE tenant_id=? AND user_id=? ORDER BY store_id LIMIT 1').get(tenantId, userId);
    if (store) this.db.prepare("INSERT INTO audit_events VALUES(?,?,?,?,?,?,'{}',?)").run(tenantId, randomUUID(), userId, store.store_id, action, resetId, iso);
  }
  // Resposta sempre igual, exista ou não a conta, para não revelar e-mails cadastrados.
  async requestPasswordReset(input, ip, origin) {
    object(input, ['tenant', 'email']);
    const tenant = text(input.tenant, 'Empresa', 60).toLowerCase();
    const email = text(input.email, 'E-mail', 120).toLowerCase();
    this.limit([[`reset-ip:${ip}`, 10], [`reset-account:${tenant}:${email}`, 3]],
      'RESET_RATE_LIMIT', 'Muitos pedidos de recuperação. Tente novamente em 15 minutos.');
    const postgres = typeof this.db.query === 'function';
    const user = postgres
      ? await one(this.db, 'SELECT * FROM public.pdv_login_user($1,$2)', [tenant, email])
      : this.db.prepare(`SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id
        WHERE t.slug=? AND u.email=? AND u.active=1 AND t.active=1`).get(tenant, email);
    if (!user) return { ok: true };
    const token = randomToken();
    const id = randomUUID();
    const now = Date.now();
    if (postgres) {
      await withPostgresTransaction(this.db, async client => {
        // Um pedido novo invalida os links anteriores, sem apagar o histórico.
        await run(client, 'UPDATE password_resets SET used_at=$1 WHERE tenant_id=$2 AND user_id=$3 AND used_at IS NULL', [now, user.tenant_id, user.id]);
        await run(client, 'INSERT INTO password_resets(tenant_id,id,user_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [user.tenant_id, id, user.id, sha256(token), now + RESET_TTL_MS, now]);
        await this.auditReset(client, 'PASSWORD_RESET_REQUESTED', user.tenant_id, user.id, id);
      }, { tenantId: user.tenant_id, userId: user.id });
    } else {
      transaction(this.db, () => {
        this.db.prepare('UPDATE password_resets SET used_at=? WHERE tenant_id=? AND user_id=? AND used_at IS NULL').run(now, user.tenant_id, user.id);
        this.db.prepare('INSERT INTO password_resets(tenant_id,id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)')
          .run(user.tenant_id, id, user.id, sha256(token), now + RESET_TTL_MS, now);
        this.auditReset(this.db, 'PASSWORD_RESET_REQUESTED', user.tenant_id, user.id, id);
      });
    }
    // Sem await: a resposta não espera o provedor, então o tempo não revela se a conta existe.
    // O token vai no fragmento (#), que o navegador não envia ao servidor nem no Referer.
    Promise.resolve()
      .then(() => this.mailer.sendPasswordReset({ to: user.email, link: `${origin}/#redefinir=${token}` }))
      .catch(error => console.error('Falha ao enviar e-mail de recuperação:',
        String(error?.message ?? '').startsWith('MAIL_PROVIDER_') ? error.message : (error?.name ?? 'Error')));
    return { ok: true };
  }
  async resetPassword(input, ip) {
    object(input, ['token', 'newPassword']);
    this.limit([[`reset-confirm-ip:${ip}`, 20]], 'RESET_RATE_LIMIT', 'Muitas tentativas. Tente novamente em 15 minutos.');
    const invalid = () => requireThat(false, 400, 'INVALID_RESET_TOKEN', 'Link de recuperação inválido ou expirado. Solicite um novo.');
    const token = typeof input.token === 'string' ? input.token : '';
    if (!/^[\w-]{43}$/.test(token)) invalid();
    const newPassword = text(input.newPassword, 'Nova senha', 200, 12);
    requireThat(strongPassword(newPassword), 400, 'WEAK_PASSWORD', 'A nova senha deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    const tokenHash = sha256(token);
    const now = Date.now();
    const passwordHash = hashPassword(newPassword);
    if (typeof this.db.query === 'function') {
      const found = await one(this.db, 'SELECT * FROM public.pdv_password_reset_lookup($1)', [tokenHash]);
      if (!found) invalid();
      await withPostgresTransaction(this.db, async client => {
        // Consumo atômico: dois envios simultâneos do mesmo link não redefinem a senha duas vezes.
        const used = await run(client, `UPDATE password_resets SET used_at=$1
          WHERE tenant_id=$2 AND id=$3 AND token_hash=$4 AND used_at IS NULL AND expires_at>$1`, [now, found.tenant_id, found.id, tokenHash]);
        if (used.changes !== 1) invalid();
        const updated = await run(client, 'UPDATE users SET password_hash=$1 WHERE tenant_id=$2 AND id=$3 AND active=1', [passwordHash, found.tenant_id, found.user_id]);
        if (updated.changes !== 1) invalid();
        await run(client, 'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2', [found.tenant_id, found.user_id]);
        await this.auditReset(client, 'PASSWORD_RESET_COMPLETED', found.tenant_id, found.user_id, found.id);
      }, { tenantId: found.tenant_id, userId: found.user_id });
    } else {
      transaction(this.db, () => {
        const found = this.db.prepare(`SELECT r.tenant_id,r.id,r.user_id FROM password_resets r
          JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.user_id
          JOIN tenants t ON t.id=r.tenant_id
          WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1 AND t.active=1`).get(tokenHash, now);
        if (!found) invalid();
        this.db.prepare('UPDATE password_resets SET used_at=? WHERE tenant_id=? AND id=?').run(now, found.tenant_id, found.id);
        this.db.prepare('UPDATE users SET password_hash=? WHERE tenant_id=? AND id=?').run(passwordHash, found.tenant_id, found.user_id);
        this.db.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=?').run(found.tenant_id, found.user_id);
        this.auditReset(this.db, 'PASSWORD_RESET_COMPLETED', found.tenant_id, found.user_id, found.id);
      });
    }
    return { ok: true };
  }
  async login(input, ip) {
    object(input, ['tenant','email','password','code']);
    const tenant = text(input.tenant, 'Empresa', 60).toLowerCase();
    const email = text(input.email, 'E-mail', 120).toLowerCase();
    const password = text(input.password, 'Senha', 200, 1);
    const now = Date.now();
    for (const [key, entry] of this.limits) if (entry.until <= now) this.limits.delete(key);
    const keys = [`ip:${ip}`, `account:${ip}:${tenant}:${email}`];
    keys.forEach((key, index) => {
      const entry = this.limits.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      requireThat(entry.count < (index === 0 ? 30 : 8), 429, 'LOGIN_RATE_LIMIT', 'Muitas tentativas. Tente novamente em 15 minutos.');
      entry.count++;
      this.limits.set(key, entry);
    });
    const postgres = typeof this.db.query === 'function';
    const user = postgres
      ? await one(this.db, 'SELECT * FROM public.pdv_login_user($1,$2)', [tenant,email])
      : this.db.prepare(`SELECT u.*, t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id
        WHERE t.slug=? AND u.email=? AND u.active=1 AND t.active=1`).get(tenant, email);
    const valid = await verifyPassword(password, user?.password_hash ?? this.dummyHash);
    requireThat(user && valid, 401, 'INVALID_LOGIN', 'Empresa, e-mail ou senha inválidos.');
    if(user.role==='MANAGER'&&user.mfa_enabled===1) requireThat(verifyTotp(decryptField(user.mfa_secret_enc),input.code),401,'MFA_REQUIRED',
      input.code?'Código de autenticação inválido.':'Informe o código do aplicativo autenticador.');
    const token = randomToken();
    const csrfToken = randomToken();
    // Revalidar depois do scrypt; o lock impede desativação no meio da criação da sessão.
    if (postgres) {
      await withPostgresTransaction(this.db, async client => {
        const current = await one(client, 'SELECT active,password_hash FROM users WHERE tenant_id=$1 AND id=$2 FOR SHARE', [user.tenant_id,user.id]);
        requireThat(current?.active===1 && current.password_hash===user.password_hash,401,'INVALID_LOGIN','Acesso indisponível.');
        await run(client,'DELETE FROM sessions WHERE tenant_id=$1 AND expires_at<$2',[user.tenant_id,now]);
        await run(client,`INSERT INTO sessions(token_hash,tenant_id,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,$5)`,
          [sha256(token),user.tenant_id,user.id,csrfToken,now+12*60*60_000]);
      }, {tenantId:user.tenant_id,userId:user.id});
    } else {
      const current=this.db.prepare('SELECT active,password_hash FROM users WHERE tenant_id=? AND id=?').get(user.tenant_id,user.id);
      requireThat(current?.active===1 && current.password_hash===user.password_hash,401,'INVALID_LOGIN','Acesso indisponível.');
      this.db.prepare('DELETE FROM sessions WHERE tenant_id=? AND expires_at<?').run(user.tenant_id,now);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(sha256(token),user.tenant_id,user.id,csrfToken,now+12*60*60_000);
    }
    return { token, csrfToken };
  }
  async resolve(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('jcs_session='))?.slice(12);
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const session = typeof this.db.query === 'function'
      ? await one(this.db,'SELECT * FROM public.pdv_resolve_session($1)',[sha256(token)])
      : this.db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
        JOIN tenants t ON t.id=s.tenant_id
        WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND t.active=1`).get(sha256(token),Date.now());
    return session ? { tenantId: session.tenant_id, userId: session.user_id, csrfToken: session.csrf_token, tokenHash: session.token_hash } : null;
  }
  async logout(ctx) {
    if (typeof this.db.query === 'function') {
      await withPostgresTransaction(this.db, client => run(client,
        'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND token_hash=$3', [ctx.tenantId,ctx.userId,ctx.tokenHash]), ctx);
    } else this.db.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=? AND token_hash=?').run(ctx.tenantId,ctx.userId,ctx.tokenHash);
  }
  async changePassword(ctx, input) {
    object(input, ['currentPassword', 'newPassword']);
    const currentPassword = text(input.currentPassword, 'Senha atual', 200, 1);
    const newPassword = text(input.newPassword, 'Nova senha', 200, 12);
    requireThat(/[A-Z]/.test(newPassword) && /[a-z]/.test(newPassword) && /\d/.test(newPassword),
      400, 'WEAK_PASSWORD', 'A nova senha deve ter 12 caracteres, com letras maiúsculas, minúsculas e número.');
    requireThat(currentPassword !== newPassword, 400, 'SAME_PASSWORD', 'A nova senha deve ser diferente da senha atual.');
    if (typeof this.db.query === 'function') {
      await withPostgresTransaction(this.db, async client => {
        const user = await one(client, 'SELECT password_hash FROM users WHERE tenant_id=$1 AND id=$2 AND active=1 FOR UPDATE',
          [ctx.tenantId, ctx.userId]);
        requireThat(user, 401, 'AUTH_REQUIRED', 'Faça login novamente.');
        requireThat(await verifyPassword(currentPassword, user.password_hash), 403, 'INVALID_PASSWORD', 'Senha atual incorreta.');
        await run(client, 'UPDATE users SET password_hash=$1 WHERE tenant_id=$2 AND id=$3',
          [hashPassword(newPassword), ctx.tenantId, ctx.userId]);
        await run(client, 'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND token_hash<>$3',
          [ctx.tenantId, ctx.userId, ctx.tokenHash]);
      }, { tenantId: ctx.tenantId, userId: ctx.userId });
    } else {
      const user = this.db.prepare('SELECT password_hash FROM users WHERE tenant_id=? AND id=? AND active=1').get(ctx.tenantId, ctx.userId);
      requireThat(user, 401, 'AUTH_REQUIRED', 'Faça login novamente.');
      requireThat(await verifyPassword(currentPassword, user.password_hash), 403, 'INVALID_PASSWORD', 'Senha atual incorreta.');
      this.db.prepare('UPDATE users SET password_hash=? WHERE tenant_id=? AND id=?').run(hashPassword(newPassword), ctx.tenantId, ctx.userId);
      this.db.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=? AND token_hash<>?').run(ctx.tenantId, ctx.userId, ctx.tokenHash);
    }
    return { ok: true };
  }
  async beginMfa(ctx) {
    const postgres=typeof this.db.query==='function';
    const user=postgres?await one(this.db,'SELECT email,role FROM users WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,ctx.userId])
      :this.db.prepare('SELECT email,role FROM users WHERE tenant_id=? AND id=?').get(ctx.tenantId,ctx.userId);
    requireThat(user?.role==='MANAGER',403,'MANAGER_REQUIRED','Apenas gerentes podem ativar MFA.');
    const secret=totpSecret(),encrypted=encryptField(secret);
    if(postgres)await withPostgresTransaction(this.db,client=>run(client,'UPDATE users SET mfa_pending_secret_enc=$1 WHERE tenant_id=$2 AND id=$3',[encrypted,ctx.tenantId,ctx.userId]),ctx);
    else this.db.prepare('UPDATE users SET mfa_pending_secret_enc=? WHERE tenant_id=? AND id=?').run(encrypted,ctx.tenantId,ctx.userId);
    return {secret,uri:otpauthUri(secret,user.email)};
  }
  async confirmMfa(ctx,input) {
    object(input,['code']);const code=text(input.code,'Código',6,6),postgres=typeof this.db.query==='function';
    if(postgres)await withPostgresTransaction(this.db,async client=>{const user=await one(client,'SELECT role,mfa_pending_secret_enc FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,ctx.userId]);
      requireThat(user?.role==='MANAGER'&&user.mfa_pending_secret_enc,400,'MFA_NOT_STARTED','Inicie a configuração novamente.');requireThat(verifyTotp(decryptField(user.mfa_pending_secret_enc),code),400,'INVALID_MFA_CODE','Código de autenticação inválido.');
      await run(client,'UPDATE users SET mfa_secret_enc=mfa_pending_secret_enc,mfa_pending_secret_enc=NULL,mfa_enabled=1 WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,ctx.userId]);await run(client,'DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND token_hash<>$3',[ctx.tenantId,ctx.userId,ctx.tokenHash]);await this.auditReset(client,'MFA_ENABLED',ctx.tenantId,ctx.userId,ctx.userId);},ctx);
    else transaction(this.db,()=>{const user=this.db.prepare('SELECT role,mfa_pending_secret_enc FROM users WHERE tenant_id=? AND id=?').get(ctx.tenantId,ctx.userId);requireThat(user?.role==='MANAGER'&&user.mfa_pending_secret_enc,400,'MFA_NOT_STARTED','Inicie a configuração novamente.');requireThat(verifyTotp(decryptField(user.mfa_pending_secret_enc),code),400,'INVALID_MFA_CODE','Código de autenticação inválido.');this.db.prepare('UPDATE users SET mfa_secret_enc=mfa_pending_secret_enc,mfa_pending_secret_enc=NULL,mfa_enabled=1 WHERE tenant_id=? AND id=?').run(ctx.tenantId,ctx.userId);this.db.prepare('DELETE FROM sessions WHERE tenant_id=? AND user_id=? AND token_hash<>?').run(ctx.tenantId,ctx.userId,ctx.tokenHash);this.auditReset(this.db,'MFA_ENABLED',ctx.tenantId,ctx.userId,ctx.userId);});
    return {ok:true};
  }
}
