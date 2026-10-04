// Minimização de dados pessoais em listagens (LGPD art. 6º, III).
// Listas mostram o suficiente para reconhecer o cliente; o cadastro completo sai só sob demanda e auditado.
const lastDigits = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `•••${digits.slice(-4)}` : null;
};
export function maskEmail(value) {
  if (!value) return null;
  const [user, domain] = String(value).split('@');
  return domain ? `${user.slice(0, 1)}•••@${domain}` : '•••';
}
export function customerSummary(full) {
  if (!full) return null;
  return {
    id: full.id, store_id: full.store_id, name: full.name,
    document: lastDigits(full.document), phone: lastDigits(full.phone), email: maskEmail(full.email),
    has_note: Boolean(full.note), active: full.active, created_at: full.created_at, updated_at: full.updated_at
  };
}
