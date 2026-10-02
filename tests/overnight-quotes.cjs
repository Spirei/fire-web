// Real adapters, fake SDK/network, no OpenD connection or application database.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),originalLoad=Module._load;
let settings={quoteSource:'auto',quoteApiUrl:'https://synthetic.test/'},yahoo={},proxyCalls=0,futuRows=new Map(),extendedCalls=0;
Module._load=function(id,parent,...rest){
 if(parent?.filename===path.join(root,'lib/futuQuotes.ts')&&id==='./settings')return {getSiteSettings:()=>settings,normalizeFutuHost:x=>x};
 if(parent?.filename===path.join(root,'lib/usExtendedQuote.ts')&&id==='./net')return {proxyFetch:async()=>{proxyCalls++;return Response.json({chart:{result:[yahoo]}});}};
 if(parent?.filename===path.join(root,'lib/quotes.ts')){
  if(id==='./settings')return {getSiteSettings:()=>settings};
  if(id==='./futuQuotes')return {fetchFutuQuotes:async items=>new Map(items.filter(i=>futuRows.has(i.code)).map(i=>[i.id,futuRows.get(i.code)])),searchFutu:async()=>[]};
  if(id==='./usExtendedQuote')return {fetchUsRegularQuote:async()=>null,fetchUsExtendedQuote:async()=>{extendedCalls++;return null;}};
  if(id==='./assetQuotes')return {getCryptoQuote:async()=>null};
  if(id==='./net')return {proxyFetch:async()=>{throw Error('No external network');}};
 }
 return originalLoad.call(this,id,parent,...rest);
};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const load=file=>require(path.join(root,file)),clock=load('lib/marketSessions.ts'),context=load('lib/futuQuotes.ts').futuQuoteSessionContext,extended=load('lib/usExtendedQuote.ts'),quotes=load('lib/quotes.ts');
const RealDate=Date;let now=RealDate.parse('2026-10-02T03:40:00Z');
global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
global.fetch=async()=>{throw Error('No external network or application service');};
const python=`import sys,json,io,types,runpy\np=json.load(sys.stdin)\nfor row in p['testRows']:\n for key,value in row.pop('_nonFinite',{}).items(): row[key]=float(value)\nclass Frame:\n def iterrows(self): return enumerate(p['testRows'])\nclass Context:\n def __init__(self,**kwargs): pass\n def get_market_snapshot(self,symbols):\n  if 'US.BAD' in symbols: return -1,'Unsupported US.BAD'\n  return 0,Frame()\n def close(self): pass\nsys.modules['futu']=types.SimpleNamespace(OpenQuoteContext=Context,RET_OK=0)\nsys.stdin=io.StringIO(json.dumps(p))\nrunpy.run_path(sys.argv[1],run_name='__main__')`;
function bridge(row,ctx=context('US',new RealDate(now)),extra=[]){
 const payload={cmd:'quotes',items:[{id:'a',market:'US',code:'AAPL',...ctx},...extra],testRows:[{code:'US.AAPL',name:'AAPL',last_price:100,prev_close_price:90,update_time:'2026-10-01 23:36:54.780',volume:0,turnover:0,overnight_price:101,overnight_change_val:1,...row}]};
 const r=spawnSync('python3',['-c',python,path.join(root,'scripts/futu_quotes.py')],{input:JSON.stringify(payload),encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);assert.equal(result.ok,true);return result;
}
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('US Sunday open and Friday/Saturday closure keep the 20:00 settlement boundary',()=>{
  for(const [utc,session,settled] of [['2026-09-28T00:00:00Z','overnight',false],['2026-09-28T07:59:00Z','overnight',false],['2026-09-28T08:00:00Z','pre',false],['2026-09-26T00:00:00Z','closed',true],['2026-09-27T23:59:00Z','closed',true]]){
   const d=new RealDate(utc),s=clock.marketSessionState('US',d);assert.equal(s.session,session,utc);assert.equal(s.pnlSettled,settled,utc);
  }
  assert.equal(clock.marketBoardLabel('US',new RealDate('2026-09-28T00:00:00Z')),'夜盘交易');
  assert.equal(context('US',new RealDate('2026-09-26T00:00:00Z')).session,'REGULAR');
 });
 await test('overnight windows cross midnight, year boundaries and daylight saving without local-host dates',()=>{
  for(const [utc,start,end] of [['2026-10-02T03:40:00Z','2026-10-01 20:00:00','2026-10-02 04:00:00'],['2026-10-02T04:01:00Z','2026-10-01 20:00:00','2026-10-02 04:00:00'],['2027-01-01T06:00:00Z','2026-12-31 20:00:00','2027-01-01 04:00:00'],['2026-11-02T01:00:00Z','2026-11-01 20:00:00','2026-11-02 04:00:00']]){
   assert.deepEqual(context('US',new RealDate(utc)),{session:'OVERNIGHT',sessionStart:start,sessionEnd:end});
  }
 });
 await test('Futu preserves milliseconds and uses the official overnight change baseline',()=>{
  const q=bridge({}).quotes.a;assert.equal(q.session,'OVERNIGHT');assert.equal(q.price,101);assert.equal(q.prevClose,100);assert.equal(q.change,1);assert.equal(q.changePct,1);assert.equal(q.time,'2026-10-01 23:36:54.780');
  assert.equal(bridge({},context('US',new RealDate('2026-10-02T04:01:00Z'))).quotes.a.session,'OVERNIGHT');
  const unchanged=bridge({overnight_price:100,overnight_change_val:0}).quotes.a;assert.equal(unchanged.session,'OVERNIGHT');assert.equal(unchanged.change,0);assert.equal(unchanged.prevClose,100);
 });
 await test('old, malformed or out-of-cycle prints and missing overnight fields retain an honest regular fallback',()=>{
  for(const row of [{update_time:'2026-09-30 23:55:00.123'},{update_time:'2026-10-01 19:59:59'},{update_time:'2026-10-02 04:00:00'},{update_time:'bad-time'},{overnight_price:null},{overnight_change_val:null},{overnight_change_val:200}]){
   const q=bridge(row).quotes.a;assert.equal(q.session,'REGULAR');assert.equal(q.price,100);assert.equal(q.prevClose,90);assert.equal(q.time,row.update_time||'2026-10-01 23:36:54.780');
  }
 });
 await test('Futu invalid numbers cannot contaminate the batch and time fractions remain verbatim',()=>{
  for(const field of ['overnight_price','overnight_change_val'])for(const number of ['inf','-inf','nan']){
   const q=bridge({_nonFinite:{[field]:number}}).quotes.a;assert.equal(q.session,'REGULAR');assert.equal(q.price,100);
  }
  const q=bridge({_nonFinite:{pe_ratio:'inf',turnover_rate:'nan'}}).quotes.a;assert.equal(q.session,'OVERNIGHT');assert.equal(q.pe,null);assert.equal(q.turnover,null);
  for(const fraction of ['1','123456789']){const time='2026-10-01 23:36:54.'+fraction;assert.equal(bridge({update_time:time}).quotes.a.time,time);}
  assert.equal(bridge({},{session:'OVERNIGHT'}).quotes.a.session,'REGULAR');
  assert.equal(bridge({update_time:'2026-02-30 23:36:54'}).quotes.a.session,'REGULAR');
 });
 await test('unsupported symbols do not break good overnight prices and aliases keep caller IDs',()=>{
  const r=bridge({},undefined,[{id:'alias',market:'US',code:'AAPL',...context('US')},{id:'bad',market:'US',code:'BAD',...context('US')}]);assert.equal(r.quotes.a.session,'OVERNIGHT');assert.deepEqual(r.quotes.alias,r.quotes.a);assert.equal(r.quotes.bad,undefined);assert.equal(r.skipped[0].symbol,'US.BAD');
 });
 await test('valid unchanged Futu overnight quotes survive ghost cleanup and are not overwritten by Yahoo',async()=>{
  futuRows=new Map([['AAPL',{name:'AAPL',price:100,change:0,changePct:0,prevClose:100,time:'2026-10-01 23:36:54.780',session:'OVERNIGHT',volume:0,amount:0}]]);
  const r=await quotes.fetchQuotes([{id:'web',market:'US',code:'AAPL'},{id:'app',market:'US',code:'AAPL.OQ'}]);assert.equal(r.web.price,100);assert.equal(r.web.session,'OVERNIGHT');assert.equal(r.app.time,r.web.time);assert.equal(extendedCalls,0);
 });
 await test('missing overnight data keeps the holding price without relabeling or refreshing its timestamp',async()=>{
  futuRows=new Map([['MSFT',{name:'MSFT',price:100,change:2,changePct:2,prevClose:98,time:'2026-10-01 16:00:00',session:'REGULAR',volume:1}]]);
  const q=(await quotes.fetchQuotes([{id:'held',market:'US',code:'MSFT'}])).held;assert.equal(q.session,'REGULAR');assert.equal(q.time,'2026-10-01 16:00:00');assert.equal(q.price,100);
 });
 await test('Yahoo chart pre/post coverage cannot masquerade as overnight, including the final 20:00 bar',async()=>{
  const timestamp=RealDate.parse('2026-10-02T00:00:00Z')/1000;yahoo={timestamp:[timestamp],indicators:{quote:[{close:[101]}]},meta:{regularMarketPrice:100,previousClose:90}};
  const before=proxyCalls;assert.equal(await extended.fetchUsExtendedQuote('OVERNIGHT'),null);assert.equal(proxyCalls,before);
  now=RealDate.parse('2026-10-03T16:00:00Z');assert.equal(await extended.fetchUsExtendedQuote('WEEKEND'),null);
 });
 await test('Yahoo real pre-market and after-hours quotes keep their existing daily baselines',async()=>{
  now=RealDate.parse('2026-10-01T12:00:00Z');
  yahoo={timestamp:[now/1000],indicators:{quote:[{close:[101]}]},meta:{regularMarketPrice:100,previousClose:90}};
  const pre=await extended.fetchUsExtendedQuote('REALPRE');assert.equal(pre.session,'PRE');assert.equal(pre.previousClose,100);assert.equal(pre.change,1);assert.equal(pre.time,'08:00');
  now=RealDate.parse('2026-10-01T23:00:00Z');
  yahoo={timestamp:[now/1000],indicators:{quote:[{close:[102]}]},meta:{regularMarketPrice:100,previousClose:90}};
  const after=await extended.fetchUsExtendedQuote('REALAFTER');assert.equal(after.session,'AFTER');assert.equal(after.previousClose,90);assert.equal(after.change,12);assert.equal(after.time,'19:00');
 });
 await test('Yahoo regular quotes use the actual regular timestamp and never fabricate retrieval time',async()=>{
  const regular=RealDate.parse('2026-10-01T20:00:00Z')/1000,post=RealDate.parse('2026-10-02T00:00:00Z')/1000;
  yahoo={timestamp:[post],indicators:{quote:[{close:[101]}]},meta:{regularMarketPrice:100,regularMarketTime:regular,previousClose:90}};
  assert.equal((await extended.fetchUsRegularQuote('REGTIME')).time,'2026-10-01T20:00:00.000Z');
  const minute=RealDate.parse('2026-10-01T19:59:00Z')/1000;
  yahoo={timestamp:[minute,post],indicators:{quote:[{close:[99,101]}]},meta:{regularMarketPrice:100,previousClose:90}};
  const unpaired=await extended.fetchUsRegularQuote('UNPAIRED');assert.equal(unpaired.price,100);assert.equal(unpaired.time,'');
  yahoo={timestamp:[],indicators:{quote:[{close:[]}]},meta:{regularMarketPrice:100,previousClose:90}};
  assert.equal((await extended.fetchUsRegularQuote('NOTIME')).time,'');
 });
 console.log(`${count} overnight quote suites passed (fake SDK/network only)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.Date=RealDate;});
