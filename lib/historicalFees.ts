import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from './db';
import { RecordsError, validRecordRequestId, collectionRevision } from './recordsContract';
import { brokerAccount } from './brokerAccounts';
import { cashRevision, brokerCashSnapshot } from './brokerCash';
import { withBrokerFeeCorrection } from './brokerCashSchema';
import { readFundBalances, syncOrderCashTransaction } from './funds';
import { applyOrder } from './tradeAccounting';
import { replayEconomicOrders } from './portfolioLedger';
import { feeInputFingerprint } from './historicalFeeSchema';
import { historicalFee, validateFeePlan, HISTORICAL_FEE_RULE_VERSION, type FeePlan } from './historicalFeeRules';
import type { TradeOrder } from './types';

const ttl=10*60_000;
const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,stable(value)])):v;
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const conflict=(message:string)=>new RecordsError(message,409,40902);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200;
const version=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
type Row={id:string;user_id:string;record_id:string;market:string;code:string;side:TradeOrder['side'];status:string;qty:number;price:number;fees:number;amount:number;traded_at:string;created_at:string;position_qty_before:number;position_qty_after:number;position_cost_before:number|null;position_cost_after:number|null;realized_pnl:number|null;settlement_currency:string|null;settlement_amount:number|null;revision:number;api_id:string|null};
type RecordRow={id:string;user_id:string;broker_account_id:string;market:string;account_market:string;code:string;qty:number|null;cost:number|null;revision:number};
type Selection={orderId:string;revision:number;recordRevision:number;instrumentKind:'us_domestic_equity'|'us_etf'|'cn_a_equity'|'unknown';wholeOrderConfirmed:boolean;brokerOwnershipConfirmed:boolean;legacyImportConfirmed?:true};
type Input={requestId:string;accountId:string;brokerAccountId:string;providerId:'longbridge'|'huatai';brokerRevision:number;snapshotRevision:string;ruleVersion:string;plan:FeePlan;orders:Selection[];previewRevision?:string};
function parse(raw:unknown):Input {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordsError('手续费请求无效');
  const b=raw as Input;validRecordRequestId(b.requestId);
  if(Object.keys(b).some(k=>!['requestId','accountId','brokerAccountId','providerId','brokerRevision','snapshotRevision','ruleVersion','plan','orders','previewRevision'].includes(k))||!id(b.accountId)||!/^ba-[a-f0-9]{24}$/.test(b.brokerAccountId)||!['longbridge','huatai'].includes(b.providerId)||!version(b.brokerRevision)||!/^\w{64}$/.test(b.snapshotRevision)||b.ruleVersion!==HISTORICAL_FEE_RULE_VERSION||!Array.isArray(b.orders)||!b.orders.length||b.orders.length>500||b.previewRevision!==undefined&&(typeof b.previewRevision!=='string'||b.previewRevision.length>300))throw new RecordsError('须提供本人账户、费率及完整选择版本');
  for(const s of b.orders)if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['orderId','revision','recordRevision','instrumentKind','wholeOrderConfirmed','brokerOwnershipConfirmed','legacyImportConfirmed'].includes(k))||!id(s.orderId)||!version(s.revision)||!version(s.recordRevision)||!['us_domestic_equity','us_etf','cn_a_equity','unknown'].includes(s.instrumentKind)||typeof s.wholeOrderConfirmed!=='boolean'||typeof s.brokerOwnershipConfirmed!=='boolean'||s.legacyImportConfirmed!==undefined&&s.legacyImportConfirmed!==true)throw new RecordsError('逐笔身份、证券类别或人工核对无效');
  if(new Set(b.orders.map(s=>s.orderId)).size!==b.orders.length)throw new RecordsError('选择订单重复');
  return {...b,orders:[...b.orders].sort((a,b)=>a.orderId.localeCompare(b.orderId)),plan:validateFeePlan(b.plan,b.providerId)};
}
function state(userId:string,accountId:string) {
  const db=getDb(),account=brokerAccount(userId,accountId,2);
  const records=db.prepare('SELECT * FROM records WHERE user_id=? ORDER BY id').all(userId) as RecordRow[];
  const orders=db.prepare(`SELECT o.*,v.revision,m.order_id api_id FROM trade_orders o JOIN app_asset_order_versions v ON v.order_id=o.id
    LEFT JOIN app_trade_metadata m ON m.order_id=o.id WHERE o.user_id=? ORDER BY o.id`).all(userId) as Row[];
  if((db.prepare('SELECT COUNT(*) n FROM trade_orders WHERE user_id=?').get(userId) as {n:number}).n!==orders.length)throw conflict('订单版本来源不完整');
  if(orders.length>10_000)throw conflict('订单数量超出本次核对范围');
  const evidence=db.prepare('SELECT * FROM trade_fee_evidence WHERE user_id=? ORDER BY order_id').all(userId) as {order_id:string;source:string;input_hash:string;detail_json:string}[];
  const corrections=db.prepare('SELECT * FROM trade_fee_corrections WHERE user_id=? ORDER BY order_id').all(userId) as {order_id:string}[];
  const metadata=db.prepare('SELECT m.* FROM app_trade_metadata m JOIN trade_orders o ON o.id=m.order_id WHERE o.user_id=? ORDER BY m.order_id').all(userId);
  const cash=cashRevision(userId),revision=digest([userId,account,collectionRevision(userId),records,orders,evidence,corrections,metadata,cash]);
  return {account,records,orders,evidence,corrections,cash,revision,cashModel:null as ReturnType<typeof brokerCashSnapshot>|null};
}
function baseExclusion(o:Row,r:RecordRow|undefined,s:ReturnType<typeof state>) {
  if(!r||r.broker_account_id!==s.account.id||r.user_id!==o.user_id)return 'broker_ownership_unconfirmed';
  if(s.account.holdingSource!=='manual')return 'official_account_readonly';
  if(o.status!=='filled'||!['buy','sell'].includes(o.side))return 'not_filled_equity_trade';
  if(o.api_id)return 'api_fee_preserved';
  if(o.fees!==0)return 'existing_fee_preserved';
  if(s.corrections.some(e=>e.order_id===o.id))return 'fee_already_reconstructed';
  if(o.market!==r.market||o.code!==r.code)return 'security_identity_mismatch';
  const expected=s.account.providerId==='longbridge'?'US':s.account.providerId==='huatai'?'CN':'';
  if(o.market!==expected||r.account_market&&r.account_market!==o.market||o.settlement_currency||o.settlement_amount!==null)return 'market_or_settlement_not_supported';
  const evidence=s.evidence.find(e=>e.order_id===o.id);
  if(evidence&&evidence.source!=='legacy_import_zero')return 'explicit_fee_preserved';
  if(evidence&&evidence.input_hash!==feeInputFingerprint(o))return 'import_proof_changed';
  const currency=o.market==='US'?'USD':'CNY';
  if(getDb().prepare(`SELECT 1 FROM broker_cash_accounts WHERE user_id=? AND currency=? AND opening_basis='allocate_verified_unallocated_checkpoint'
    AND (julianday(?) IS NULL OR julianday(?)<=julianday(opening_at)) LIMIT 1`).get(o.user_id,currency,o.traded_at,o.traded_at))return 'opening_checkpoint_requires_reconciliation';
  const link=getDb().prepare('SELECT account_id,currency,user_id FROM broker_cash_order_links WHERE order_id=?').get(o.id) as {account_id:string;currency:string;user_id:string}|undefined;
  if(link&&(link.account_id!==s.account.id||link.currency!==currency||link.user_id!==o.user_id))return 'cash_ownership_mismatch';
  if(link){s.cashModel??=brokerCashSnapshot(o.user_id,s.account.id);if(!s.cashModel.currencies.find(c=>c.currency===currency)?.complete)return 'cash_source_incomplete';}
  return null;
}
export function historicalFeeSnapshot(userId:string,accountId:string) {return getDb().transaction(()=>{
  const s=state(userId,accountId),owned=new Map(s.records.filter(r=>r.broker_account_id===accountId).map(r=>[r.id,r]));
  return {version:1,accountId:userId,brokerAccountId:accountId,providerId:s.account.providerId,brokerRevision:s.account.revision,snapshotRevision:s.revision,globalCashRevision:s.cash,collectionRevision:collectionRevision(userId),ruleVersion:HISTORICAL_FEE_RULE_VERSION,asOf:new Date().toISOString(),ordersComplete:true,
    items:s.orders.filter(o=>owned.has(o.record_id)).map(o=>{const r=owned.get(o.record_id)!,reason=baseExclusion(o,r,s),e=s.evidence.find(e=>e.order_id===o.id);return {orderId:o.id,recordId:r.id,market:o.market,code:o.code,side:o.side,status:o.status,qty:o.qty,price:o.price,amount:o.amount,fees:o.fees,tradedAt:o.traded_at,revision:o.revision,recordRevision:r.revision,exclusion:reason,importProof:e?.source==='legacy_import_zero'?'verified_input':'unavailable',manualReviewRequired:!reason&&!e};}),
    unassignedOrderIds:s.orders.filter(o=>!s.records.find(r=>r.id===o.record_id)?.broker_account_id).map(o=>o.id),
    supportedProviders:['longbridge','huatai'],automaticZeroFeeRepair:false};
})();}
function localDay(o:Row){
  if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(o.traded_at)||!Number.isFinite(Date.parse(o.traded_at)))return '';
  return new Intl.DateTimeFormat('en-CA',{timeZone:o.market==='US'?'America/New_York':'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(o.traded_at));
}
function replay(record:RecordRow,rows:Row[],newFees:Map<string,number>) {
  const sorted=[...rows].sort((a,b)=>Date.parse(a.traded_at)-Date.parse(b.traded_at)||Date.parse(a.created_at)-Date.parse(b.created_at));
  const first=sorted[0];if(!first||!Number.isFinite(first.position_qty_before)||first.position_qty_before<0||first.position_qty_before>0&&(first.position_cost_before===null||!Number.isFinite(first.position_cost_before)))throw conflict('缺少可核对的期初持仓成本');
  let qty=first.position_qty_before,cost=qty>0?first.position_cost_before!:0;
  const keys=new Set<string>(),updates:{id:string;beforeQty:number;beforeCost:number|null;qty:number;cost:number|null;realized:number|null}[]=[];
  const orders:TradeOrder[]=[];
  for(const o of sorted){
    const key=`${Date.parse(o.traded_at)}:${Date.parse(o.created_at)}`;
    if(keys.has(key)||![o.qty,o.price,o.fees,o.amount,Date.parse(o.traded_at),Date.parse(o.created_at)].every(Number.isFinite)||!['buy','sell','dividend'].includes(o.side)||o.qty<=0||o.price<=0||o.fees<0||Math.abs(o.amount-o.qty*o.price)>1e-8*Math.max(1,o.amount)||o.market!==record.market||o.code!==record.code||o.settlement_currency||o.settlement_amount!==null)throw conflict('历史顺序、金额或证券身份需要独立核对');
    keys.add(key);
    const fees=newFees.get(o.id)??o.fees,beforeQty=qty,beforeCost=qty>0?cost:null;
    if(o.side==='sell'&&o.qty>qty+1e-10)throw conflict('历史持仓数量无法对平');
    const next=applyOrder({qty,cost},{side:o.side,qty:o.qty,price:o.price,fees});qty=next.qty;cost=next.cost;
    if(!Number.isFinite(cost)||!Number.isFinite(qty))throw conflict('历史派生金额超出范围');
    updates.push({id:o.id,beforeQty,beforeCost,qty,cost:qty>0?cost:null,realized:null});
    orders.push({id:o.id,side:o.side,status:'filled',qty:o.qty,price:o.price,fees,tradedAt:new Date(o.traded_at).toISOString(),createdAt:new Date(o.created_at).toISOString()} as TradeOrder);
  }
  if(!Number.isFinite(record.qty??0)||Math.abs(qty-(record.qty??0))>1e-8)throw conflict('历史订单与当前持仓数量不符');
  const economic=replayEconomicOrders(orders,{qty:first.position_qty_before,cost:first.position_cost_before});
  for(const update of updates)update.realized=economic.realizedByOrder.get(update.id)??null;
  return {updates,qty,cost:qty>0?cost:null,realizedPnl:economic.complete?economic.realizedPnl:null};
}
function calculate(userId:string,b:Input){
  if(b.accountId!==userId)throw new RecordsError('本人账户不存在',404);
  const s=state(userId,b.brokerAccountId);
  if(s.account.holdingSource!=='manual')throw new RecordsError('官方账户费用只读',409,40903);
  if(s.account.providerId!==b.providerId||s.account.revision!==b.brokerRevision||s.revision!==b.snapshotRevision)throw conflict('账户、订单或资金已变化，请重新核对');
  const records=new Map(s.records.map(r=>[r.id,r])),orders=new Map(s.orders.map(o=>[o.id,o]));
  const excluded:{orderId:string;reason:string}[]=[],candidates=[];
  const selectedRows:Row[]=[];
  for(const selection of b.orders){
    const o=orders.get(selection.orderId),r=o?records.get(o.record_id):undefined;
    if(!o||!r||r.broker_account_id!==s.account.id)throw new RecordsError('本人券商订单不存在',404);
    if(o.revision!==selection.revision||r.revision!==selection.recordRevision)throw conflict('订单或持仓版本已变化');
    let reason=baseExclusion(o,r,s);
    const proof=s.evidence.find(e=>e.order_id===o.id);
    if(!reason&&!proof&&selection.legacyImportConfirmed!==true)reason='legacy_import_proof_missing_manual_review';
    if(!reason&&!selection.brokerOwnershipConfirmed)reason='historical_broker_ownership_unconfirmed';
    if(!reason&&!selection.wholeOrderConfirmed)reason='split_order_or_discount_unconfirmed';
    const fees=historicalFee(b.providerId,localDay(o),o.side,o.qty,o.price,selection.instrumentKind,b.plan);
    reason=reason??fees.reason;
    if(reason){excluded.push({orderId:o.id,reason});continue;}
    candidates.push({orderId:o.id,recordId:o.record_id,market:o.market,code:o.code,side:o.side,qty:o.qty,price:o.price,tradedAt:o.traded_at,currency:o.market==='US'?'USD':'CNY',oldFees:o.fees,newFees:fees.fees!,feeDelta:fees.fees!-o.fees,components:fees.components,source:'owner_reconstructed',importProof:proof?'verified_input':'owner_reviewed_legacy_import',instrumentKind:selection.instrumentKind});selectedRows.push(o);
  }
  const newFees=new Map(candidates.map(c=>[c.orderId,c.newFees])),impacts=[];
  for(const recordId of new Set(selectedRows.map(o=>o.record_id))){
    const r=records.get(recordId)!,history=s.orders.filter(o=>o.record_id===recordId&&o.status==='filled');
    try{
      const before=replay(r,history,new Map()),after=replay(r,history,newFees);
      // A manual snapshot/import gap must not be silently replaced by a guessed opening cost.
      if(before.cost!==null&&(r.cost===null||Math.abs(before.cost-r.cost)>.00100001))throw conflict('现持仓成本与历史重放不符');
      impacts.push({recordId,beforeCost:r.cost,afterCost:after.cost,beforeRealizedPnl:before.realizedPnl,afterRealizedPnl:after.realizedPnl,updates:after.updates});
    }catch(e){if(!(e instanceof RecordsError))throw e;for(const c of candidates.filter(c=>c.recordId===recordId))excluded.push({orderId:c.orderId,reason:'position_history_requires_reconciliation'});}
  }
  const accepted=candidates.filter(c=>!excluded.some(e=>e.orderId===c.orderId));
  const currency=b.providerId==='longbridge'?'USD':'CNY',feeDelta=Math.round(accepted.reduce((n,c)=>n+c.feeDelta,0)*100)/100;
  const funds=readFundBalances(userId),beforeCash=funds[currency];
  if(!Number.isFinite(beforeCash)||Math.abs(beforeCash)>1e12||Math.abs(beforeCash-feeDelta)>1e12)throw conflict('现金来源不完整或金额超出核对范围');
  const accountCash=(s.cashModel??brokerCashSnapshot(userId,b.brokerAccountId)).currencies.find(c=>c.currency===currency);
  const brokerDelta=-Math.round(accepted.filter(c=>getDb().prepare('SELECT 1 FROM broker_cash_order_links WHERE order_id=? AND user_id=?').get(c.orderId,userId)).reduce((n,c)=>n+c.feeDelta,0)*100)/100||0;
  const all=historicalFeeSnapshot(userId,b.brokerAccountId);
  return {version:1,accountId:userId,brokerAccountId:b.brokerAccountId,providerId:b.providerId,ruleVersion:b.ruleVersion,snapshotRevision:s.revision,globalCashRevision:s.cash,collectionRevision:collectionRevision(userId),candidates:accepted,excluded,unselectedOrderIds:all.items.filter(o=>!b.orders.some(s=>s.orderId===o.orderId)).map(o=>o.orderId),
    cashEffect:{currency,before:beforeCash,after:beforeCash-feeDelta,delta:-feeDelta,brokerBefore:accountCash?.balance??null,brokerAfter:accountCash?.balance==null?null:accountCash.balance+brokerDelta,brokerDelta,unallocatedDelta:Math.round((-feeDelta-brokerDelta)*100)/100||0,externalFlow:0},
    positionEffects:impacts,canSubmit:accepted.length>0,automaticZeroFeeRepair:false};
}
const canonical=(b:Input)=>({...b,requestId:undefined,previewRevision:undefined});
function seal(userId:string,b:Input,p:ReturnType<typeof calculate>,expiresAt:number){const value=digest([userId,canonical(b),p,expiresAt]),key=getDb().prepare('SELECT secret FROM trade_fee_preview_key WHERE id=1').get() as {secret:Buffer};return createHmac('sha256',key.secret).update(value).digest('hex');}
export function previewHistoricalFees(userId:string,raw:unknown){const b=parse(raw);return getDb().transaction(()=>{
  const p=calculate(userId,b),expiresAt=Date.now()+ttl;
  return {...p,previewRevision:`${expiresAt}.${seal(userId,b,p,expiresAt)}`,expiresAt:new Date(expiresAt).toISOString(),positionEffects:p.positionEffects.map(({updates,...effect})=>effect)};
})();}
export function submitHistoricalFees(userId:string,raw:unknown,authorize:()=>string){const b=parse(raw),db=getDb();return db.transaction(()=>{
  if(authorize()!==userId)throw new RecordsError('连接已失效',401);
  if(db.prepare('SELECT 1 FROM app_asset_operations WHERE user_id=? AND request_id=?').get(userId,b.requestId))throw new RecordsError('UUID已使用，请查询原回执',409,40901);
  let data:unknown=null,error:RecordsError|null=null;
  try{data=db.transaction(()=>{
    const p=calculate(userId,b),match=b.previewRevision?.match(/^(\d{13})\.([a-f0-9]{64})$/),expiresAt=Number(match?.[1]);
    if(!p.canSubmit||!match||!Number.isSafeInteger(expiresAt)||expiresAt<Date.now()||expiresAt>Date.now()+ttl||!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(seal(userId,b,p,expiresAt),'hex')))throw conflict('费用预览已失效，请重新核对并确认');
    const now=new Date().toISOString(),ids=new Set(p.candidates.map(c=>c.orderId));
    withBrokerFeeCorrection(db,ids,()=>{
      for(const c of p.candidates){
        db.prepare('UPDATE trade_orders SET fees=? WHERE user_id=? AND id=?').run(c.newFees,userId,c.orderId);
        db.prepare('INSERT INTO trade_fee_corrections VALUES(?,?,?,?,?,?,?,?)').run(c.orderId,userId,b.requestId,'owner_reconstructed',c.oldFees,c.newFees,JSON.stringify({ruleVersion:b.ruleVersion,brokerAccountId:b.brokerAccountId,providerId:b.providerId,plan:b.plan,confirmation:b.orders.find(o=>o.orderId===c.orderId),...c}),now);
      }
      for(const effect of p.positionEffects){
        for(const u of effect.updates)db.prepare('UPDATE trade_orders SET position_qty_before=?,position_cost_before=?,position_qty_after=?,position_cost_after=?,realized_pnl=? WHERE id=? AND user_id=?').run(u.beforeQty,u.beforeCost,u.qty,u.cost,u.realized,u.id,userId);
        db.prepare('UPDATE records SET cost=?,updated_at=? WHERE id=? AND user_id=?').run(effect.afterCost,now,effect.recordId,userId);
      }
      for(const c of p.candidates)syncOrderCashTransaction(userId,c.orderId);
    });
    const actual=readFundBalances(userId)[p.cashEffect.currency as 'USD'|'CNY'];
    const tolerance=Math.max(1e-8,Number.EPSILON*Math.max(1,Math.abs(actual),Math.abs(p.cashEffect.before))*8);
    if(!Number.isFinite(actual)||Math.abs(actual-p.cashEffect.after)>tolerance)throw conflict('现金差额核对不一致');
    return {operationId:b.requestId,...p,positionEffects:p.positionEffects.map(({updates,...effect})=>effect),globalCashRevision:cashRevision(userId),collectionRevision:collectionRevision(userId),snapshot:historicalFeeSnapshot(userId,b.brokerAccountId)};
  })();}catch(e){if(!(e instanceof RecordsError))throw e;error=e;}
  const result={requestId:b.requestId,kind:'historical_fee_repair',accountId:userId,state:error?'failed':'completed',code:error?.code??0,message:error?.message??'ok',data,completedAt:new Date().toISOString()};
  db.prepare('INSERT INTO app_asset_operations VALUES(?,?,?)').run(userId,b.requestId,JSON.stringify(result));return {result,error};
}).immediate();}
