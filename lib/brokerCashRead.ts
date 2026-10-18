import { createHash } from 'node:crypto';
import { getDb } from './db';
import { orderCashAmount, settlementCurrency } from './funds';

export type CashRow = {currency:string;revision:number;opening_amount:number;opening_at:string;opening_basis:string};
type Entry = { id:string; operationId:string|null; brokerAccountId:string; currency:string; kind:string; amount:number; direction:1|-1; occurredAt:string; createdAt:string; note:string; sourceOrderId:string|null; balanceAfter:number|null };
type ManualRow = {id:string;operation_id:string;kind:string;amount:number;direction:1|-1;occurred_at:string;created_at:string;note:string;fund_id:string|null;fund_user:string|null;fund_currency:string|null;fund_amount:number|null;fund_direction:number|null;fund_time:string|null};
type CashOrder = Parameters<typeof orderCashAmount>[0] & {id:string;side:string;market:string;traded_at:string;created_at:string;note:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** One owner/currency statement; reads never repair missing sources or invent a running balance. */
export function readBrokerCashLedger(userId:string,id:string,currency:string) {
  const db=getDb(),row=db.prepare('SELECT * FROM broker_cash_accounts WHERE user_id=? AND account_id=? AND currency=?').get(userId,id,currency) as CashRow|undefined;
  const manual=db.prepare(`SELECT e.*,f.user_id fund_user,f.currency fund_currency,f.amount fund_amount,f.direction fund_direction,f.occurred_at fund_time
    FROM broker_cash_entries e LEFT JOIN fund_transactions f ON f.id=e.fund_id
    WHERE e.user_id=? AND e.account_id=? AND e.currency=? ORDER BY e.rowid`).all(userId,id,currency) as ManualRow[];
  const orders=db.prepare(`SELECT o.* FROM trade_orders o JOIN broker_cash_order_links l ON l.order_id=o.id AND l.user_id=o.user_id
    WHERE l.user_id=? AND l.account_id=? AND l.currency=? AND o.status='filled'`).all(userId,id,currency) as CashOrder[];
  const items:Entry[]=manual.map(e=>({id:e.id,operationId:e.operation_id,brokerAccountId:id,currency,kind:e.kind,amount:e.amount,direction:e.direction,occurredAt:e.occurred_at,createdAt:e.created_at,note:e.note,sourceOrderId:null,balanceAfter:null}));
  let valid=!!row&&['new_external_opening','allocate_verified_unallocated_checkpoint'].includes(row.opening_basis)&&Number.isFinite(row.opening_amount)&&row.opening_amount>=0&&Number.isFinite(Date.parse(row.opening_at));
  const opening=manual.filter(e=>e.kind==='opening');
  if(opening.length!==1||opening[0].amount!==row?.opening_amount||opening[0].direction!==1||opening[0].occurred_at!==row?.opening_at)valid=false;
  for(const e of manual){
    if(!Number.isFinite(e.amount)||e.amount<0||![1,-1].includes(e.direction)||!['opening','external_deposit','external_withdrawal'].includes(e.kind)||e.direction!==(e.kind==='external_withdrawal'?-1:1))valid=false;
    if(e.fund_id ? e.fund_user!==userId||e.fund_currency!==currency||e.fund_amount!==e.amount||e.fund_direction!==e.direction||e.fund_time!==e.occurred_at : e.kind!=='opening'||row?.opening_basis!=='allocate_verified_unallocated_checkpoint'&&e.amount!==0)valid=false;
  }
  let tradeNetFlow=0;
  for(const o of orders){
    let signed=NaN;
    try{signed=orderCashAmount(o);}catch{valid=false;}
    if(!['buy','sell','dividend'].includes(o.side)||![o.qty,o.price,o.fees,o.amount,signed].every(Number.isFinite)||o.qty<=0||o.price<0||o.fees<0||(o.settlement_currency==='CNY'?'CNY':settlementCurrency(o.market))!==currency)valid=false;
    tradeNetFlow+=signed;
    items.push({id:o.id,operationId:null,brokerAccountId:id,currency,kind:'trade_'+o.side,amount:Math.abs(signed),direction:signed<0?-1:1,occurredAt:o.traded_at,createdAt:o.created_at,note:o.note,sourceOrderId:o.id,balanceAfter:null});
  }
  for(const item of items)if(!Number.isFinite(Date.parse(item.occurredAt))||Date.parse(item.occurredAt)<Date.parse(row?.opening_at??'')||!Number.isFinite(Date.parse(item.createdAt)))valid=false;
  const sum=db.prepare('SELECT SUM(amount*direction) n FROM broker_cash_entries WHERE user_id=? AND account_id=? AND currency=?').get(userId,id,currency) as {n:number|null};
  const computed=Number(sum.n??0)+tradeNetFlow;
  if(!Number.isFinite(computed))valid=false;
  const chronological=[...items].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||(Number(b.kind==='opening')-Number(a.kind==='opening'))||Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));
  const tieKey=(e:Entry)=>`${Date.parse(e.occurredAt)}:${Date.parse(e.createdAt)}`;
  const ties=new Map<string,number>();for(const item of chronological)if(item.kind!=='opening')ties.set(tieKey(item),(ties.get(tieKey(item))??0)+1);
  let running=0;
  if(valid)for(const item of chronological){running+=item.amount*item.direction;item.balanceAfter=Number.isFinite(running)&&(item.kind==='opening'||ties.get(tieKey(item))===1)?running:null;}
  // The final row agrees exactly with the existing authoritative balance, even at floating-point boundaries.
  if(valid&&chronological.length&&chronological[chronological.length-1].balanceAfter!==null)chronological[chronological.length-1].balanceAfter=computed;
  const deposits=manual.filter(e=>e.kind==='external_deposit').reduce((n,e)=>n+e.amount,0),withdrawals=manual.filter(e=>e.kind==='external_withdrawal').reduce((n,e)=>n+e.amount,0);
  const activity=valid?{openingAmount:row!.opening_amount,externalDeposits:deposits,externalWithdrawals:withdrawals,netExternalFlow:deposits-withdrawals,tradeNetFlow,entryCount:items.length}:null;
  const statementOpening=row?{amount:row.opening_amount,at:row.opening_at,basis:row.opening_basis}:null;
  const revision=digest([userId,id,currency,statementOpening,valid,manual.map(e=>[e.id,e.fund_id,e.fund_user,e.fund_currency,e.fund_amount,e.fund_direction,e.fund_time]),chronological.map(e=>({...e,balanceAfter:undefined}))]);
  return {row,balance:valid?computed:null,activity,balancesComplete:valid&&chronological.every(e=>e.balanceAfter!==null),revision,items:chronological.reverse()};
}

