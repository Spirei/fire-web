/** Order labels, day filters and calendars use the same exchange timezone. */
const ZONES: Record<string,string>={US:'America/New_York',HK:'Asia/Hong_Kong',CN:'Asia/Shanghai',JP:'Asia/Tokyo',KR:'Asia/Seoul'};
const LABELS: Record<string,string>={US:'美东',HK:'北京时间',CN:'北京时间',JP:'东京时间',KR:'首尔时间'};
export function orderDateKey(value:string|Date,market:string):string{
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:ZONES[market.toUpperCase()],year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=(key:string)=>parts.find(item=>item.type===key)?.value??'';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function isOrderToday(value:string,market:string,now=new Date()):boolean{
  const key=orderDateKey(value,market);return !!key&&key===orderDateKey(now,market);
}
export function formatOrderTime(iso:string,market:string):string{
  const date=new Date(iso);if(Number.isNaN(date.getTime()))return iso;
  const key=market.toUpperCase();
  const value=date.toLocaleString('zh-CN',{timeZone:ZONES[key],year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  return LABELS[key]?`${value} ${LABELS[key]}`:value;
}
