import { getDb } from './db';
import { RecordsError } from './recordsContract';
import { decimal as D,feeNumber,feeSum,FeeDecimal } from './feeDecimal';
import type { StockRecord } from './types';
import { isStockConnect } from './stockAccount';
import { validFeeDay,FEE_SOURCES } from './historicalFeeRules';

export const TRADE_FEE_RULE_VERSION='2026-10-23.1';
type Basis='free'|'percent'|'permille'|'share'|'order';
type Rule={basis:Basis;rate?:string|number;minimum?:string|number;maximum?:string|number;maximumPercent?:string|number;minimumWins?:boolean;side?:'both'|'buy'|'sell';tiers?:unknown[];graduated?:boolean};
type Plan={id?:string;revision?:number;effectiveFrom:string;effectiveThrough:string;overrides:Partial<Record<'commission'|'platform'|'fundCommission',Rule>>};
export type FeeInput={source:'owner_recorded'|'rule_calculated';brokerAccountId:string;providerId:string;confirmed:true;ruleVersion?:string;instrumentKind?:'us_domestic_equity'|'us_etf'|'cn_a_equity'|'cn_fund'|'hk_equity'|'hk_etf';plan?:Plan;components?:{kind:string;amount:number;currency:string}[]};
type Context={qty:number;price:number;fees:number;side:string;tradedAt?:string;mode?:string;attachments?:unknown};
export function strictObject(v:unknown,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new RecordsError('费用请求含未知字段');return v as Record<string,unknown>;}
function rule(raw:unknown):Rule{
  const r=strictObject(raw,['basis','rate','minimum','maximum','maximumPercent','minimumWins','side','tiers','graduated']) as Rule;
  if(!['free','percent','permille','share','order'].includes(r.basis)||r.side!==undefined&&!['both','buy','sell'].includes(r.side)||r.minimumWins!==undefined&&typeof r.minimumWins!=='boolean'||r.graduated!==undefined&&typeof r.graduated!=='boolean')throw new RecordsError('费率规则无效');
  if(r.tiers!==undefined&&(!Array.isArray(r.tiers)||r.tiers.length))throw new RecordsError('月阶梯缺完整成交序列，须手工登记费用',409,40902);
  for(const key of ['rate','minimum','maximum','maximumPercent'] as const)if(r[key]!==undefined)feeNumber(r[key],true);
  if(r.basis==='free'&&['rate','minimum','maximum','maximumPercent'].some(k=>k in r)||r.basis!=='free'&&r.rate===undefined||r.maximumPercent!==undefined&&D(r.maximumPercent).cmp(D(100))>0||r.basis==='percent'&&D(r.rate!).cmp(D(100))>0||r.basis==='permille'&&D(r.rate!).cmp(D(1000))>0)throw new RecordsError('费率及上下限无效');
  return r;
}
export function parseFeeInput(raw:unknown):FeeInput|undefined{
  if(raw===undefined)return;
  const b=strictObject(raw,['source','brokerAccountId','providerId','confirmed','ruleVersion','instrumentKind','plan','components']) as FeeInput;
  if(!['owner_recorded','rule_calculated'].includes(b.source)||!/^ba-[a-f0-9]{24}$/.test(b.brokerAccountId)||!['longbridge','huatai'].includes(b.providerId)||b.confirmed!==true)throw new RecordsError('须确认本人稳定账户及费用来源');
  if(b.source==='rule_calculated'){
    if(b.ruleVersion!==TRADE_FEE_RULE_VERSION||!['us_domestic_equity','us_etf','cn_a_equity','cn_fund','hk_equity','hk_etf'].includes(b.instrumentKind??'')||b.components!==undefined)throw new RecordsError('规则版本或证券类型无效');
    const p=strictObject(b.plan,['id','revision','effectiveFrom','effectiveThrough','overrides']) as Plan;
    if(!validFeeDay(p.effectiveFrom)||!validFeeDay(p.effectiveThrough)||p.effectiveFrom>p.effectiveThrough||p.id!==undefined&&(typeof p.id!=='string'||p.id.length>100||!Number.isSafeInteger(p.revision)||p.revision!<1)||p.id===undefined&&p.revision!==undefined)throw new RecordsError('须确认个人费率适用期间');
    const overrides=strictObject(p.overrides,['commission','platform','fundCommission']);for(const r of Object.values(overrides))rule(r);
  }else{
    if(b.ruleVersion!==undefined||b.instrumentKind!==undefined||b.plan!==undefined)throw new RecordsError('手工费用不能冒充规则计算');
    if(b.components!==undefined){if(!Array.isArray(b.components)||b.components.length>20)throw new RecordsError('费用分项无效');const seen=new Set<string>();for(const r of b.components){strictObject(r,['kind','amount','currency']);if(typeof r.kind!=='string'||!r.kind||r.kind.length>60||seen.has(r.kind)||!['USD','HKD','CNY'].includes(r.currency))throw new RecordsError('费用分项身份无效');feeNumber(r.amount,true);seen.add(r.kind);}}
  }
  return b;
}
function amount(r:Rule,qty:FeeDecimal,gross:FeeDecimal,side:string){
  if(r.side&&r.side!=='both'&&r.side!==side||r.basis==='free')return D(0);
  let value=(r.basis==='order'?D(1):['percent','permille'].includes(r.basis)?gross:qty).mul(D(r.rate!)).div(D(r.basis==='percent'?100:r.basis==='permille'?1000:1));
  const caps=[r.maximum===undefined?null:D(r.maximum),r.maximumPercent===undefined?null:gross.mul(D(r.maximumPercent)).div(D(100))].filter((v):v is FeeDecimal=>v!==null);
  const cap=caps.length?caps.reduce((a,b)=>a.min(b)):null,min=r.minimum===undefined?null:D(r.minimum);
  if(r.minimumWins!==false){if(cap)value=value.min(cap);if(min)value=value.max(min);}else{if(min)value=value.max(min);if(cap)value=value.min(cap);}return value.round(2);
}
export function calculateTradeFees(userId:string,record:StockRecord,ctx:Context,input:FeeInput){
  const db=getDb(),account=db.prepare('SELECT id,provider_id,holding_source,revision FROM broker_accounts WHERE user_id=? AND id=?').get(userId,input.brokerAccountId) as {id:string;provider_id:string;holding_source:string;revision:number}|undefined;
  if(!account||record.brokerAccountId!==account.id)throw new RecordsError('费用所属券商与本人持仓不符',409,40902);
  if(account.provider_id!==input.providerId||account.holding_source!=='manual')throw new RecordsError('费用账户来源或券商已变化',409,40903);
  const market=record.market==='HK'?isStockConnect(record)?'connect':'hk':record.market==='US'?'us':record.market==='CN'?'cn':'';
  if(!market)throw new RecordsError('该市场尚不支持费用来源分项');
  const currency=market==='us'?'USD':market==='cn'?'CNY':'HKD',qty=feeNumber(ctx.qty),gross=qty.mul(feeNumber(ctx.price)),parts:{kind:string;amount:number;currency:string;rule?:unknown;source:string}[]=[];
  if(gross.cmp(D('1000000000000'))>0)throw new RecordsError('费用成交额超出范围');
  feeNumber(ctx.fees,true);
  if(input.source==='owner_recorded'){
    if(input.components){if(input.components.some(c=>c.currency!==currency)||feeSum(input.components.map(c=>D(c.amount))).cmp(D(ctx.fees))!==0)throw new RecordsError('手工分项合计或币种与总费不符');for(const c of input.components)parts.push({...c,source:'owner_recorded'});}
    return {source:input.source,currency,total:ctx.fees,components:input.components?parts:null,brokerAccountId:account.id,providerId:account.provider_id,brokerRevision:account.revision,ruleVersion:null,ruleSnapshot:null};
  }
  if(ctx.mode==='order'||ctx.attachments)throw new RecordsError('自动费用目前仅支持实际成交，无附加单',409,40902);
  const date=ctx.tradedAt&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(ctx.tradedAt)?new Date(ctx.tradedAt):null;
  if(!date||!Number.isFinite(date.getTime())||!validFeeDay(ctx.tradedAt!.slice(0,10)))throw new RecordsError('规则费用须明确成交时区');
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:market==='us'?'America/New_York':'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date),p=input.plan!;
  if(day<p.effectiveFrom||day>p.effectiveThrough||day>'2026-10-23'||day<'2025-07-01')throw new RecordsError('成交日超出已核实规则或个人期间',409,40902);
  const validKind=market==='us'?['us_domestic_equity','us_etf']:market==='cn'?['cn_a_equity','cn_fund']:['hk_equity','hk_etf'];
  if(!validKind.includes(input.instrumentKind!))throw new RecordsError('证券分类与费用市场不符');
  const declared=db.prepare('SELECT market,code,kind FROM app_asset_instruments WHERE user_id=? AND record_id=?').get(userId,record.id) as {market:string;code:string;kind:string}|undefined;
  if(declared?.market===record.market&&declared.code===record.code&&declared.kind!=='unknown'&&((declared.kind==='etf')!==['us_etf','cn_fund','hk_etf'].includes(input.instrumentKind!)))throw new RecordsError('费用分类与已声明证券类型冲突',409,40902);
  if(!(input.providerId==='longbridge'&&['us','hk'].includes(market)||input.providerId==='huatai'&&['cn','connect'].includes(market)))throw new RecordsError('当前券商市场费用尚无完整规则',409,40902);
  const defaults:Record<string,Rule>=market==='cn'?{commission:{basis:'permille',rate:'0.1154',minimum:'5'},fundCommission:{basis:'permille',rate:'0.1',minimum:'5'}}:market==='connect'?{commission:{basis:'percent',rate:'0.3'}}:market==='hk'?{commission:{basis:'free'},platform:{basis:'order',rate:'15'}}:{commission:{basis:'free'},platform:qty.cmp(D(1))<0?{basis:'percent',rate:'0.99',maximum:'0.99'}:{basis:'share',rate:'0.005',minimum:'1',maximumPercent:'0.99'}};
  const add=(kind:string,value:FeeDecimal,spec:unknown,source:string)=>parts.push({kind,amount:value.round(2).number(),currency,rule:spec,source});
  const resolved:Record<string,Rule>={};
  const component=(kind:string)=>{const r=p.overrides[kind as keyof Plan['overrides']]??defaults[kind];if(!r)throw new RecordsError('费用规则不完整',409,40902);resolved[kind]=r;add(kind,amount(r,qty,gross,ctx.side),r,kind in p.overrides?'owner_personal_plan':'owner_confirmed_reference');};
  if(ctx.side==='dividend')throw new RecordsError('股息税及代收费用须按实际单据填写',409,40902);
  if(!['buy','sell'].includes(ctx.side))throw new RecordsError('费用方向无效');
  component(market==='cn'&&input.instrumentKind==='cn_fund'?'fundCommission':'commission');
  if(market!=='cn'&&market!=='connect'||p.overrides.platform)component('platform');
  if(market==='cn'){
    if(input.instrumentKind!=='cn_fund'){add('transfer',gross.mul(D('0.00001')),{rate:'0.00001',effectiveFrom:'2022-04-29'},FEE_SOURCES.cnTransfer);if(ctx.side==='sell')add('stamp',gross.mul(D('0.0005')),{rate:'0.0005',effectiveFrom:'2023-08-28'},FEE_SOURCES.cnStamp);}
  }else if(market==='us'){
    if(qty.cmp(D(1))>=0)add('clearing',qty.mul(D('0.003')).min(gross.mul(D('0.07'))),{perShare:'0.003',maximumGrossPercent:'7'},'owner_confirmed_reference');
    if(ctx.side==='sell'){
      if(day>='2026-04-02'&&day<='2026-04-04')throw new RecordsError('SEC切换日须按实际单据核对',409,40902);
      const sec=day<'2026-04-04'?'0':'0.0000206',paused=day>='2026-10-01',taf=day<'2026-01-01'?'0.000166':'0.000195',cap=day<'2026-01-01'?'8.30':'9.79';
      if(!paused&&D(ctx.price).cmp(D(taf))<0)throw new RecordsError('低价证券TAF须实际核对',409,40902);
      add('sec',sec==='0'?D(0):gross.mul(D(sec)).max(D('0.01')),{rate:sec,effectiveFrom:sec==='0'?'2025-05-14':'2026-04-04'},sec==='0'?FEE_SOURCES.sec2025:FEE_SOURCES.sec2026);
      add('taf',paused?D(0):qty.mul(D(taf)).min(D(cap)).max(D('0.01')),{rate:paused?'0':taf,maximum:cap,effectiveFrom:paused?'2026-10-01':day<'2026-01-01'?'2024-01-01':'2026-01-01'},paused?FEE_SOURCES.tafHoliday:FEE_SOURCES.taf);
    }
  }else{
    add('stamp',input.instrumentKind==='hk_etf'?D(0):gross.mul(D('0.001')).round(0,true),{rate:input.instrumentKind==='hk_etf'?'0':'0.001',etfClassification:'owner_confirmed'},input.instrumentKind==='hk_etf'?'https://www.ird.gov.hk/eng/faq/ETFs.htm':'https://www.ird.gov.hk/eng/faq/sdu.htm');
    for(const [kind,rate] of [['trading','0.0000565'],['sfc','0.000027'],['afrc','0.0000015'],['settlement','0.000042']])add(kind,gross.mul(D(rate)),{rate,effectiveFrom:kind==='settlement'?'2025-06-30':'2023-01-01'},kind==='settlement'?'https://www.hkex.com.hk/news/market-communications/2025/250221news?sc_lang=en':'https://www.hkex.com.hk/Services/Rules-and-Forms-and-Fees/Fees/Securities-(Hong-Kong)/Trading/Transaction?sc_lang=en');
  }
  const total=feeSum(parts.map(c=>D(c.amount))).number();
  if(D(total).cmp(D(ctx.fees))!==0)throw new RecordsError(`自动费用与服务端计算不符，应为 ${total} ${currency}`,409,40902);
  return {source:'rule_calculated',currency,total,components:parts,brokerAccountId:account.id,providerId:account.provider_id,brokerRevision:account.revision,ruleVersion:TRADE_FEE_RULE_VERSION,ruleSnapshot:{engineVersion:TRADE_FEE_RULE_VERSION,day,market,instrumentKind:input.instrumentKind,plan:p,resolvedRules:resolved,rounding:'component_half_up_2_then_sum',brokerBill:false}};
}
export type FeeDetail=ReturnType<typeof calculateTradeFees>;
export function clearTradeFee(userId:string,orderId:string){const db=getDb();db.prepare('INSERT INTO trade_fee_detail_history(order_id,user_id,input_json,detail_json,archived_at) SELECT order_id,user_id,input_json,detail_json,? FROM trade_fee_details WHERE user_id=? AND order_id=?').run(new Date().toISOString(),userId,orderId);db.prepare('DELETE FROM trade_fee_details WHERE user_id=? AND order_id=?').run(userId,orderId);}
export function saveTradeFee(userId:string,orderId:string,input:FeeInput,detail:FeeDetail){clearTradeFee(userId,orderId);getDb().prepare('INSERT INTO trade_fee_details VALUES(?,?,?,?,?)').run(orderId,userId,JSON.stringify(input),JSON.stringify(detail),new Date().toISOString());}
