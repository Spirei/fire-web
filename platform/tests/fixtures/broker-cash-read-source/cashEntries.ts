import {readBrokerCashLedger} from "./brokerCashRead";
import {brokerAccount} from "./brokerAccounts";
import {isFundCurrency} from "./fundCurrencies";
import {RecordsError} from "./recordsContract";
const conflict=(m:string)=>new RecordsError(m,409,40902);
function cashEntries(userId:string,id:string,currency:string,limit:number,offset:number,revision?:string){
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0)throw new RecordsError("流水分页无效");
  brokerAccount(userId,id,2);if(!isFundCurrency(currency))throw new RecordsError('币种无效');
  const ledger=readBrokerCashLedger(userId,id,currency),snap=ledger.revision;
  if(revision&&revision!==snap)throw conflict('流水已变化，请从第一页重读');
  if(ledger.items.some(e=>!Number.isFinite(e.amount)||e.amount<0))throw conflict('流水来源不完整，请核对原始记录');
  return {snapshotRevision:snap,balancesComplete:ledger.balancesComplete,pagination:{limit,offset,total:ledger.items.length},items:ledger.items.slice(offset,offset+limit)};
}

export {cashEntries};
