const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-calendar-')),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://calendar.example.test';global.fetch=async()=>{throw Error('Network disabled');};
const load=file=>require(path.join(root,file)),{buildMarketCalendar,marketCalendarDiscovery}=load('lib/marketCalendar.ts'),route=load('app/api/v2/market-calendar/route.ts');
const batch=load('app/api/v2/market-calendar/batch/route.ts');
const batchReq=(query='year=2026',headers={})=>new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/market-calendar/batch?'+query,{headers});
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
const req=(query='market=US&year=2026',headers={})=>new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/market-calendar?'+query,{headers});
const day=(market,date)=>buildMarketCalendar(market,2026).days.find(day=>day.date===date);
(async()=>{
 await test('official annual counts, full date coverage and source identities',()=>{
  for(const [market,expected,half,exchanges] of [['CN',242,0,['SSE','SZSE']],['HK',247,3,['SEHK']],['US',251,2,['NYSE','NASDAQ']]]){
   const c=buildMarketCalendar(market,2026);assert.equal(c.days.length,365);assert.equal(new Set(c.days.map(d=>d.date)).size,365);assert.equal(c.days[0].date,'2026-01-01');assert.equal(c.days.at(-1).date,'2026-12-31');assert.equal(c.days.filter(d=>d.isTradingDay).length,expected);assert.equal(c.days.filter(d=>d.status==='half_day').length,half);assert.deepEqual(c.coverage.exchanges,exchanges);assert.equal(c.coverage.temporaryClosures,'unknown');assert(c.sources.every(s=>s.url.startsWith('https://')&&s.verifiedAt));assert(c.days.every(d=>d.actualTradingStatus==='unknown'&&d.sourceIds.every(id=>c.sources.some(s=>s.id===id))));
  }
 });
 await test('exchange closures differ from civil workdays and July 2 stays regular',()=>{
  for(const date of ['2026-02-14','2026-02-28','2026-05-09','2026-10-10','2026-01-04','2026-09-20'])assert.equal(day('CN',date).status,'weekend');
  assert.equal(day('CN','2026-02-23').status,'holiday');assert.equal(day('CN','2026-10-07').status,'holiday');assert.equal(day('CN','2026-10-08').status,'trading');assert.equal(day('US','2026-07-02').status,'trading');assert.equal(day('US','2026-07-03').status,'holiday');assert.equal(day('HK','2026-04-07').status,'holiday');assert.equal(day('HK','2026-10-19').status,'holiday');
 });
 await test('half days preserve local times and HK CAS scope',()=>{
  for(const date of ['2026-11-27','2026-12-24'])assert.deepEqual(day('US',date).close,{continuous:'13:00',auction:null});
  for(const date of ['2026-02-16','2026-12-24','2026-12-31']){const d=day('HK',date);assert.equal(d.status,'half_day');assert.equal(d.isTradingDay,true);assert.deepEqual(d.close,{continuous:'12:00',auction:{earliest:'12:08',latest:'12:10',appliesTo:'CAS_securities'}});}
  assert.equal(buildMarketCalendar('US',2026).timeZone,'America/New_York');
 });
 await test('unknown years and uncertain dates never silently imply trading',()=>{
  for(const [year,length] of [[2024,366],[2027,365],[2100,365]]){const c=buildMarketCalendar('US',year);assert.equal(c.days.length,length);assert.equal(c.coverage.status,'unknown');assert.equal(c.coverage.verifiedAt,null);assert.deepEqual(c.sources,[]);assert(c.days.every(d=>d.status==='unknown'&&d.isTradingDay===null&&d.close===null&&d.sourceIds.length===0));}
  const c=buildMarketCalendar('US',2026,{'2026-12-24':'待核实临时安排'}),d=c.days.find(d=>d.date==='2026-12-24');assert.equal(d.status,'unknown');assert.equal(d.isTradingDay,null);assert.equal(d.close,null);assert.equal(d.reason,'temporary_uncertainty');
  for(const year of [1999,2101,NaN,2026.5])assert.throws(()=>buildMarketCalendar('US',year),RangeError);
 });
 await test('anonymous v2 response, revision cache and conditional validation',async()=>{
  const response=await route.GET(req());assert.equal(response.status,200);assert.equal(response.headers.get('x-alcor-api-version'),'2');assert.equal(response.headers.get('vary'),'Origin, Authorization');assert.match(response.headers.get('cache-control'),/max-age=300/);const body=await response.json();assert.equal(body.code,0);assert.equal(body.data.market,'US');assert.equal(body.data.schemaVersion,1);
  const etag=response.headers.get('etag'),cached=await route.GET(req(undefined,{'if-none-match':'W/'+etag}));assert.equal(cached.status,304);assert.equal(await cached.text(),'');assert.equal(cached.headers.get('etag'),etag);assert.equal(cached.headers.get('x-alcor-api-version'),'2');
  const different=await route.GET(req('market=HK&year=2026',{'if-none-match':etag}));assert.equal(different.status,200);assert.notEqual(different.headers.get('etag'),etag);
  assert.equal((await (await route.GET(req('market=CN&year=2027'))).json()).data.coverage.status,'unknown');
 });
 await test('each market API contains only its own schedule and local half-day time',async()=>{
  const responses={};
  for(const market of ['US','HK','CN']){const result=await route.GET(req(`market=${market}&year=2026`));assert.equal(result.status,200);const data=(await result.json()).data;assert.equal(data.market,market);assert.deepEqual(data,buildMarketCalendar(market,2026));responses[market]=data;}
  const on=(market,date)=>responses[market].days.find(day=>day.date===date);
  assert.equal(on('US','2026-10-01').status,'trading');assert.equal(on('HK','2026-10-01').status,'holiday');assert.equal(on('CN','2026-10-01').status,'holiday');
  assert.equal(on('US','2026-12-24').close.continuous,'13:00');assert.equal(on('HK','2026-12-24').close.continuous,'12:00');assert.equal(on('CN','2026-12-24').status,'trading');
  assert.equal((await route.GET(req('market=US,HK,CN&year=2026'))).status,400);
 });
 await test('strict query and authorization boundary reject before cached response',async()=>{
  for(const query of ['', 'market=us&year=2026','market=ALL&year=2026','market=US&year=26','market=US&year=1999','market=US&year=2101','market=US&year=2026&year=2027','market=US&market=CN&year=2026']){const res=await route.GET(req(query));assert.equal(res.status,400,query);assert.equal((await res.json()).code,40001);assert.match(res.headers.get('cache-control'),/no-store/);}
  const bad=await route.GET(req(undefined,{authorization:'Bearer invalid','if-none-match':'*'}));assert.equal(bad.status,401);const foreign=await route.GET(req(undefined,{origin:'https://evil.test','if-none-match':'*'}));assert.equal(foreign.status,403);
 });
 await test('batch returns a versioned market map identical to all single-market responses',async()=>{
  const res=await batch.GET(batchReq());assert.equal(res.status,200);assert.equal(res.headers.get('x-alcor-api-version'),'2');const body=await res.json();assert.equal(body.code,0);assert.equal(body.data.year,2026);assert.equal(body.data.schemaVersion,1);assert.equal(body.data.calendarVersion,marketCalendarDiscovery().calendar_version);assert.deepEqual(Object.keys(body.data.calendars).sort(),['CN','HK','US']);
  for(const market of ['CN','HK','US']){const single=(await (await route.GET(req(`market=${market}&year=2026`))).json()).data;assert.deepEqual(body.data.calendars[market],single);}
  const unknown=(await (await batch.GET(batchReq('year=2027'))).json()).data;assert(Object.values(unknown.calendars).every(c=>c.coverage.status==='unknown'&&c.days.every(d=>d.isTradingDay===null)));
 });
 await test('batch cache is distinct from single/year caches and preserves conditional semantics',async()=>{
  const res=await batch.GET(batchReq()),etag=res.headers.get('etag');assert.match(res.headers.get('cache-control'),/max-age=300/);assert.equal(res.headers.get('vary'),'Origin, Authorization');
  const same=await batch.GET(batchReq(undefined,{'if-none-match':'"stale", W/'+etag}));assert.equal(same.status,304);assert.equal(await same.text(),'');assert.equal(same.headers.get('etag'),etag);assert.equal(same.headers.get('x-alcor-api-version'),'2');
  const single=await route.GET(req(undefined,{'if-none-match':etag}));assert.equal(single.status,200);assert.notEqual(single.headers.get('etag'),etag);
  const next=await batch.GET(batchReq('year=2027',{'if-none-match':etag}));assert.equal(next.status,200);assert.notEqual(next.headers.get('etag'),etag);
 });
 await test('batch rejects invalid inputs, invalid bearer and foreign origins before cache hits',async()=>{
  for(const query of ['', 'year=26','year=1999','year=2101','year=2026&year=2027','year=2026&market=US','year=2026&markets=US,HK']){const res=await batch.GET(batchReq(query,{'if-none-match':'*'}));assert.equal(res.status,400,query);assert.equal((await res.json()).code,40001);assert.match(res.headers.get('cache-control'),/no-store/);}
  assert.equal((await batch.GET(batchReq(undefined,{authorization:'Bearer invalid','if-none-match':'*'}))).status,401);
  assert.equal((await batch.GET(batchReq(undefined,{origin:'https://evil.test','if-none-match':'*'}))).status,403);
 });
 await test('both discovery versions point exclusively to public v2 calendar',async()=>{
  for(const version of [1,2]){const res=await load(`app/api/v${version}/auth/config/route.ts`).GET(new Request(process.env.FIRE_APP_ORIGIN+`/api/v${version}/auth/config`));const config=(await res.json()).data;assert.deepEqual(config.market_calendar,marketCalendarDiscovery());assert.equal(config.market_calendar.path,'/api/v2/market-calendar');assert.equal(config.market_calendar.access,'public');assert.equal(config.market_calendar.batch_path,'/api/v2/market-calendar/batch');}
  assert(!fs.existsSync(path.join(root,'app/api/v1/market-calendar/route.ts')));
 });
 console.log(`PASS ${count} market calendar suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{load('lib/db.ts').getDb().close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
