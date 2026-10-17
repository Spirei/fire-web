const assert = require('node:assert/strict');
const fs = require('node:fs'), Module = require('node:module'), ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const originalLoad=Module._load;
Module._load=function(id,parent,...rest){if(id==='./net' && parent.filename.endsWith('marketVolumeRanking.ts'))return {proxyFetch:(...args)=>global.fetch(...args)};return originalLoad.call(this,id,parent,...rest);};
const {parseVolumeRanking, parseScannerRanking, volumeRanking} = require('../lib/marketVolumeRanking.ts');
const now = Date.now();
const raw = () => ({data:{total:100, diff:Array.from({length:10},(_,i)=>({f12:'STOCK'+i,f14:'Test '+i,f5:1000-i,f124:Math.floor(now/1000)}))}});
assert.equal(parseVolumeRanking(raw(),'US',now).items.length,10);
for(const mutate of [r=>r.data.diff.pop(),r=>r.data.diff[1].f12='STOCK0',r=>r.data.diff[1].f5=1001,r=>r.data.diff[1].f5=NaN,r=>r.data.diff[1].f124-=86400,r=>r.data.diff[1].f124+=86400,r=>r.data.diff[1].f124-=11*86400]) {
 const r=raw();mutate(r);assert.throws(()=>parseVolumeRanking(r,'US',now));
}
const scanner = (exchange='NASDAQ') => ({totalCount:100,data:Array.from({length:10},(_,i)=>({s:exchange+':'+(exchange==='HKEX'?String(i+1):exchange==='SSE'?String(600000+i):'STOCK'+i),d:[exchange==='HKEX'?String(i+1):exchange==='SSE'?String(600000+i):'STOCK'+i,'Test '+i,1000-i,Math.floor(now/86400000)*86400,'stock',exchange]}))});
for(const market of ['US','HK','CN']) assert.equal(parseScannerRanking(scanner(market==='US'?'NASDAQ':market==='HK'?'HKEX':'SSE'),market,now).items.length,10);
assert.equal(parseScannerRanking(scanner('HKEX'),'HK',now).items[0].code,'00001');
for(const mutate of [r=>r.data.pop(),r=>r.data[1]=r.data[0],r=>r.data[1].d[2]=1001,r=>r.data[1].d[3]-=86400,r=>r.data[1].d[3]=null,r=>r.data[1].d[3]-=11*86400,r=>r.data[1].d[5]='OTC',r=>r.data[1].d[4]='fund',r=>r.data[1].s='NYSE:wrong']) { const r=scanner();mutate(r);assert.throws(()=>parseScannerRanking(r,'US',now)); }
let calls=0, unavailable=false;
global.fetch=async (url,init)=>{calls++;if(String(url).includes('scanner.tradingview.com')) {assert.equal(init.method,'POST');const body=JSON.parse(init.body);assert.deepEqual(body.sort,{sortBy:'volume',sortOrder:'desc'});assert(body.columns.includes('daily-bar.time'));if(unavailable)throw Error('scanner down');return new Response(JSON.stringify(scanner()));}assert.equal(new URL(url).searchParams.get('fid'),'f5');return new Response(JSON.stringify(raw()));};
const load=Module._load;let remote=0;
Module._load=function(id,parent,...rest){
 if(id==='./net' && parent.filename.endsWith('marketVolumeRanking.ts'))return {proxyFetch:(...args)=>global.fetch(...args)};
 if(id==='@/lib/assets')return {getAssetsPage:({query})=>({assets:query==='英伟达'?[{code:'NVDA',market:'US',name:'英伟达'}]:[]}), getStockAssetsByCodes:()=>[{code:'NVDA',name:'英伟达'}]};
 if(id==='@/lib/relatedEtfs')return require('../lib/relatedEtfs.ts');
 if(id==='@/lib/stockSearchCatalog')return require('../lib/stockSearchCatalog.ts');
 if(id==='@/lib/quotes')return {searchStocks:async()=>{remote++;return[];}};
 if(id==='@/lib/rateLimit')return {clientIp:()=>'',rateLimit:()=>true,rateLimitGlobal:()=>true};
 if(id==='@/lib/api')return {ok:data=>data,fail:()=>{throw Error('unexpected fail');}};
 return load.call(this,id,parent,...rest);
};
(async()=>{
 const [a,b]=await Promise.all([volumeRanking('US'),volumeRanking('US')]);assert.equal(a,b);assert.equal(calls,1);await volumeRanking('US');assert.equal(calls,1);
 unavailable=true;const fallback=await volumeRanking('HK');assert.equal(fallback.items.length,10);assert.equal(fallback.market,'HK');assert.equal(calls,3);
 assert(fs.readFileSync(require.resolve('../lib/appConfiguration.ts'),'utf8').includes('path: `${base}/market-ranking`'));
 assert(fs.readFileSync(require.resolve('../app/api/v1/market-ranking/route.ts'),'utf8').includes('export { GET }'));
 const {GET}=require('../app/api/v1/search/route.ts');
 for(const q of ['NVDL','英伟达']){const r=await GET(new Request('https://fixture.test/?q='+encodeURIComponent(q)));assert(r.results.some(x=>x.code==='NVDL'));if(q==='英伟达')assert.deepEqual(r.results.map(x=>x.code),['NVDA','NVDL','NVD','NVDX','NVDU','NVDQ','NVDY','NVDS']);assert.equal(remote,0);}
 await GET(new Request('https://fixture.test/?q=unknown'));assert.equal(remote,1);
 console.log('PASS: validated volume order/date/identity, shared cache/in-flight, native catalog fast path and remote fallback');
})().catch(e=>{console.error(e);process.exitCode=1;});
