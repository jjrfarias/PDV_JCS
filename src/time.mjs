import { requireThat } from './errors.mjs';

export const BUSINESS_TIME_ZONE='America/Sao_Paulo';
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const partsFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUSINESS_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:BUSINESS_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});

export const businessDate=(value=new Date())=>dateFormatter.format(value);

function zonedParts(value){
  return Object.fromEntries(partsFormatter.formatToParts(value).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
}

function startOfBusinessDay(value){
  const [year,month,day]=value.split('-').map(Number);
  const target=Date.UTC(year,month-1,day);
  let instant=target;
  for(let attempt=0;attempt<3;attempt++){
    const parts=zonedParts(new Date(instant));
    const represented=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    instant=target-(represented-instant);
  }
  return new Date(instant);
}

function addCalendarDays(value,days){
  const [year,month,day]=value.split('-').map(Number),next=new Date(Date.UTC(year,month-1,day+days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,'0')}-${String(next.getUTCDate()).padStart(2,'0')}`;
}

export function reportRange(from,to){
  requireThat(datePattern.test(from)&&datePattern.test(to),400,'INVALID_PERIOD','Informe datas no formato AAAA-MM-DD.');
  const startDay=new Date(`${from}T00:00:00.000Z`),endDay=new Date(`${to}T00:00:00.000Z`);
  requireThat(!Number.isNaN(startDay.getTime())&&!Number.isNaN(endDay.getTime())&&endDay>=startDay,400,'INVALID_PERIOD','Período inválido.');
  const days=Math.floor((endDay-startDay)/86_400_000)+1;
  requireThat(days<=366,400,'PERIOD_TOO_LONG','Relatório limitado a 366 dias.');
  return {from,to,time_zone:BUSINESS_TIME_ZONE,start:startOfBusinessDay(from).toISOString(),end:startOfBusinessDay(addCalendarDays(to,1)).toISOString()};
}
