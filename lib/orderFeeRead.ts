import { ACCOUNT_MARKET_CURRENCY } from './accountCash';

const object=(value:unknown):Record<string,unknown>=>{
  try{const parsed=typeof value==='string'?JSON.parse(value):value;return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}
};
const brokerId=(value:unknown)=>typeof value==='string'&&/^ba-[a-f0-9]{24}$/.test(value)?value:null;
/** Recorded history only; today's record association is deliberately a separate field. */
export function orderFeeRead(row:Record<string,unknown>){
  const saved=object(row.saved_fee_detail);
  const detail=object(row.fee_detail),evidence=object(row.fee_evidence_detail),draft=object(row.submission_draft);
  const repaired=row.fee_source==='owner_reconstructed',cashBroker=brokerId(row.cash_broker_account_id),repairBroker=repaired?brokerId(detail.brokerAccountId):null;
  const recordedBroker=row.fee_evidence_source==='explicit_order_entry'?brokerId(evidence.brokerAccountId):null,targetBroker=brokerId(draft.brokerTargetId);
  const currency=ACCOUNT_MARKET_CURRENCY[String(row.market)]??null;
  const components=repaired&&Array.isArray(detail.components)?detail.components:null;
  const knownComponents=components&&components.every(c=>c&&typeof c==='object'&&typeof c.kind==='string'&&typeof c.amount==='number'&&Number.isFinite(c.amount)&&c.amount>=0)
    &&Math.abs(components.reduce((n,c)=>n+c.amount,0)-Number(row.fees))<1e-8;
  return {
    brokerAccountId:cashBroker??repairBroker??recordedBroker??targetBroker,
    brokerAccountIdSource:cashBroker?'cash_attribution_at_creation':repairBroker?'fee_repair_owner_confirmation':recordedBroker?'recorded_order_entry':targetBroker?'submission_target':'unavailable',
    feeCurrency:currency,
    feeSource:repaired?'owner_reconstructed':row.role||['explicit_order_entry','explicit_fee_confirmation'].includes(String(row.fee_evidence_source))?'owner_recorded':row.fee_evidence_source==='legacy_import_zero'?'legacy_import_placeholder':'unverified_legacy',
    feeBreakdown:knownComponents?components!.map(c=>({...c,currency})):null,
    feeBreakdownSource:knownComponents?'owner_reconstructed':'unavailable',
    ...(repaired?{feeProvenance:{source:'owner_reconstructed',operationId:row.fee_operation_id,detail}}:{}),
    ...(['owner_recorded','rule_calculated'].includes(String(saved.source))&&Number(saved.total)===row.fees?{
      feeSource:saved.source,feeBreakdown:saved.components??null,feeBreakdownSource:saved.components?saved.source:'unavailable',feeRuleVersion:saved.ruleVersion??null,feeRuleSnapshot:saved.ruleSnapshot??null,
      feeProvenance:{source:saved.source,detail:saved},
      ...(!cashBroker&&!repairBroker&&brokerId(saved.brokerAccountId)?{brokerAccountId:saved.brokerAccountId,brokerAccountIdSource:'recorded_fee_snapshot'}:{})
    }:{})
  };
}
