const $ = id => document.getElementById(id);
const state = { me: null, csrf: '', tenants: [], busy: false };

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, credentials: 'same-origin', signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf, ...options.headers } });
  } catch { throw new Error('Servidor indisponível ou resposta não recebida.'); }
  let data; try { data = await response.json(); } catch { throw new Error('Resposta inválida do servidor.'); }
  if (!response.ok) throw Object.assign(new Error(data.error?.message ?? 'Falha na operação.'), { status: response.status });
  return data;
}
function message(text, error = false) {
  const box = $('message'); box.textContent = text; box.hidden = !text; box.classList.toggle('error', error);
}
function cell(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
async function busy(work) {
  if (state.busy) return; state.busy = true;
  try { await work(); } catch (error) { message(error.message, true); } finally { state.busy = false; }
}

function renderTenants() {
  const table = cell('table'); const head = cell('thead'); const row = cell('tr');
  for (const title of ['Empresa', 'Identificador', 'Usuários', 'Status', '']) row.append(cell('th', title));
  head.append(row); const body = cell('tbody');
  for (const tenant of state.tenants) {
    const tr = cell('tr');
    const toggle = cell('button', tenant.active ? 'Desativar' : 'Ativar', tenant.active ? 'ghost danger-action' : 'ghost');
    toggle.type = 'button';
    toggle.addEventListener('click', () => busy(async () => {
      const verb = tenant.active ? 'desativar' : 'reativar';
      if (!confirm(`Confirma ${verb} ${tenant.name}?${tenant.active ? ' Todas as sessões da empresa serão encerradas e ninguém dela conseguirá entrar.' : ''}`)) return;
      await api('/api/platform/tenants/status', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ tenantId: tenant.id, active: tenant.active ? 0 : 1 }) });
      message(tenant.active ? 'Empresa desativada.' : 'Empresa reativada.'); await load();
    }));
    const action = cell('td'); action.append(toggle);
    tr.append(cell('td', tenant.name), cell('td', tenant.slug), cell('td', String(tenant.userCount)),
      cell('td', tenant.active ? 'Ativa' : 'Desativada', tenant.active ? 'badge' : 'badge muted'), action);
    body.append(tr);
  }
  table.append(head, body);
  $('tenant-table').replaceChildren(state.tenants.length ? table : cell('p', 'Nenhuma empresa cadastrada.'));
}
async function load() { state.tenants = (await api('/api/platform/tenants')).tenants; renderTenants(); }
async function boot() {
  state.me = await api('/api/platform/me'); state.csrf = state.me.csrfToken;
  $('login-panel').hidden = true; $('workspace').hidden = false; $('admin-label').textContent = state.me.admin.name;
  await load();
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/api/platform/login', { method: 'POST', body: JSON.stringify({ email: event.target.email.value, password: event.target.password.value }) });
    state.csrf = result.csrfToken; event.target.password.value = ''; $('login-error').textContent = ''; await boot();
  } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; }
});
$('logout').addEventListener('click', () => busy(async () => { await api('/api/platform/logout', { method: 'POST', body: '{}' }); location.reload(); }));
$('refresh').addEventListener('click', () => busy(load));
$('new-tenant').addEventListener('click', () => { $('tenant-form').reset(); delete $('tenant-form').dataset.key; $('tenant-dialog').showModal(); });
$('tenant-form').addEventListener('submit', event => {
  event.preventDefault();
  busy(async () => {
    // A mesma chave é reaproveitada se o envio for repetido, para não criar a empresa duas vezes.
    const form = event.target; form.dataset.key ??= crypto.randomUUID();
    const body = Object.fromEntries(new FormData(form));
    const result = await api('/api/platform/tenants', { method: 'POST', headers: { 'Idempotency-Key': form.dataset.key }, body: JSON.stringify(body) });
    $('tenant-dialog').close(); delete form.dataset.key;
    message(`Empresa ${result.tenant.name} criada. Convite enviado para ${result.manager.email}.`); await load();
  });
});
$('forgot-open').addEventListener('click', () => { $('forgot-form').email.value = $('login-form').email.value; $('forgot-status').textContent = ''; $('forgot-dialog').showModal(); });
$('forgot-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    await api('/api/platform/password/forgot', { method: 'POST', body: JSON.stringify({ email: event.target.email.value }) });
    $('forgot-status').textContent = 'Pedido registrado. Se o e-mail for de um administrador, o link chega em instantes.';
  } catch (error) { $('forgot-status').textContent = error.message; } finally { button.disabled = false; }
});
// O token chega no fragmento da URL e sai da barra de endereço assim que a página o lê.
const resetToken = (location.hash.match(/^#redefinir=([\w-]{43})$/) ?? [])[1] ?? null;
if (location.hash.startsWith('#redefinir=')) history.replaceState(null, '', location.pathname + location.search);
if (resetToken) $('reset-dialog').showModal();
$('reset-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const data = Object.fromEntries(new FormData(event.target));
  try {
    if (data.newPassword !== data.confirmPassword) throw new Error('A confirmação da nova senha não confere.');
    await api('/api/platform/password/reset', { method: 'POST', body: JSON.stringify({ token: resetToken, newPassword: data.newPassword }) });
    event.target.reset(); $('reset-dialog').close();
    if (state.me) return location.reload();
    $('login-notice').textContent = 'Senha criada. Entre com a nova senha.'; $('login-form').password.focus();
  } catch (error) { $('reset-status').textContent = error.message; } finally { button.disabled = false; }
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
boot().catch(error => { if (error.status !== 401) $('login-error').textContent = error.message; });
