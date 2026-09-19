import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requireThat, text, object } from './errors.mjs';

const derive = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
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
    const user = this.db.prepare(`SELECT u.*, t.slug FROM users u JOIN tenants t ON t.id=u.tenant_id
      WHERE t.slug=? AND u.email=? AND u.active=1`).get(tenant, email);
    const valid = await verifyPassword(password, user?.password_hash ?? this.dummyHash);
    requireThat(user && valid, 401, 'INVALID_LOGIN', 'Empresa, e-mail ou senha inválidos.');
    // Revalidar depois do await: a conta pode ter sido desativada durante o cálculo.
    requireThat(this.db.prepare('SELECT active FROM users WHERE tenant_id=? AND id=?').get(user.tenant_id, user.id)?.active === 1,
      401, 'INVALID_LOGIN', 'Acesso indisponível.');
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    const token = randomToken();
    const csrfToken = randomToken();
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(sha256(token),user.tenant_id,user.id,csrfToken,now+12*60*60_000);
    return { token, csrfToken };
  }
  resolve(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('jcs_session='))?.slice(12);
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    const session = this.db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(sha256(token),Date.now());
    return session ? { tenantId: session.tenant_id, userId: session.user_id, csrfToken: session.csrf_token, tokenHash: session.token_hash } : null;
  }
  logout(ctx) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(ctx.tokenHash); }
}
