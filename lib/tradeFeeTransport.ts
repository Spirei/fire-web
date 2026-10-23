import {ok} from './api';
import {RecordsError} from './recordsContract';
export const TRADE_FEE_HEADER='X-Alcor-Trade-Fees',TRADE_FEE_FORMAT='details-v1';
export function detailedTradeFees(request:Request){const value=request.headers.get(TRADE_FEE_HEADER);if(value!==null&&value!==TRADE_FEE_FORMAT)throw new RecordsError('费用读取版本无效');return value===TRADE_FEE_FORMAT;}
function legacy(value:unknown):unknown{
  if(Array.isArray(value))return value.map(legacy);
  if(!value||typeof value!=='object')return value;
  const row=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,legacy(v)]));
  const newSource=row.feeSource==='rule_calculated'||row.feeBreakdownSource==='rule_calculated'||row.feeBreakdownSource==='owner_recorded';
  if(row.feeSource==='rule_calculated')row.feeSource='owner_recorded';
  if(newSource){
    row.feeBreakdown=null;row.feeBreakdownSource='unavailable';delete row.feeProvenance;
  }
  if(row.brokerAccountIdSource==='recorded_fee_snapshot')row.brokerAccountIdSource='recorded_order_entry';
  delete row.feeRuleVersion;delete row.feeRuleSnapshot;delete row.feeDetail;
  return row;
}
/** Keep the canonical durable receipt unchanged; negotiate only its HTTP representation. */
export function tradeFeeOk(request:Request,value:unknown){const detailed=detailedTradeFees(request),response=ok(detailed?value:legacy(value));response.headers.set('Vary',TRADE_FEE_HEADER);if(detailed)response.headers.set(TRADE_FEE_HEADER,TRADE_FEE_FORMAT);return response;}
export function validateFeeTransportInput(request:Request,body:unknown){
  const detailed=detailedTradeFees(request),b=body as {feeInput?:unknown;replacement?:{feeInput?:unknown}}|null;
  if(!detailed&&(b?.feeInput!==undefined||b?.replacement?.feeInput!==undefined))throw new RecordsError('费用分项提交须协商 details-v1');
}
