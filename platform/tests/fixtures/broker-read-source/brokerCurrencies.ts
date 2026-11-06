import { getDb } from './db';
import { FUND_CURRENCIES,isFundCurrency } from './fundCurrencies';
import { MARKET_CURRENCY } from './currency';
import { collectionRevision,RecordsError } from './recordsContract';
export function parseBrokerCurrencies(value:unknown,defaultCurrency:string):string[]{
  if(!Array.isArray(value)||!value.length||value.length>FUND_CURRENCIES.length||value.some(c=>!isFundCurrency(c))||new Set(value).size!==value.length||!value.includes(defaultCurrency))throw new RecordsError('请至少选择一种支持币种，默认币种必须在已选集合内');
  return FUND_CURRENCIES.filter(c=>value.includes(c));
}
export function storedBrokerCurrencies(raw:string|null,defaultCurrency:string){
  if(raw===null)return parseBrokerCurrencies([defaultCurrency],defaultCurrency);
  try{return parseBrokerCurrencies(JSON.parse(raw),defaultCurrency);}catch{throw new RecordsError('账户币种配置损坏，请恢复有效配置',409,40902);}
}
/** Full owner-scoped DB scan, independent of client pagination and rate availability. */
export function brokerCurrencyUsage(userId:string,id:string){
  const db=getDb(),used=new Set<string>(),issues=new Set<string>();
  const add=(c:unknown)=>{if(typeof c==='string'&&/^[A-Z]{3}$/.test(c))used.add(c);else issues.add('unknown_currency');};
  const records=db.prepare('SELECT market,account_market,qty,cost FROM records WHERE user_id=? AND broker_account_id=?').all(userId,id) as {market:string;account_market:string;qty:number|null;cost:number|null}[];
  for(const r of records){if(r.qty!==null&&!Number.isFinite(r.qty)||r.cost!==null&&!Number.isFinite(r.cost))issues.add('invalid_position');add(MARKET_CURRENCY[r.market]);if(r.account_market)add(MARKET_CURRENCY[r.account_market]);}
  const orders=db.prepare('SELECT o.market,o.settlement_currency FROM trade_orders o JOIN records r ON r.id=o.record_id AND r.user_id=o.user_id WHERE r.user_id=? AND r.broker_account_id=?').all(userId,id) as {market:string;settlement_currency:string|null}[];
  for(const o of orders){add(MARKET_CURRENCY[o.market]);add(o.settlement_currency||MARKET_CURRENCY[o.market]);}
  const cash=db.prepare('SELECT currency FROM broker_cash_accounts WHERE user_id=? AND account_id=?').all(userId,id) as {currency:string}[];
  for(const r of cash)add(r.currency);
  const reports=db.prepare('SELECT cash_json FROM broker_statement_imports WHERE user_id=? AND account_id=?').all(userId,id) as {cash_json:string}[];
  for(const report of reports)try{const cash=JSON.parse(report.cash_json);if(!Array.isArray(cash))throw Error();for(const c of cash){if(!c||typeof c.endingCash!=='number'||!Number.isFinite(c.endingCash))throw Error();add(c.currency);}}catch{issues.add('invalid_statement_cash');}
  const events=db.prepare('SELECT payload FROM broker_statement_events WHERE user_id=? AND account_id=?').all(userId,id) as {payload:string}[];
  for(const event of events)try{const value=JSON.parse(event.payload),data=value.data;if(!data||typeof data!=='object')throw Error();if(data.currency)add(data.currency);if(data.ibCommissionCurrency)add(data.ibCommissionCurrency);}catch{issues.add('invalid_statement_event');}
  // Legacy funds have no personal broker ID. Never assign them by an editable label.
  const unscoped=db.prepare("SELECT 1 FROM fund_transactions f WHERE f.user_id=? AND f.amount!=0 AND NOT EXISTS(SELECT 1 FROM broker_cash_entries e WHERE e.user_id=f.user_id AND e.fund_id=f.id) AND NOT EXISTS(SELECT 1 FROM trade_orders o WHERE o.user_id=f.user_id AND f.id='fund-order-'||o.id) LIMIT 1").get(userId);
  if(unscoped)issues.add('unscoped_legacy_funds');
  return {complete:issues.size===0,usedCurrencies:[...used].sort(),recordCollectionRevision:collectionRevision(userId),issues:[...issues].sort()};
}
