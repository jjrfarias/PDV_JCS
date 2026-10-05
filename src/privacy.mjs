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

// Nome que fica no lugar do titular depois da eliminação. As vendas continuam apontando para o registro.
export const ANONYMIZED_NAME = 'Cliente anonimizado';

// Documento entregue ao titular. Valores em centavos, datas em UTC.
export function customerExportDocument(customer, sales) {
  const iso = value => value instanceof Date ? value.toISOString() : value;
  return {
    format: 'pdv-jcs.customer-export.v1', generated_at: new Date().toISOString(),
    customer,
    sales: sales.map(sale => ({ id: sale.id, store_id: sale.store_id, total_cents: Number(sale.total_cents), created_at: iso(sale.created_at) }))
  };
}
