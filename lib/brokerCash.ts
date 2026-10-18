import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './db';
import { readFundBalances, createFundTransaction, settlementCurrency } from './funds';
import { isFundCurrency } from './fundCurrencies';
import { readAccountCash } from './accountCashStore';
import { RecordsError, validRecordRequestId } from './recordsContract';
import { brokerAccount } from './brokerAccounts';
import { readBrokerCashLedger, pendingBuyCash, withdrawalCapacity, type CashRow } from './brokerCashRead';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const conflict=(m:string)=>new RecordsError(m,409,40902);
export function cashRevision(userId:string){
  const db=getDb(),cash=readAccountCash(userId);
  return hash({cash:{balances:cash.balances,cardCash:cash.cardCash,sourceComplete:cash.sourceComplete,unavailableReasons:cash.unavailableReasons},
    funds:db.prepare("SELECT id,currency,type,amount,direction,occurred_at FROM fund_transactions WHERE user_id=? AND id NOT LIKE 'fund-order-%' ORDER BY id").all(userId),
    orders:db.prepare('SELECT id,record_id,market,status,side,qty,price,fees,amount,settlement_currency,settlement_amount,traded_at FROM trade_orders WHERE user_id=? ORDER BY id').all(userId),
    metadata:db.prepare('SELECT m.order_id,m.parent_id FROM app_trade_metadata m JOIN trade_orders o ON o.id=m.order_id WHERE o.user_id=? ORDER BY m.order_id').all(userId),
    ledgers:['broker_cash_accounts','broker_cash_entries','broker_cash_order_links'].map(t=>db.prepare(`SELECT * FROM ${t} WHERE user_id=? ORDER BY rowid`).all(userId))});
}
function rows(userId:string,id:string){return getDb().prepare('SELECT * FROM broker_cash_accounts WHERE user_id=? AND account_id=? ORDER BY currency').all(userId,id) as CashRow[];}
function balance(userId:string,id:string,currency:string){return readBrokerCashLedger(userId,id,currency).balance;}
function totals(userId:string){
  const db=getDb(),global=readAccountCash(userId),fund=readFundBalances(userId),owned:Record<string,number>={};
  const all=db.prepare('SELECT DISTINCT account_id,currency FROM broker_cash_accounts WHERE user_id=?').all(userId) as {account_id:string;currency:string}[];
  for(const r of all){const value=balance(userId,r.account_id,r.currency);if(value===null)throw conflict('券商现金来源不完整');owned[r.currency]=(owned[r.currency]??0)+value;}
  const currencies=[...new Set([...Object.keys(fund),...Object.keys(owned)])];
  return {userId,globalCashRevision:cashRevision(userId),asOf:new Date().toISOString(),complete:global.sourceComplete,byCurrency:currencies.map(currency=>({currency,totalCash:global.sourceComplete?global.balances[currency]??0:null,cardCash:global.sourceComplete?global.cardCash[currency]??0:null,brokerCash:owned[currency]??0,unallocatedCash:global.sourceComplete?(fund[currency as keyof typeof fund]??0)-(owned[currency]??0):null,complete:global.sourceComplete,unavailableReasons:global.unavailableReasons??[]}))};
}
export function brokerCashSummary(userId:string){return getDb().transaction(()=>totals(userId))();}
function cashSnapshot(userId:string,id:string){
  const a=brokerAccount(userId,id,2),cashRows=rows(userId,id),revision=cashRevision(userId),global=readAccountCash(userId),funds=readFundBalances(userId);
  return {userId,brokerAccountId:id,brokerRevision:a.revision,globalCashRevision:revision,snapshotRevision:hash([revision,id,a.revision,a.holdingSource,a.currencies]),holdingSource:a.holdingSource,asOf:new Date().toISOString(),tradingCashBasis:'owner_currency_ledger',currencies:[...new Set([...a.currencies,...cashRows.map(r=>r.currency)])].sort().map(currency=>{
    const ledger=readBrokerCashLedger(userId,id,currency),r=ledger.row,value=ledger.balance,fundCash=global.sourceComplete&&Number.isFinite(funds[currency as keyof typeof funds])?funds[currency as keyof typeof funds]:null;
    return {currency,cashRevision:r?.revision??0,state:!r?'uninitialized':a.holdingSource==='official'?'official_readonly':value===null?'incomplete':'ready',opening:r?{amount:r.opening_amount,asOf:r.opening_at,basis:r.opening_basis}:null,balance:value,activity:ledger.activity,withdrawalCapacity:withdrawalCapacity(value,fundCash,pendingBuyCash(userId,currency),a.holdingSource==='manual'),available:null,reserved:null,complete:!!r&&value!==null,unavailableReasons:!r?['opening_not_set']:value===null?['cash_ledger_source_incomplete','broker_buying_power_not_enforced']:['broker_buying_power_not_enforced'],officialObservation:null};
  })};
}
export function brokerCashSnapshot(userId:string,id:string){return getDb().transaction(()=>cashSnapshot(userId,id))();}
function cashEntries(userId:string,id:string,currency:string,limit:number,offset:number,revision?:string){
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)throw new RecordsError("流水分页无效");
  brokerAccount(userId,id,2);if(!isFundCurrency(currency))throw new RecordsError('币种无效');
  const ledger=readBrokerCashLedger(userId,id,currency),snap=ledger.revision;
  if(revision&&revision!==snap)throw conflict('流水已变化，请从第一页重读');
  if(ledger.items.some(e=>!Number.isFinite(e.amount)||e.amount<0))throw conflict('流水来源不完整，请核对原始记录');
  return {snapshotRevision:snap,balancesComplete:ledger.balancesComplete,pagination:{limit,offset,total:ledger.items.length},items:ledger.items.slice(offset,offset+limit)};
}
export function brokerCashEntries(userId:string,id:string,currency:string,limit:number,offset:number,revision?:string){return getDb().transaction(()=>cashEntries(userId,id,currency,limit,offset,revision))();}
function validTime(value:unknown){
  if(typeof value!=='string')return false;
  const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if(!m||+m[4]>23||+m[5]>59||+m[6]>59||!Number.isFinite(Date.parse(value)))return false;
  return new Date(Date.UTC(+m[1],+m[2]-1,+m[3])).toISOString().slice(0,10)===value.slice(0,10);
}
type Input={requestId:string;action:'opening'|'external_deposit'|'external_withdrawal';currency:string;amount:number;occurredAt:string;note:string;globalCashRevision:string;brokerAccountId:string;targets:{brokerAccountId:string;brokerRevision:number;cashRevision:number}[];openingBasis?:'allocate_verified_unallocated_checkpoint'|'new_external_opening';previewRevision?:string};
function input(raw:unknown):Input {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordsError('资金请求无效');const b=raw as Input;
  validRecordRequestId(b.requestId);
  if(Object.keys(b).some(k=>!['requestId','action','currency','amount','occurredAt','note','globalCashRevision','brokerAccountId','targets','openingBasis','previewRevision'].includes(k))||!['opening','external_deposit','external_withdrawal'].includes(b.action)||!isFundCurrency(b.currency)||typeof b.brokerAccountId!=='string'||!/^ba-[a-f0-9]{24}$/.test(b.brokerAccountId)||typeof b.amount!=='number'||!Number.isFinite(b.amount)||b.amount<0||b.amount>1e12||Number(b.amount.toFixed(8))!==b.amount||b.action!=='opening'&&b.amount===0||!validTime(b.occurredAt)||Date.parse(b.occurredAt)>Date.now()||typeof b.note!=='string'||b.note.length>200||typeof b.globalCashRevision!=='string'||!/^[a-f0-9]{64}$/.test(b.globalCashRevision)||!Array.isArray(b.targets)||b.targets.length!==1)throw new RecordsError('资金字段无效');
  const t=b.targets[0];if(!t||Object.keys(t).some(k=>!['brokerAccountId','brokerRevision','cashRevision'].includes(k))||t.brokerAccountId!==b.brokerAccountId||!Number.isSafeInteger(t.brokerRevision)||t.brokerRevision<1||!Number.isSafeInteger(t.cashRevision)||t.cashRevision<0)throw new RecordsError('资金目标版本无效');
  if(b.action==='opening'?!['allocate_verified_unallocated_checkpoint','new_external_opening'].includes(b.openingBasis??''):b.openingBasis!==undefined)throw new RecordsError('期初来源无效');
  if(b.previewRevision!==undefined&&(typeof b.previewRevision!=='string'||!/^[a-f0-9]{64}$/.test(b.previewRevision)))throw new RecordsError('预览版本无效');
  return {...b,occurredAt:new Date(b.occurredAt).toISOString()};
}
function preview(userId:string,b:Input){
  const db=getDb(),a=brokerAccount(userId,b.brokerAccountId,2),r=rows(userId,a.id).find(r=>r.currency===b.currency),t=b.targets[0];
  if(a.holdingSource==='official')throw new RecordsError('官方账户资金只读',409,40903);
  if(a.revision!==t.brokerRevision||(r?.revision??0)!==t.cashRevision||cashRevision(userId)!==b.globalCashRevision)throw conflict('账户或资金已变化，请重新预览');
  const summary=totals(userId),global=summary.byCurrency.find(r=>r.currency===b.currency)!;if(!global.complete||global.unallocatedCash===null)throw conflict('总现金来源不完整');
  const before=balance(userId,a.id,b.currency);let globalEffect=0;
  if(b.action==='opening'){
    if(r)throw conflict('该币种已设置期初');
    const sources=(db.prepare("SELECT occurred_at at FROM fund_transactions WHERE user_id=? AND currency=? AND id NOT LIKE 'fund-order-%'").all(userId,b.currency) as {at:string}[]);
    const filled=db.prepare("SELECT * FROM trade_orders WHERE user_id=? AND status='filled'").all(userId) as {market:string;settlement_currency:string|null;traded_at:string}[];
    for(const o of filled)if((o.settlement_currency||settlementCurrency(o.market))===b.currency)sources.push({at:o.traded_at});
    if(sources.some(s=>!Number.isFinite(Date.parse(s.at))||Date.parse(s.at)>Date.parse(b.occurredAt)))throw conflict('期初日期跨越已有流水，需要独立历史核对');
    const pending=db.prepare("SELECT market,settlement_currency FROM trade_orders WHERE user_id=? AND status='pending'").all(userId) as {market:string;settlement_currency:string|null}[];
    if(pending.some(o=>(o.settlement_currency||settlementCurrency(o.market))===b.currency))throw conflict('请先处理同币种待成交订单后设置期初');
    if(b.openingBasis==='new_external_opening'){
      if(sources.length||db.prepare('SELECT 1 FROM broker_cash_accounts WHERE user_id=? AND currency=?').get(userId,b.currency))throw conflict('该币种已有资金来源，只能明确分配未归属现金');globalEffect=b.amount;
    }else if(global.unallocatedCash<b.amount)throw conflict('可验证未归属现金不足，不能重复新增期初');
  }else{if(!r||before===null)throw conflict('请先明确期初现金');if(Date.parse(b.occurredAt)<Date.parse(r.opening_at))throw conflict('流水不能早于期初时点');
    const latest=db.prepare("SELECT occurred_at at FROM broker_cash_entries WHERE user_id=? AND account_id=? AND currency=? UNION ALL SELECT o.traded_at at FROM trade_orders o JOIN broker_cash_order_links l ON l.order_id=o.id WHERE l.user_id=? AND l.account_id=? AND l.currency=? AND o.status='filled'").all(userId,a.id,b.currency,userId,a.id,b.currency) as {at:string}[];
    if(latest.some(e=>Date.parse(e.at)>Date.parse(b.occurredAt)))throw conflict('回填早期流水需要独立历史核对');globalEffect=b.action==='external_deposit'?b.amount:-b.amount;const reserved=pendingBuyCash(userId,b.currency);
    if(b.action==='external_withdrawal'){
      const capacity=withdrawalCapacity(before,readFundBalances(userId)[b.currency as keyof ReturnType<typeof readFundBalances>],reserved,true).amount;
      if(capacity===null)throw conflict('待成交预留资金无法核对');
      if(b.amount>capacity)throw conflict('券商或总资金不足');
    }}
  const direction=b.action==='external_withdrawal'?-1:1,after=(before??0)+b.amount*direction;
  if(!Number.isFinite(after)||Math.abs(after)>1e12)throw conflict('资金余额超出支持范围');
  const effects=[{kind:'broker',id:a.id,currency:b.currency,before,after,delta:b.amount*direction,cashRevision:r?.revision??0}];
  if(b.action==='opening'&&b.openingBasis==='allocate_verified_unallocated_checkpoint')effects.push({kind:'unallocated',id:userId,currency:b.currency,before:global.unallocatedCash,after:global.unallocatedCash-b.amount,delta:-b.amount,cashRevision:0});
  return {userId,action:b.action,currency:b.currency,amount:b.amount,occurredAt:b.occurredAt,globalCashRevision:b.globalCashRevision,targets:b.targets,previewRevision:hash({...b,requestId:undefined,previewRevision:undefined,before,after,globalEffect}),effects,globalEffect,externalFlow:b.action==='opening'?0:globalEffect,canSubmit:true};
}
export function previewBrokerCash(userId:string,raw:unknown){const b=input(raw);return getDb().transaction(()=>preview(userId,b))();}
export function submitBrokerCash(userId:string,raw:unknown,authorize:()=>string){const b=input(raw),db=getDb();return db.transaction(()=>{
  if(authorize()!==userId)throw new RecordsError('连接失效',401);
  if(db.prepare('SELECT 1 FROM broker_account_operations WHERE user_id=? AND request_id=?').get(userId,b.requestId))throw new RecordsError('UUID已使用，请查询原回执',409,40901);
  let data:unknown=null,error:RecordsError|null=null;
  try{data=db.transaction(()=>{const p=preview(userId,b);if(b.previewRevision!==p.previewRevision)throw conflict('请先预览本次资金变动');
    const now=new Date().toISOString();let fundId:string|null=null;
    if(b.amount>0&&(b.action!=='opening'||b.openingBasis==='new_external_opening'))fundId=createFundTransaction({userId,currency:b.currency as Parameters<typeof createFundTransaction>[0]['currency'],type:b.action==='opening'?'opening':b.action==='external_deposit'?'deposit':'withdrawal',amount:b.amount,direction:b.action==='external_withdrawal'?-1:1,note:b.note,occurredAt:b.occurredAt}).id;
    if(b.action==='opening')db.prepare('INSERT INTO broker_cash_accounts VALUES(?,?,?,?,?,?,?)').run(userId,b.brokerAccountId,b.currency,1,b.amount,b.occurredAt,b.openingBasis);
    else db.prepare('UPDATE broker_cash_accounts SET revision=revision+1 WHERE user_id=? AND account_id=? AND currency=?').run(userId,b.brokerAccountId,b.currency);
    db.prepare('INSERT INTO broker_cash_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),userId,b.brokerAccountId,b.currency,b.action,b.amount,b.action==='external_withdrawal'?-1:1,b.occurredAt,now,b.note,b.requestId,fundId);
    return {operationId:b.requestId,...p,snapshots:[brokerCashSnapshot(userId,b.brokerAccountId)],globalCashRevision:cashRevision(userId)};
  })();}catch(e){if(!(e instanceof RecordsError))throw e;error=e;}
  const result={requestId:b.requestId,accountId:b.brokerAccountId,kind:'cash_'+b.action,state:error?'failed':'completed',code:error?.code??0,message:error?.message??'ok',data,completedAt:new Date().toISOString()};
  db.prepare('INSERT INTO broker_account_operations VALUES(?,?,?)').run(userId,b.requestId,JSON.stringify(result));return{result,error};
}).immediate();}
