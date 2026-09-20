import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requireThat, text, object } from './errors.mjs';
import { one, run, withPostgresTransaction } from './postgres.mjs';

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
async function verifyPassword(password, encoded) {
  const [algorithm, salt, hash] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !/^[0-9a-f]{128}$/.test(hash)) return false;
  const candidate = await derive(password, salt, 64, SCRYPT);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}
export class Auth {
  constructor(db) { this.db = db; this.limits = new Map(); this.dummyHash = hashPassword(randomToken()); }
  async login(input, ip) {
    object(input, ['tenant','email','password']);
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
        WHERE t.slug=? AND u.email=? AND u.active=1`).get(tenant, email);
    const valid = await verifyPassword(password, user?.password_hash ?? this.dummyHash);
    requireThat(user && valid, 401, 'INVALID_LOGIN', 'Empresa, e-mail ou senha inválidos.');
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
        WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(sha256(token),Date.now());
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
}
