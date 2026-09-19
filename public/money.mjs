// Entrada sem separador de milhar. Conversão decimal por string, sem multiplicar floats.
export function cents(value) {
  const input=String(value??'').trim().replace(',','.');
  if(!/^\d{1,7}(\.\d{1,2})?$/.test(input)) throw new Error('Informe um valor como 25,00, sem separador de milhar.');
  const [whole,fraction='']=input.split('.');
  const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result>100_000_000) throw new Error('Valor acima do limite de teste.');
  return result;
}
export const brl=value=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value/100);
