import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {getDb} from './db';
import {RecordsError,validRecordRequestId} from './recordsContract';
import {readRecord} from './store';
import {assetOrderRows,assetOrderItem} from './appAssetOrders';
import {tradingSnapshot} from './appTrading';
import {applyOrder} from './tradeAccounting';
import {replayEconomicOrders} from './portfolioLedger';
import {readFundBalances,orderCashAmount,syncOrderCashTransaction} from './funds';
import {cashRevision,brokerCashSnapshot} from './brokerCash';
import {pendingBuyCash} from './brokerCashRead';
import {isStockConnect} from './stockAccount';
import {withTradeCorrection} from './tradeCorrectionSchema';
import {decimal as D,feeNumber,feeSum} from './feeDecimal';
import {strictObject,parseFeeInput,calculateTradeFees,saveTradeFee,type FeeInput} from './tradeFees';
import {generateOrderNo} from './orderNo';
import type {StockRecord,TradeOrder} from './types';

type Row=ReturnType<typeof assetOrderRows>[number];
type Replacement={qty:number;price:number;fees:number;tradedAt:string;feeInput?:FeeInput};
type Request={requestId:string;accountId:string;snapshotRevision:string;recordId:string;recordRevision:number;action:'amend'|'merge'|'delete';orders:{id:string;revision:number}[];replacement?:Replacement;timeSourceOrderId?:string;previewRevision?:string};
const conflict=(m:string)=>new RecordsError(m,409,40902),ttl=600_000;
const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):v;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const canonical=(b:Request)=>{const {previewRevision,...request}=b;void previewRevision;return request;};
const num=(v:unknown)=>{if(typeof v!=='number'||!Number.isFinite(v))throw conflict('历史金额或数量缺失');return v;};
function time(raw:unknown){
  if(typeof raw!=='string')throw new RecordsError('须明确成交时间');
  const m=raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  const ms=Date.parse(raw);if(!m||+m[2]>23||+m[3]>59||+m[4]>59||!Number.isFinite(ms)||ms>Date.now()||new Date(m[1]+'T00:00:00Z').toISOString().slice(0,10)!==m[1])throw new RecordsError('成交日期或时区无效');return ms;
}
function parse(raw:unknown):Request{
  const b=strictObject(raw,['requestId','accountId','snapshotRevision','recordId','recordRevision','action','orders','replacement','timeSourceOrderId','previewRevision']) as Request;validRecordRequestId(b.requestId);
  if(typeof b.accountId!=='string'||typeof b.recordId!=='string'||!b.recordId||b.recordId.length>200||!Number.isSafeInteger(b.recordRevision)||b.recordRevision<1||!/^([a-f0-9]{64})$/.test(b.snapshotRevision)||!['amend','merge','delete'].includes(b.action)||!Array.isArray(b.orders)||!b.orders.length||b.orders.length>100)throw new RecordsError('更正目标及版本无效');
  for(const s of b.orders){strictObject(s,['id','revision']);if(typeof s.id!=='string'||!s.id||s.id.length>200||!Number.isSafeInteger(s.revision)||s.revision<1)throw new RecordsError('原订单选择无效');}
  if(new Set(b.orders.map(o=>o.id)).size!==b.orders.length||(b.action==='merge'?b.orders.length<2:b.orders.length!==1))throw new RecordsError('订单选择重复或数量不符');
  if(b.action==='delete'){if(b.replacement!==undefined||b.timeSourceOrderId!==undefined)throw new RecordsError('删除不接受替换体');}
  else{
    const p=strictObject(b.replacement,['qty','price','fees','tradedAt','feeInput']) as Replacement;
    if([p.qty,p.price,p.fees].some(v=>typeof v!=='number'))throw new RecordsError('替换金额须为数值');feeNumber(p.qty);feeNumber(p.price);feeNumber(p.fees,true);if(D(p.qty).mul(D(p.price)).cmp(D('1000000000000'))>0)throw new RecordsError('成交额超出范围');time(p.tradedAt);parseFeeInput(p.feeInput);
    if(b.action==='merge'?!b.orders.some(o=>o.id===b.timeSourceOrderId):b.timeSourceOrderId!==undefined)throw new RecordsError('合并须选择原单时间');
  }
  if(b.previewRevision!==undefined&&(typeof b.previewRevision!=='string'||!/^\d{13}\.[a-f0-9]{64}$/.test(b.previewRevision)))throw new RecordsError('更正预览凭证无效');
  return b;
}
function historical(row:Row){return {id:row.id,side:row.side,status:row.status,qty:num(row.qty),price:num(row.price),fees:num(row.fees),amount:num(row.amount),tradedAt:new Date(time(row.traded_at)).toISOString(),createdAt:new Date(time(row.created_at)).toISOString()} as TradeOrder;}
function replay(record:StockRecord,rows:Row[],initial:{qty:number;cost:number}){
  let qty=initial.qty,cost=initial.cost;
  const sorted=[...rows].sort((a,b)=>time(a.traded_at)-time(b.traded_at)||time(a.created_at)-time(b.created_at)),seen=new Set<string>(),updates=[];
  for(const o of sorted){
    const key=`${time(o.traded_at)}:${time(o.created_at)}`;
    if(seen.has(key))throw conflict('同一时间的历史无法证明先后顺序');seen.add(key);
    const q=num(o.qty),p=num(o.price),f=num(o.fees);feeNumber(q);feeNumber(p);feeNumber(f,true);
    if(!['buy','sell','dividend'].includes(String(o.side))||o.market!==record.market||o.code!==record.code||o.settlement_currency||o.settlement_amount!==null||Math.abs(D(q).mul(D(p)).sub(D(num(o.amount))).number())>0.0000001)throw conflict('历史证券、结算或成交金额不一致');
    if(o.side==='sell'&&D(q).cmp(D(qty))>0)throw conflict('更正后历史出现超卖');
    const beforeQty=qty,beforeCost=qty>0?cost:0,next=applyOrder({qty,cost},{side:o.side as 'buy'|'sell'|'dividend',qty:q,price:p,fees:f});qty=Number(next.qty.toFixed(8));cost=next.cost;
    if(!Number.isFinite(cost)||!Number.isFinite(qty)||Math.abs(cost)>1e12||qty>1e12)throw conflict('派生持仓超出范围');
    updates.push({id:o.id,beforeQty,beforeCost,qty,cost:qty>0?cost:null,realized:null as number|null});
  }
  const economic=replayEconomicOrders(sorted.map(historical),initial);
  if(!economic.complete)throw conflict('经济盈亏历史缺少可核对成本');
  for(const u of updates)u.realized=economic.realizedByOrder.get(u.id)??null;
  return {qty,cost:qty>0?cost:0,updates,realized: economic.realizedPnl};
}
function calculate(userId:string,b:Request){
  if(b.accountId!==userId)throw new RecordsError('本人账户不存在',404);
  const db=getDb(),state=tradingSnapshot(userId),record=readRecord(userId,b.recordId);
  if(!record)throw new RecordsError('本人持仓不存在',404);
  if(record.revision!==b.recordRevision||state.snapshotRevision!==b.snapshotRevision)throw conflict('持仓或成交快照已变化');
  if(!['US','HK','CN'].includes(record.market)||isStockConnect(record)||!record.brokerAccountId)throw conflict('须有稳定手动券商归属，港股通需专门净结算更正');
  const account=db.prepare('SELECT * FROM broker_accounts WHERE id=? AND user_id=?').get(record.brokerAccountId,userId) as {id:string;provider_id:string;holding_source:string;revision:number}|undefined;
  if(!account)throw new RecordsError('券商账户不存在',404);if(account.holding_source!=='manual')throw new RecordsError('官方账单账户不可手动更正',409,40903);
  const rows=assetOrderRows(userId),selected=b.orders.map(s=>{const o=rows.find(o=>o.id===s.id);if(!o)throw new RecordsError('本人订单不存在',404);if(o.revision!==s.revision||o.record_id!==record.id||o.status!=='filled'||o.market!==record.market||o.code!==record.code||o.parent_id||o.role&&o.role!=='parent'||rows.some(r=>r.parent_id===o.id)||o.correction_operation)throw conflict('所选订单身份、状态或附加单不支持更正');
    if(o.role){let draft;try{draft=JSON.parse(String(o.submission_draft));}catch{throw conflict('成交原确认缺失');}if(draft.attachments)throw conflict('带附加单的成交不能直接更正');}
    const item=assetOrderItem(userId,o,undefined,record);if(item.brokerAccountId!==account.id)throw conflict('历史券商归属缺证据或与当前账户冲突');return o;});
  if(new Set(selected.map(o=>o.side)).size!==1||!['buy','sell'].includes(String(selected[0].side)))throw conflict('只支持同证券同方向买卖成交');
  if(rows.some(o=>o.record_id===record.id&&o.status==='pending'))throw conflict('请先处理本证券待成交委托');
  const history=rows.filter(o=>o.record_id===record.id&&o.status==='filled').sort((a,b)=>time(a.traded_at)-time(b.traded_at)||time(a.created_at)-time(b.created_at));
  if(history.length>5000)throw conflict('历史数量超过一次重放上限');
  const first=history[0],baseQty=num(first.position_qty_before),baseCost=baseQty>0?num(first.position_cost_before):0;
  if(baseQty<0)throw conflict('期初持仓无效');
  const before=replay(record,history,{qty:baseQty,cost:baseCost});
  if(record.qty===''||record.cost===''&&before.qty>0||Math.abs(before.qty-Number(record.qty))>1e-8||Math.abs(before.cost-Number(record.cost||0))>0.00100001)throw conflict('原始持仓与历史账本不符，须先核对期初');
  const currency=record.market==='US'?'USD':record.market==='CN'?'CNY':'HKD',replacementId=b.replacement?'o-correction-'+b.requestId:null;
  const links=selected.map(o=>db.prepare('SELECT * FROM broker_cash_order_links WHERE order_id=? AND user_id=?').get(o.id,userId) as {account_id:string;currency:string}|undefined);
  if(links.some(l=>l&&(l.account_id!==account.id||l.currency!==currency))||links.some(Boolean)&&!links.every(Boolean))throw conflict('原成交现金归属不同，不能合并或搬移');
  let replacement:Row|undefined,detail:ReturnType<typeof calculateTradeFees>|undefined;
  if(b.replacement){const p=b.replacement,source=selected.find(o=>o.id===(b.timeSourceOrderId??selected[0].id))!;
    if(b.action==='merge'){
      if(p.tradedAt!==source.traded_at)throw conflict('合并时间须与所选原单严格相同');
      if(feeSum(selected.map(o=>D(num(o.qty)))).cmp(D(p.qty))!==0||feeSum(selected.map(o=>D(num(o.amount)))).cmp(D(p.qty).mul(D(p.price)))!==0)throw conflict('合并数量或本金不守恒，不能舍入加权均价');
    }
    if(time(p.tradedAt)<time(first.traded_at)&&baseQty>0)throw conflict('替换时间跨越未核实的期初边界');
    replacement={...source,id:replacementId!,status:'filled',qty:p.qty,price:p.price,fees:p.fees,amount:D(p.qty).mul(D(p.price)).number(),traded_at:p.tradedAt,created_at:String(source.created_at),api_id:null,role:null,parent_id:null};
    if(p.feeInput)detail=calculateTradeFees(userId,record,{...p,side:String(source.side),mode:'record'},p.feeInput);
  }
  const afterRows=[...history.filter(o=>!selected.some(s=>s.id===o.id)),...(replacement?[replacement]:[])],after=replay(record,afterRows,{qty:baseQty,cost:baseCost});
  const checkpoints=db.prepare("SELECT opening_at,opening_basis FROM broker_cash_accounts WHERE user_id=? AND currency=?").all(userId,currency) as {opening_at:string;opening_basis:string}[];
  for(const c of checkpoints)if(c.opening_basis==='allocate_verified_unallocated_checkpoint'&&[...selected,...replacement?[replacement]:[]].some(o=>time(o.traded_at)<=time(c.opening_at)))throw conflict('历史已被现金期初覆盖，须先独立核对');
  const cashAccount=db.prepare('SELECT opening_at FROM broker_cash_accounts WHERE user_id=? AND account_id=? AND currency=?').get(userId,account.id,currency) as {opening_at:string}|undefined;
  if(replacement&&cashAccount&&time(replacement.traded_at)<time(cashAccount.opening_at))throw conflict('替换时间早于资金期初');
  const cashBefore=readFundBalances(userId)[currency],beforeEffect=feeSum(selected.map(o=>D(orderCashAmount(o as unknown as Parameters<typeof orderCashAmount>[0])))),afterEffect=replacement?D(orderCashAmount(replacement as unknown as Parameters<typeof orderCashAmount>[0])):D(0),cashDelta=afterEffect.sub(beforeEffect),cashAfter=D(cashBefore).add(cashDelta).number();
  const reserved=pendingBuyCash(userId,currency);
  if(reserved===null||cashAfter<reserved||cashAfter<0)throw conflict('更正后的现金不足或待成交占用不完整');
  if(links.every(Boolean)){const ledger=brokerCashSnapshot(userId,account.id).currencies.find(c=>c.currency===currency);if(!ledger?.complete||ledger.balance===null||D(ledger.balance).add(cashDelta).cmp(D(0))<0)throw conflict('券商现金来源不完整或更正后不足');}
  const feeBefore=feeSum(selected.map(o=>D(num(o.fees)))).number(),feeAfter=replacement?num(replacement.fees):0;
  const fundsRevision=cashRevision(userId);
  return {record,account,selected,replacement,after,links,detail,proof:hash([account,fundsRevision,rows]),public:{request:canonical(b),currency,cashBefore,cashAfter,cashDelta:cashDelta.number(),quantityBefore:before.qty,quantityAfter:after.qty,costBefore:before.cost,costAfter:after.cost,realizedBefore:before.realized,realizedAfter:after.realized,feeBefore,feeAfter,feeSource:detail?.source??'owner_recorded',feeDetail:detail??null,affectedOrderCount:new Set([...selected.map(o=>o.id),...after.updates.map(o=>o.id)]).size,canSubmit:true,brokerAccountId:account.id,preservesOriginals:true}};
}
function signature(userId:string,b:Request,p:ReturnType<typeof calculate>,expires:number){const key=getDb().prepare('SELECT secret FROM trade_fee_preview_key WHERE id=1').get() as {secret:Buffer};return createHmac('sha256',key.secret).update(hash([userId,canonical(b),p.proof,p.public,expires])).digest('hex');}
export function previewTradeCorrection(userId:string,raw:unknown){const b=parse(raw);return getDb().transaction(()=>{const p=calculate(userId,b),expires=Date.now()+ttl;return {...p.public,previewRevision:`${expires}.${signature(userId,b,p,expires)}`,expiresAt:new Date(expires).toISOString()};})();}
export function submitTradeCorrection(userId:string,raw:unknown,authorize:()=>string){const b=parse(raw),db=getDb();return db.transaction(()=>{
  if(authorize()!==userId)throw new RecordsError('连接已失效',401);
  const previous=db.prepare('SELECT request_hash FROM trade_correction_operations WHERE user_id=? AND request_id=?').get(userId,b.requestId) as {request_hash:string}|undefined,h=hash(canonical(b));
  const receipt=db.prepare('SELECT result_json FROM app_asset_operations WHERE user_id=? AND request_id=?').get(userId,b.requestId) as {result_json:string}|undefined;
  if(receipt){if(previous?.request_hash===h)return {result:JSON.parse(receipt.result_json),error:null};throw new RecordsError('UUID已用于不同操作，请查询原回执',409,40901);}
  let data:unknown=null,error:RecordsError|null=null;
  try{data=db.transaction(()=>{
    const p=calculate(userId,b),match=b.previewRevision?.match(/^(\d{13})\.([a-f0-9]{64})$/),expires=Number(match?.[1]);
    if(!match||expires<Date.now()||expires>Date.now()+ttl||!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(signature(userId,b,p,expires),'hex')))throw conflict('更正预览过期或内容变化，请重新确认');
    const now=new Date().toISOString(),replacement=p.replacement,allIds=new Set([...p.selected.map(o=>o.id),...replacement?[replacement.id]:[]]);
    withTradeCorrection(db,allIds,()=>{
      for(const o of p.selected){
        const original=db.prepare('SELECT * FROM trade_orders WHERE user_id=? AND id=?').get(userId,o.id),metadata=db.prepare('SELECT * FROM app_trade_metadata WHERE order_id=?').get(o.id),fee=db.prepare('SELECT * FROM trade_fee_details WHERE order_id=? AND user_id=?').get(o.id,userId),evidence=db.prepare('SELECT * FROM trade_fee_evidence WHERE order_id=? AND user_id=?').get(o.id,userId),historicalFee=db.prepare('SELECT * FROM trade_fee_corrections WHERE order_id=? AND user_id=?').get(o.id,userId),cashLink=db.prepare('SELECT * FROM broker_cash_order_links WHERE order_id=? AND user_id=?').get(o.id,userId);
        db.prepare('INSERT INTO trade_correction_originals VALUES(?,?,?,?,?,?)').run(o.id,userId,b.requestId,replacement?.id??null,JSON.stringify({order:original,metadata:metadata??null,fee:fee??null,evidence:evidence??null,historicalFee:historicalFee??null,cashLink:cashLink??null,originalReceiptImmutable:true}),now);
        db.prepare("UPDATE trade_orders SET status='cancelled',trigger_status='已由更正凭证替代' WHERE id=? AND user_id=?").run(o.id,userId);
      }
      if(replacement){
        const original=db.prepare('SELECT * FROM trade_orders WHERE id=? AND user_id=?').get(p.selected[0].id,userId) as Record<string,unknown>;
        const insert={...original,id:replacement.id,order_no:generateOrderNo(),status:'filled',qty:replacement.qty,price:replacement.price,fees:replacement.fees,amount:replacement.amount,traded_at:replacement.traded_at,created_at:replacement.created_at,trigger_status:'成交更正替换记录'};
        const columns=Object.keys(insert);db.prepare(`INSERT INTO trade_orders (${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(insert));
        db.prepare('INSERT INTO trade_correction_replacements VALUES(?,?,?,?)').run(replacement.id,userId,b.requestId,now);
        if(p.links.every(Boolean)){db.prepare('INSERT INTO broker_cash_order_links VALUES(?,?,?,?)').run(replacement.id,userId,p.account.id,p.public.currency);db.prepare('UPDATE broker_cash_accounts SET revision=revision+1 WHERE user_id=? AND account_id=? AND currency=?').run(userId,p.account.id,p.public.currency);}
        if(b.replacement?.feeInput&&p.detail)saveTradeFee(userId,replacement.id,b.replacement.feeInput,p.detail);
      }
      for(const u of p.after.updates)db.prepare('UPDATE trade_orders SET position_qty_before=?,position_cost_before=?,position_qty_after=?,position_cost_after=?,realized_pnl=? WHERE id=? AND user_id=?').run(u.beforeQty,u.beforeCost,u.qty,u.cost,u.realized,u.id,userId);
      db.prepare('UPDATE records SET qty=?,cost=?,updated_at=? WHERE id=? AND user_id=?').run(p.after.qty,p.after.qty>0?p.after.cost:null,now,b.recordId,userId);
      for(const id of allIds)syncOrderCashTransaction(userId,id);
    });
    const actual=readFundBalances(userId)[p.public.currency as 'USD'|'HKD'|'CNY'];if(Math.abs(actual-p.public.cashAfter)>Math.max(1e-8,Math.abs(actual)*Number.EPSILON*8))throw conflict('现金净差额核对不一致');
    const snapshot=tradingSnapshot(userId),affected=new Set([...allIds,...p.after.updates.map(o=>o.id)]);
    return {snapshot,items:assetOrderRows(userId).filter(o=>affected.has(o.id)).map(o=>assetOrderItem(userId,o)),preview:p.public};
  })();}catch(e){if(!(e instanceof RecordsError))throw e;error=e;}
  const result={requestId:b.requestId,accountId:userId,kind:'correct_trade',state:error?'failed':'completed',code:error?.code??0,message:error?.message??'ok',data,completedAt:new Date().toISOString()};
  db.prepare('INSERT INTO trade_correction_operations VALUES(?,?,?)').run(userId,b.requestId,h);db.prepare('INSERT INTO app_asset_operations VALUES(?,?,?)').run(userId,b.requestId,JSON.stringify(result));return {result,error};
}).immediate();}
