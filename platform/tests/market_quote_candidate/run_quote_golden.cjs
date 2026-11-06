// Actual old routes and gzip envelope, with controlled quote results only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const zlib=require('node:zlib'),util=require('node:util'),ts=require('typescript');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
let tracked=0,enriched=0;
function compile(name,dependencies,source){
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,Buffer,URL,Request,Response,require(name){if(!(name in dependencies))throw Error('Forbidden source dependency '+name);return dependencies[name];}});
  vm.runInContext(ts.transpileModule(source??fs.readFileSync(path.join(root,name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return module.exports;
}
const next={NextResponse:{json:Response.json.bind(Response)}};
const api=compile('lib/api.ts',{'next/server':next});
const code=compile('lib/marketCode.ts',{});
const store=fs.readFileSync(path.join(root,'lib/store.ts'),'utf8');
const begin=store.indexOf('export function parseMarket('),end=store.indexOf('\n}',begin)+2;
if(begin<0||end<2)throw Error('Original parseMarket changed');
const parser=compile('',{},store.slice(begin,end));
const response=compile('lib/marketResponse.ts',{'node:zlib':zlib,'node:util':util});
const dependencies={
  '@/lib/requestBody':{readJsonBody:async r=>r.json()},'next/server':next,
  '@/lib/quotes':{fetchQuotes:async items=>Object.fromEntries(items.flatMap(item=>{const value=input.quotesBySymbol[item.market+':'+code.normalizeMarketCode(item.market,item.code)];return value?[[item.id,value]]:[];}))},
  '@/lib/quoteSubscriptionRequests':{trackQuoteRequest:async()=>{tracked++;return false;}},
  '@/lib/etfMarketCap':{fillEtfMarketCaps:async()=>{enriched++;}},'@/lib/store':parser,
  '@/lib/rateLimit':{clientIp:()=> 'fixture',rateLimit:()=>true,rateLimitGlobal:()=>true},
  '@/lib/api':api,'@/lib/marketResponse':response,
};
const web=compile('app/api/quotes/route.ts',dependencies),v1=compile('app/api/v1/quotes/route.ts',dependencies);
const policy=compile('lib/appApiV2Policy.ts',{});
const v2auth=compile('lib/appApiV2.ts',{'./appApiV2Policy':policy,'./api':api,'./appAuth':{assertAppOrigin:()=>{},authenticateAppAccess:()=>({client_id:'fire-ios',scope:'portfolio.read'})}});
const v2=compile('app/api/v2/quotes/route.ts',{'@/app/api/v1/quotes/route':v1,'@/lib/appApiV2':v2auth});
(async()=>{
  const output=[];
  for(const version of [0,1,2]){
    const request=new Request('http://fixture.invalid/api/'+(version?'v'+version+'/':'')+'quotes',{method:'POST',headers:{'content-type':'application/json','accept-encoding':input.acceptEncoding??'identity',authorization:'Bearer fat_'+'a'.repeat(43)},body:JSON.stringify(input.body)});
    const result=await [web,v1,v2][version].POST(request);
    let raw=Buffer.from(await result.arrayBuffer());
    if(result.headers.get('content-encoding')==='gzip')raw=zlib.gunzipSync(raw);
    output.push({version,status:result.status,body:JSON.parse(raw),encoding:result.headers.get('content-encoding')});
  }
  process.stdout.write(JSON.stringify({routes:output,oldTrackedCalls:tracked,oldEnrichmentCalls:enriched}));
})().catch(error=>{process.stderr.write(String(error.stack));process.exitCode=1;});
