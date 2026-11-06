import {readBrokerCashLedger,pendingBuyCash,withdrawalCapacity} from "./brokerCashRead";
import {createHash} from "node:crypto";
import {getDb} from "./db";
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
function rows(userId:string,id:string){return getDb().prepare("SELECT * FROM broker_cash_accounts WHERE user_id=? AND account_id=? ORDER BY currency").all(userId,id);}
function cashSnapshot(userId:string,id:string,context?:CashReadContext,account?:ReturnType<typeof brokerAccount>){
  const a=account??brokerAccount(userId,id,2),cashRows=rows(userId,id),ctx=context??cashReadContext(userId),{revision,global,funds}=ctx;
  return {userId,brokerAccountId:id,brokerRevision:a.revision,globalCashRevision:revision,snapshotRevision:hash([revision,id,a.revision,a.holdingSource,a.currencies]),holdingSource:a.holdingSource,asOf:ctx.asOf,tradingCashBasis:'owner_currency_ledger',currencies:[...new Set([...a.currencies,...cashRows.map(r=>r.currency)])].sort().map(currency=>{
    const ledger=readBrokerCashLedger(userId,id,currency),r=ledger.row,value=ledger.balance,fundCash=global.sourceComplete&&Number.isFinite(funds[currency as keyof typeof funds])?funds[currency as keyof typeof funds]:null;
    if(!ctx.reservations.has(currency))ctx.reservations.set(currency,pendingBuyCash(userId,currency));
    return {currency,cashRevision:r?.revision??0,state:!r?'uninitialized':a.holdingSource==='official'?'official_readonly':value===null?'incomplete':'ready',opening:r?{amount:r.opening_amount,asOf:r.opening_at,basis:r.opening_basis}:null,balance:value,activity:ledger.activity,withdrawalCapacity:withdrawalCapacity(value,fundCash,ctx.reservations.get(currency)??null,a.holdingSource==='manual'),available:null,reserved:null,complete:!!r&&value!==null,unavailableReasons:!r?['opening_not_set']:value===null?['cash_ledger_source_incomplete','broker_buying_power_not_enforced']:['broker_buying_power_not_enforced'],officialObservation:null};
  })};
}

export {cashSnapshot};
