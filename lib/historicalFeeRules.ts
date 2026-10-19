import { RecordsError } from './recordsContract';

export const HISTORICAL_FEE_RULE_VERSION = '2026-10-20.1';
export const FEE_SOURCES = {
  sec2025: 'https://www.sec.gov/files/rules/other/2025/34-102779.pdf',
  sec2026: 'https://www.sec.gov/rules-regulations/fee-rate-advisories/2026-2',
  taf: 'https://www.finra.org/sites/default/files/2024-11/sr-finra-2024-019.pdf',
  tafHoliday: 'https://www.sec.gov/files/rules/sro/finra/2026/34-106409.pdf',
  cnTransfer: 'https://jrj.sh.gov.cn/SCDT197/20220429/f715759a877b4158812eb6df70ccb49e.html',
  cnStamp: 'https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211343/content.html'
};
export type FeePlan = { effectiveFrom:string; effectiveThrough:string; confirmed:true; commissionIncludesExchangeFees?:true };
export type FeeComponent = {kind:string;amount:number;rate:number;basis:string;effectiveFrom:string;effectiveThrough:string;source:string};
const cents=(v:number)=>Math.round((v+Number.EPSILON*Math.max(1,v))*100)/100;
export function validFeeDay(v:unknown):v is string {return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
export function validateFeePlan(raw:unknown,provider:string):FeePlan {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RecordsError('须确认本人费率适用期间');
  const p=raw as FeePlan;
  if(Object.keys(p).some(k=>!['effectiveFrom','effectiveThrough','confirmed','commissionIncludesExchangeFees'].includes(k))||!validFeeDay(p.effectiveFrom)||!validFeeDay(p.effectiveThrough)||p.effectiveFrom>p.effectiveThrough||p.confirmed!==true||p.commissionIncludesExchangeFees!==undefined&&p.commissionIncludesExchangeFees!==true||provider==='huatai'&&p.commissionIncludesExchangeFees!==true)throw new RecordsError('本人费率及费用包含范围未确认');
  return p;
}
/** Owner-confirmed reconstruction, NOT a statement of the broker's actual historical bill. */
export function historicalFee(provider:string,day:string,side:string,qty:number,price:number,kind:string,plan:FeePlan) {
  const components:FeeComponent[]=[],gross=qty*price;
  const excluded=(reason:string)=>({reason,fees:null,components});
  if(!validFeeDay(day)||day>HISTORICAL_FEE_RULE_VERSION.slice(0,10)||day<plan.effectiveFrom||day>plan.effectiveThrough)return excluded('rate_period_unconfirmed');
  if(!['buy','sell'].includes(side)||![qty,price,gross].every(Number.isFinite)||qty<=0||price<=0||gross>1e12)return excluded('unsupported_trade');
  const add=(key:string,value:number,rate:number,basis:string,from:string,to:string,source:string)=>components.push({kind:key,amount:cents(value),rate,basis,effectiveFrom:from,effectiveThrough:to,source});
  if(provider==='longbridge'){
    if(!['us_domestic_equity','us_etf'].includes(kind))return excluded('instrument_or_adr_unconfirmed');
    if(!Number.isSafeInteger(qty))return excluded('fractional_order_requires_statement');
    if(day<'2025-05-14')return excluded('historical_rate_not_supported');
    // SEC charge date and execution date can straddle a rate change. Require the actual bill.
    if(side==='sell'&&day>='2026-04-02'&&day<='2026-04-04')return excluded('sec_charge_date_requires_statement');
    add('commission',0,0,'waived',plan.effectiveFrom,plan.effectiveThrough,'owner_confirmed_plan');
    add('platform',Math.max(1,Math.min(qty*.005,gross*.0099)),.005,'per_share_min_1_cap_0.99pct_minimum_wins',plan.effectiveFrom,plan.effectiveThrough,'owner_confirmed_plan');
    add('clearing',Math.min(qty*.003,gross*.07),.003,'per_share_cap_7pct_gross',plan.effectiveFrom,plan.effectiveThrough,'owner_confirmed_plan');
    if(side==='sell'){
      const sec=day<'2026-04-04'?0:.0000206;
      add('sec',sec===0?0:Math.max(.01,gross*sec),sec,'sell_gross_owner_confirmed_cent_rounding',sec===0?'2025-05-14':'2026-04-04',sec===0?'2026-04-03':'2026-10-20',sec===0?FEE_SOURCES.sec2025:FEE_SOURCES.sec2026);
      const paused=day>='2026-10-01',taf=paused?0:day<'2026-01-01'?.000166:.000195,cap=day<'2026-01-01'?8.30:9.79;
      if(taf>0&&price<taf)return excluded('low_price_taf_requires_statement');
      add('taf',taf===0?0:Math.max(.01,Math.min(qty*taf,cap)),taf,'sell_shares_owner_confirmed_min_0.01_cent_rounding',paused?'2026-10-01':day<'2026-01-01'?'2024-01-01':'2026-01-01',paused?'2026-12-31':day<'2026-01-01'?'2025-12-31':'2026-09-30',paused?FEE_SOURCES.tafHoliday:FEE_SOURCES.taf);
    }
  }else if(provider==='huatai'){
    if(kind!=='cn_a_equity')return excluded('cn_fund_or_instrument_requires_statement');
    if(day<'2022-04-29')return excluded('historical_rate_not_supported');
    add('commission',Math.max(5,gross*.0001154),.0001154,'gross_min_5_includes_exchange_regulatory_fees',plan.effectiveFrom,plan.effectiveThrough,'owner_confirmed_plan');
    add('transfer',gross*.00001,.00001,'gross_both_sides','2022-04-29','2026-10-20',FEE_SOURCES.cnTransfer);
    if(side==='sell'){const rate=day<'2023-08-28'?.001:.0005;add('stamp',gross*rate,rate,'sell_gross',day<'2023-08-28'?'2008-09-19':'2023-08-28',day<'2023-08-28'?'2023-08-27':'2026-10-20',FEE_SOURCES.cnStamp);}
  }else return excluded('provider_not_supported');
  return {reason:null,fees:cents(components.reduce((s,c)=>s+c.amount,0)),components};
}
