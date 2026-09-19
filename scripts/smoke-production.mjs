const baseUrl = (process.env.PDV_URL ?? 'https://pdvjcs-production.up.railway.app').replace(/\/$/, '');
const tenant = process.env.PDV_SMOKE_TENANT;
const email = process.env.PDV_SMOKE_EMAIL;
const password = process.env.PDV_SMOKE_PASSWORD;

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} e obrigatoria para o smoke test.`);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      cookie: options.cookie ?? '',
      ...(options.headers ?? {})
    }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Resposta invalida em ${path}: ${text.slice(0, 120)}`); }
  if (!response.ok) {
    throw new Error(`${path} retornou ${response.status}: ${body?.error?.message ?? text}`);
  }
  return { response, body };
}

requireEnv('PDV_SMOKE_TENANT', tenant);
requireEnv('PDV_SMOKE_EMAIL', email);
requireEnv('PDV_SMOKE_PASSWORD', password);

const health = await request('/health');
if (health.body?.status !== 'ok' || health.body?.database !== 'postgres') {
  throw new Error(`Health inesperado: ${JSON.stringify(health.body)}`);
}

const login = await request('/api/login', {
  method: 'POST',
  body: JSON.stringify({ tenant, email, password })
});
if (!login.body?.csrfToken) throw new Error('Login nao retornou csrfToken.');
const cookie = login.response.headers.get('set-cookie')?.match(/jcs_session=[^;]+/)?.[0];
if (!cookie) throw new Error('Login nao retornou cookie de sessao.');

const me = await request('/api/me', { cookie });
if (!me.body?.user?.id || !Array.isArray(me.body?.stores)) {
  throw new Error(`Resposta /api/me inesperada: ${JSON.stringify(me.body)}`);
}

console.log(JSON.stringify({
  ok: true,
  url: baseUrl,
  health: health.body,
  user: me.body.user.email,
  stores: me.body.stores.length
}, null, 2));
