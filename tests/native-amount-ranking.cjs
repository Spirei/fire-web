const assert = require('node:assert/strict'), fs = require('node:fs'), Module = require('node:module'), ts = require('typescript');
require.extensions['.ts'] = (m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const load=Module._load; let scanCalls=0, quoteCalls=0;
Module._load=function(id,parent,...rest){
 if(parent?.filename.endsWith('marketAmountRanking.ts')) {
  if(id==='./net')return {proxyFetch:async(url,init)=>{scanCalls++;const body=JSON.parse(init.body);assert(body.filter.some(x=>x.left==='currency'));assert.deepEqual(body.range,[0,20000]);return new Response(JSON.stringify(raw()));}};
  if(id==='./quotes')return {fetchBatch:async symbols=>{quoteCalls++;return read(symbols);}};
 }
 return load.call(this,id,parent,...rest);
};
const {parseAmountUniverse,rankObservedAmounts,amountRanking}=require('../lib/marketAmountRanking.ts');
const now=Date.now(),day=Math.floor(now/86400000)*86400,date=new Date(day*1000).toISOString().slice(0,10);
function raw(market='US') { const exchange=market==='US'?'NASDAQ':market==='HK'?'HKEX':'SSE',currency=market==='US'?'USD':market==='HK'?'HKD':'CNY';return {totalCount:19,data:Array.from({length:19},(_,i)=>{const code=market==='US'?(i===18?'HODO':'STOCK'+i):market==='HK'?String(i+1):String(600000+i);return {s:exchange+':'+code,d:[code,'Stock '+i,i===18?0.1:2000-i*70,1000000*(i===18?1000:1),day,'stock',exchange,currency]};})}; }
function read(symbols,market='US') { return new Map(symbols.map(symbol=>{const digits=symbol.match(/\d+$/)?.[0]||'18',i=Number(digits)-(market==='CN'?600000:market==='HK'?1:0),amount=i===18?60000000:(2000-i*70)*1000000*0.96;return [symbol,{name:'Stock '+i,price:100,changePct:1.5,time:date+' 16:00:02',amount:amount/(market==='CN'?10000:1)}];})); }
(async()=>{
 for(const market of ['US','HK','CN']) {
  const u=parseAmountUniverse(raw(market),market,now),r=await rankObservedAmounts(market,u,s=>read(s,market),now);
  assert.equal(r.metric,'amount');assert.equal(r.items.length,10);assert(r.items.every(x=>x.amount>1e9));assert(!r.items.some(x=>x.code==='HODO'));
  assert(r.items.every((x,i,a)=>!i||a[i-1].amount>=x.amount));
 }
 for(const mutate of [x=>x.data.pop(),x=>x.totalCount=20001,x=>x.data[0].d[7]='EUR',x=>x.data[1]=x.data[0],x=>x.data[0].d[2]=NaN,x=>x.data[0].d[4]=day+86400]) {const x=raw();mutate(x);assert.throws(()=>parseAmountUniverse(x,'US',now));}
 const u=parseAmountUniverse(raw(),'US',now);
 await assert.rejects(()=>rankObservedAmounts('US',u,async symbols=>{const q=read(symbols);q.delete('usSTOCK0');return q;},now),'Missing potential leader must never be silently omitted');
 await assert.rejects(()=>rankObservedAmounts('US',u,async symbols=>new Map([...read(symbols)].map(([key,q])=>[key,{...q,time:'2020-01-01 16:00:00'}])),now));
 let expanded=0;const r=await rankObservedAmounts('US',u,async symbols=>{expanded+=symbols.length;return new Map([...read(symbols)].map(([key,q])=>[key,{...q,amount:q.amount*0.75}]));},now);assert(expanded>12);assert.equal(r.items.length,10);
 const [a,b]=await Promise.all([amountRanking('US'),amountRanking('US')]);assert.equal(a,b);assert.equal(scanCalls,1);await amountRanking('US');assert.equal(scanCalls,1);assert(quoteCalls>0);
 console.log('PASS actual amounts, CNY units, complete-market bounds, high-volume penny-stock exclusion, missing/old quotes, expansion and independent shared cache');
})().catch(e=>{console.error(e);process.exitCode=1;});