/** OCO siblings share one reservation. Malformed sources never become zero available cash. */
export function pendingBuyCash(userId:string,currency:string) {
  const rows=getDb().prepare(`SELECT o.id,o.market,o.settlement_currency,o.qty,o.price,o.fees,m.parent_id,
    p.user_id parent_user,p.status parent_status,p.side parent_side,m.role,r.id owned_record FROM trade_orders o LEFT JOIN app_trade_metadata m ON m.order_id=o.id
    LEFT JOIN trade_orders p ON p.id=m.parent_id LEFT JOIN records r ON r.id=o.record_id AND r.user_id=o.user_id WHERE o.user_id=? AND o.status='pending' AND o.side='buy'`).all(userId) as {id:string;market:string;settlement_currency:string|null;qty:number;price:number;fees:number;parent_id:string|null;parent_user:string|null;parent_status:string|null;parent_side:string|null;role:string|null;owned_record:string|null}[];
  const groups=new Map<string,number>(),roles=new Map<string,Set<string>>();
  for(const o of rows){
    if((o.settlement_currency||settlementCurrency(o.market))!==currency)continue;
    const amount=o.qty*o.price+o.fees;
    if(!o.owned_record||![o.qty,o.price,o.fees,amount].every(Number.isFinite)||o.qty<=0||o.price<=0||o.fees<0)return null;
    if(o.parent_id){
      if(o.parent_user!==userId||o.parent_status!=='filled'||o.parent_side!=='sell'||!['take_profit','stop_loss'].includes(o.role??''))return null;
      const seen=roles.get(o.parent_id)??new Set<string>();if(seen.has(o.role!))return null;seen.add(o.role!);roles.set(o.parent_id,seen);
    }
    const key=o.parent_id||o.id;groups.set(key,Math.max(groups.get(key)??0,amount));
  }
  const total=[...groups.values()].reduce((a,b)=>a+b,0);return Number.isFinite(total)?total:null;
}
export function withdrawalCapacity(balance:number|null,fundCash:number|null,reserved:number|null,manual:boolean) {
  const complete=manual&&balance!==null&&fundCash!==null&&reserved!==null&&[balance,fundCash,reserved].every(Number.isFinite);
  return {amount:complete?Math.max(0,Math.min(balance!,fundCash!-reserved!)):null,reservedGlobalBuyCash:reserved,basis:'min_broker_balance_and_owner_fund_cash_after_reservations'};
}
