// Entrada em centavos quando só há dígitos: 1234 => R$ 12,34.
// Também aceita decimal explícito para compatibilidade: 12,34 ou 12.34.
export function cents(value) {
  const raw=String(value??'').trim();
  if(/^\d{1,9}$/.test(raw)){
    const digitResult=Number(raw);
    if(!Number.isSafeInteger(digitResult)||digitResult>100_000_000) throw new Error('Valor acima do limite de teste.');
    return digitResult;
  }
  const input=raw.replace(',','.');
  if(!/^\d{1,7}\.\d{1,2}$/.test(input)) throw new Error('Informe apenas números, por exemplo 1234 para R$ 12,34.');
  const [whole,fraction='']=input.split('.');
  const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result>100_000_000) throw new Error('Valor acima do limite de teste.');
  return result;
}
export const brl=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
