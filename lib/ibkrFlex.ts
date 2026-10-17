import { SaxesParser } from "saxes";
import { RecordsError } from "./recordsContract";
import { readLimitedResponseBytes } from "./requestBody";

export const FLEX_MAX_BYTES=8*1024*1024;
type Node={name:string;attrs:Record<string,string>;text:string;children:Node[]};
export function flexXml(text:string):Node {
  if(Buffer.byteLength(text)>FLEX_MAX_BYTES)throw new RecordsError('账单超过8MB',413);
  let root:Node|undefined,count=0;const stack:Node[]=[];
  const parser=new SaxesParser({xmlns:false});
  parser.on('doctype',()=>{throw new Error('doctype');});
  parser.on('opentag',tag=>{
    if(++count>100000||stack.length>=24)throw new Error('complex XML');
    const node:Node={name:tag.name,attrs:Object.fromEntries(Object.entries(tag.attributes).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,String(v)])),text:'',children:[]};
    if(stack.length)stack[stack.length-1].children.push(node);else root=node;stack.push(node);
  });
  parser.on('text',s=>{if(stack.length)stack[stack.length-1].text+=s;});
  parser.on('closetag',()=>{stack.pop();});
  try{parser.write(text).close();if(!root)throw new Error('empty');return root;}catch{throw new RecordsError('不是有效的IBKR XML账单',422);}
}
function descendants(n:Node,name:string):Node[]{return [...(n.name===name?[n]:[]),...n.children.flatMap(c=>descendants(c,name))];}
function numeric(s:string|undefined,field:string,negative=true) {
  if(!s||!/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(s))throw new RecordsError(`账单缺少有效${field}`,422);
  const n=Number(s);if(!Number.isFinite(n)||Math.abs(n)>1e15||!negative&&n<0)throw new RecordsError(`账单${field}超出范围`,422);return n;
}
function date(s:string|undefined){if(!s)throw new RecordsError('账单缺少日期',422);const d=s.replace(/-/g,'');if(!/^\d{8}$/.test(d)||!Number.isFinite(Date.parse(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00Z`))||new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00Z`).toISOString().slice(0,10).replace(/-/g,'')!==d)throw new RecordsError('账单日期无效',422);return d;}
export type FlexPosition={key:string;conid:string;code:string;name:string;market:string;currency:string;qty:number;price:number;cost:number};
export type FlexStatement={provider:string;externalAccount:string;fromDate:string;toDate:string;positions:FlexPosition[];cash:{currency:string;endingCash:number}[];events:{id:string;kind:string;data:Record<string,string>}[];warnings:string[]};
const exchanges:Record<string,string>={NASDAQ:'US',NYSE:'US',ARCA:'US',AMEX:'US',BATS:'US',ISLAND:'US',NYSEARCA:'US',NASDAQNMS:'US',SEHK:'HK',SEHKNTL:'CN',SEHKSZSE:'CN',SSE:'CN',SZSE:'CN'};
export function parseFlexStatement(text:string,externalAccount:string):FlexStatement {
  const root=flexXml(text);if(root.name!=='FlexQueryResponse')throw new RecordsError('需要Activity Flex XML报表',422);
  const statements=descendants(root,'FlexStatement').filter(n=>n.attrs.accountId===externalAccount);
  if(statements.length!==1)throw new RecordsError('报表账户不匹配或包含多个日期分段',422);
  const statement=statements[0],fromDate=date(statement.attrs.fromDate),toDate=date(statement.attrs.toDate);
  if(fromDate>toDate)throw new RecordsError('报表日期范围无效',422);
  if(['OpenPosition','Trade','CashReportCurrency','CashTransaction','CorporateAction','Transfer'].some(k=>descendants(statement,k).some(n=>n.attrs.accountId&&n.attrs.accountId!==externalAccount)))throw new RecordsError('持仓账户不一致',422);
  const positions:FlexPosition[]=[],cash:FlexStatement['cash']=[],events:FlexStatement['events']=[],warnings:string[]=[];
  if(!statement.children.some(n=>n.name==='OpenPositions'))throw new RecordsError('请在Flex查询中启用Open Positions汇总',422);
  const instruments=new Map(descendants(statement,'FinancialInstrument').map(n=>[n.attrs.conid,n.attrs]));const keys=new Set<string>();
  for(const node of descendants(statement,'OpenPosition')) {
    const a=node.attrs;
    if(a.levelOfDetail!=='SUMMARY')throw new RecordsError('Open Positions须选择SUMMARY，不能混合批次明细',422);
    if(a.assetCategory!=='STK')throw new RecordsError('当前仅支持股票及股票类ETF，报表包含其他持仓',422);
    if(date(a.reportDate)!==toDate)throw new RecordsError('持仓日期须与报表结束日期一致',422);
    if(a.model)throw new RecordsError('请导出未按Model拆分的持仓汇总',422);
    const listing=a.listingExchange||instruments.get(a.conid)?.listingExchange,market=listing?exchanges[listing]:undefined;
    if(!market||!['USD','HKD','CNY','CNH'].includes(a.currency))throw new RecordsError('证券上市市场或币种暂不支持，请包含ListingExchange字段',422);
    const expected=market==='US'?'USD':market==='HK'?'HKD':'CNY';if((a.currency==='CNH'?'CNY':a.currency)!==expected)throw new RecordsError('证券市场与币种不匹配',422);
    if(!/^\d+$/.test(a.conid??'')||!a.symbol)throw new RecordsError('账单缺少证券身份',422);
    const code=market==='HK'?a.symbol.padStart(5,'0'):a.symbol.toUpperCase();if(!/^[A-Za-z0-9._-]{1,40}$/.test(code))throw new RecordsError('证券代码暂不支持',422);
    const key=market+':'+code;if(keys.has(key))throw new RecordsError('报表有重复持仓，请仅选择账户汇总',422);keys.add(key);
    positions.push({key,conid:a.conid,code,name:(a.description||code).slice(0,100),market,currency:expected,qty:numeric(a.position,'持仓数量',false),price:numeric(a.markPrice,'收盘价',false),cost:numeric(a.costBasisPrice,'每股成本')});
  }
  if(positions.length>2000)throw new RecordsError('持仓数量超过2000',422);
  for(const node of descendants(statement,'CashReportCurrency')) {
    const a=node.attrs;if(a.currency==='BASE_SUMMARY')continue;
    if(!/^[A-Z]{3}$/.test(a.currency??''))throw new RecordsError('现金币种无效',422);
    if(cash.some(c=>c.currency===a.currency))throw new RecordsError('存在重复现金汇总',422);
    cash.push({currency:a.currency,endingCash:numeric(a.endingCash,'期末现金')});
  }
  const eventIds=new Set<string>();
  for(const kind of ['Trade','CashTransaction','CorporateAction','Transfer'])for(const node of descendants(statement,kind)) {
    const a=node.attrs;if(kind==='Trade'&&a.levelOfDetail!=='EXECUTION')continue;
    const id=a.transactionID||a.tradeID;if(!id){warnings.push(`${kind}缺少官方流水ID，未收录`);continue;}
    if(!/^[A-Za-z0-9._:-]{1,120}$/.test(id))throw new RecordsError('官方流水ID无效',422);
    const key=kind+':'+id;if(eventIds.has(key))throw new RecordsError('账单包含重复流水',422);eventIds.add(key);events.push({id:key,kind,data:a});
  }
  if(!cash.length)warnings.push('报表未提供分币种期末现金');
  warnings.push('持仓按期末快照核对；历史流水单独归档，不再次累加持仓或扣减现金');
  return {provider:'ibkr',externalAccount,fromDate,toDate,positions,cash,events,warnings:[...new Set(warnings)]};
}
const FLEX_BASE='https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/';
export async function requestFlex(token:string,queryId:string,reference?:string):Promise<{pending:true;reference:string}|{pending:false;xml:string}> {
  if(!/^[A-Za-z0-9]{10,256}$/.test(token)||!/^\d{1,20}$/.test(queryId)||reference!==undefined&&!/^\d{1,40}$/.test(reference))throw new RecordsError('Flex凭据无效');
  const url=new URL(reference?'GetStatement':'SendRequest',FLEX_BASE);url.search=new URLSearchParams({t:token,q:reference||queryId,v:'3'}).toString();
  let response:Response;
  try{response=await fetch(url,{headers:{'User-Agent':'Alcor/1.0'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(20000)});}catch{throw new RecordsError('IBKR暂时无法连接，请稍后重试',502);}
  if(!response.ok){await response.body?.cancel();throw new RecordsError('IBKR暂时无法返回报表',502);}
  const xml=new TextDecoder('utf-8',{fatal:true}).decode(await readLimitedResponseBytes(response,FLEX_MAX_BYTES));const root=flexXml(xml);
  if(root.name==='FlexQueryResponse')return {pending:false,xml};
  if(root.name!=='FlexStatementResponse')throw new RecordsError('IBKR返回格式无效',502);
  const value=(name:string)=>descendants(root,name)[0]?.text.trim();
  if(value('Status')==='Success'&&/^\d{1,40}$/.test(value('ReferenceCode')??''))return {pending:true,reference:value('ReferenceCode')!};
  const code=value('ErrorCode');if(reference&&['1003','1019'].includes(code??''))return {pending:true,reference};
  if(['1012','1015','1014'].includes(code??''))throw new RecordsError('IBKR Token已失效或权限不足，请重新配置',422);
  throw new RecordsError('IBKR暂时无法生成报表，请核对Flex查询配置',502);
}
