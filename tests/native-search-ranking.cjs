const assert = require('node:assert/strict');
const fs = require('node:fs'), Module = require('node:module'), ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {parseVolumeRanking, volumeRanking} = require('../lib/marketVolumeRanking.ts');
const now = Date.now();
const raw = () => ({data:{total:100, diff:Array.from({length:10},(_,i)=>({f12:'STOCK'+i,f14:'Test '+i,f5:1000-i,f124:Math.floor(now/1000)}))}});
assert.equal(parseVolumeRanking(raw(),'US',now).items.length,10);
for(const mutate of [r=>r.data.diff.pop(),r=>r.data.diff[1].f12='STOCK0',r=>r.data.diff[1].f5=1001,r=>r.data.diff[1].f5=NaN,r=>r.data.diff[1].f124-=86400,r=>r.data.diff[1].f124+=86400,r=>r.data.diff[1].f124-=11*86400]) {
 const r=raw();mutate(r);assert.throws(()=>parseVolumeRanking(r,'US',now));
}
let calls=0;
global.fetch=async url=>{calls++;assert.equal(new URL(url).searchParams.get('fid'),'f5');return new Response(JSON.stringify(raw()));};
const load=Module._load;let remote=0;
Module._load=function(id,parent,...rest){
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
 const {GET}=require('../app/api/v1/search/route.ts');
 for(const q of ['NVDL','英伟达']){const r=await GET(new Request('https://fixture.test/?q='+encodeURIComponent(q)));assert(r.results.some(x=>x.code==='NVDL'));if(q==='英伟达')assert.deepEqual(r.results.map(x=>x.code),['NVDA','NVDL','NVD','NVDX','NVDU','NVDQ','NVDY','NVDS']);assert.equal(remote,0);}
 await GET(new Request('https://fixture.test/?q=unknown'));assert.equal(remote,1);
 console.log('PASS: validated volume order/date/identity, shared cache/in-flight, native catalog fast path and remote fallback');
})().catch(e=>{console.error(e);process.exitCode=1;});
