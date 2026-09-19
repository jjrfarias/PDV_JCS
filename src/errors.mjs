export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireThat(condition, status, code, message) {
  if (!condition) throw new AppError(status, code, message);
}
export function object(value, allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID_INPUT', 'Envie um objeto JSON.');
  requireThat(Object.keys(value).every(key => allowed.includes(key)), 400, 'UNKNOWN_FIELD', 'A requisição contém campos não permitidos.');
  return value;
}
export function text(value, name, max = 120, min = 1) {
  requireThat(typeof value === 'string', 400, 'INVALID_INPUT', `${name}: informe um texto.`);
  const result = value.trim();
  requireThat(result.length >= min && result.length <= max && !/[\x00-\x1f\x7f]/.test(result), 400, 'INVALID_INPUT', `${name}: tamanho ou formato inválido.`);
  return result;
}
export function integer(value, name, min = 0, max = 100_000_000) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 400, 'INVALID_INPUT', `${name}: informe um inteiro entre ${min} e ${max}.`);
  return value;
}
export function id(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value), 400, 'INVALID_ID', 'Identificador inválido.');
  return value;
}
export function operationKey(value) {
  requireThat(typeof value === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(value), 400, 'INVALID_KEY', 'Informe uma chave de operação válida.');
  return value;
}
