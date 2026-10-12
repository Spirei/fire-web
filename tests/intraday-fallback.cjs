// Production adapters and shared pool, isolated upstream responses; no real OpenD or account database.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), originalLoad = Module._load, RealDate = Date;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-12T14:00:00Z'])); } };
let futu = async () => ({}), network = async () => { throw Error('offline'); }, calls = [], serial = 0, available = true;
let settings = { chartApiUrl: 'https://tencent.test/?code={code}', futuHost: 'localhost', futuPort: '11111' };
Module._load = function(id, parent, ...rest) {
 if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
  if (id === './settings') return { getSiteSettings: () => settings };
  if (id === './futuQuotes') return { isFutuAvailable: async () => available, fetchFutuQuotes: async () => new Map(), searchFutu: async () => [], fetchFutuIntraday: (...args) => { calls.push('futu'); return futu(...args); } };
  if (id === './usExtendedQuote') return { fetchUsExtendedQuote: async () => null, fetchUsRegularQuote: async () => null };
  if (id === './assetQuotes') return { getCryptoQuote: async () => null };
  if (id === './net') return { proxyFetch: (...args) => network(...args) };
 }
 return originalLoad.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
global.fetch = (...args) => network(...args);
const { fetchIntraday } = require('../lib/quotes.ts');
const points = [{time:'09:30',price:100,volume:1},{time:'09:31',price:101,volume:2}];
const chart = (source='futu', date='2026-10-12') => ({date, points:structuredClone(points),source});
const item = (id='review', market='US', code='AAPU') => ({id,market,code});
const run = async (name, test) => {
 settings = {...settings, chartApiUrl:`https://tencent.test/${++serial}?code={code}`}; calls=[];available=true;futu=async()=>({});network=async url=>{calls.push(new URL(url).hostname);throw Error('offline');};
 await test();console.log('PASS '+name);
};
(async()=>{
 await run('available Futu returns immediately without contacting another source', async()=>{
  futu=async items=>Object.fromEntries(items.map(i=>[i.id,chart()]));
  const started=performance.now(), result=await fetchIntraday([item()]);assert(performance.now()-started<500);assert.equal(result.review.source,'futu');assert.deepEqual(calls,['futu']);
 });
 await run('OpenD recovery switches to Futu despite a fresh Tencent fallback cache', async()=>{
  available=false;
  network=async url=>{const code=new URL(url).searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});};
  assert.equal((await fetchIntraday([item()])).review.source,'tencent');available=true;futu=async items=>Object.fromEntries(items.map(i=>[i.id,chart()]));
  assert.equal((await fetchIntraday([item()])).review.source,'futu');
 });
 await run('port stays available but usable Futu recovers after an earlier empty response', async()=>{
  available=true;
  network=async url=>{const code=new URL(url).searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});};
  assert.equal((await fetchIntraday([item()])).review.source,'tencent');futu=async items=>Object.fromEntries(items.map(i=>[i.id,chart()]));
  assert.equal((await fetchIntraday([item()])).review.source,'futu');
 });
 await run('Tencent follows unavailable Futu; IDs remain owned by callers', async()=>{
  network=async url=>{calls.push(new URL(url).hostname);assert.equal(new URL(url).hostname,'tencent.test');const code=new URL(url).searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});};
  const [a,b]=await Promise.all([fetchIntraday([item('web')]),fetchIntraday([item('app')])]);assert.equal(a.web.source,'tencent');assert.equal(b.app.source,'tencent');assert.equal(calls.filter(c=>c==='futu').length,1);
 });
 await run('Eastmoney precedes Yahoo and uses minute close rather than open', async()=>{
  network=async url=>{const u=new URL(url);calls.push(u.hostname);if(u.hostname==='tencent.test')throw Error('offline');assert.equal(u.hostname,'push2his.eastmoney.com');return Response.json({data:{code:'AAPU',trends:['2026-10-12 09:30,98,100,103,97,1,1,1','2026-10-12 09:31,99,101,104,98,2,2,2']}});};
  const data=(await fetchIntraday([item()])).review;assert.equal(data.source,'eastmoney');assert.equal(data.points[0].price,100);assert(!calls.some(c=>c.includes('yahoo')));
 });
 await run('Yahoo is last; query2 can succeed while query1 never responds', async()=>{
  network=async url=>{const u=new URL(url);calls.push(u.hostname);if(u.hostname==='query1.finance.yahoo.com')return new Promise(()=>{});if(u.hostname!=='query2.finance.yahoo.com')throw Error('offline');return Response.json({chart:{result:[{meta:{symbol:'AAPU',exchangeTimezoneName:'America/New_York'},timestamp:[1791811800,1791811860],indicators:{quote:[{close:[100,101],volume:[1,2]}]}}]}});};
  const data=(await fetchIntraday([item()])).review;assert.equal(data.source,'yahoo');assert(calls.indexOf('tencent.test')<calls.indexOf('push2his.eastmoney.com'));assert(calls.indexOf('push2his.eastmoney.com')<calls.indexOf('query1.finance.yahoo.com'));
 });
 await run('unsupported Futu/Eastmoney markets do not open those upstreams', async()=>{
  futu=async items=>{assert(items.every(i=>i.market==='JP'));return {};};
  network=async url=>{calls.push(new URL(url).hostname);if(new URL(url).hostname==='tencent.test'){const code=new URL(url).searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});}throw Error('unexpected');};
  const result=await fetchIntraday([item('jp','JP','7203')]);assert.equal(result.jp.source,'tencent');assert(!calls.includes('push2his.eastmoney.com'));
 });
 await run('old/future/invalid Futu data cannot stop a valid lower-priority source', async()=>{
  futu=async items=>Object.fromEntries(items.map((i,index)=>[i.id,index===0?chart('futu','2026-10-09'):index===1?chart('futu','2026-10-13'):{date:'2026-13-01',points}]));
  network=async url=>{const u=new URL(url);calls.push(u.hostname);assert.equal(u.hostname,'tencent.test');const code=u.searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});};
  const data=await fetchIntraday([item('old'),item('future','US','MSFT'),item('invalid','US','NVDA')]);assert(Object.values(data).every(v=>v.source==='tencent'&&!v.stale));
 });
 await run('slow source or body cannot hang fallback; abandoned Futu cannot replace Tencent', async()=>{
  let late;futu=()=>new Promise(resolve=>{late=resolve;});
  network=async url=>{const code=new URL(url).searchParams.get('code');return Response.json({data:{[code]:{data:{date:'20261012',data:['09:30 100 1','09:31 101 2']}}}});};
  const start=performance.now();const data=await fetchIntraday([item()]);assert(performance.now()-start<4300);assert.equal(data.review.source,'tencent');late({review:chart()});await new Promise(r=>setImmediate(r));assert.equal((await fetchIntraday([item()])).review.source,'tencent');
 });
 await run('every source ignoring abort still finishes below the App timeout and permits retry', async()=>{
  futu=()=>new Promise(()=>{});network=()=>new Promise(()=>{});const start=performance.now();await assert.rejects(fetchIntraday([item()]),/unavailable/);assert(performance.now()-start<12500);
  futu=async items=>Object.fromEntries(items.map(i=>[i.id,chart()]));assert.equal((await fetchIntraday([item()])).review.source,'futu');
 });
 await run('successful symbols release joined readers before another symbol finishes', async()=>{
  futu=async items=>({[items[0].id]:chart()});network=()=>new Promise(()=>{});const full=fetchIntraday([item('fast'),item('slow','US','MSFT')]);const start=performance.now();assert.equal((await fetchIntraday([item('joined')])).joined.source,'futu');assert(performance.now()-start<500);await full;
 });
 await run('a Yahoo response for another security cannot become the requested chart', async()=>{
  network=async url=>{const u=new URL(url);if(!u.hostname.includes('yahoo'))throw Error('offline');return Response.json({chart:{result:[{meta:{symbol:'MSFT',exchangeTimezoneName:'America/New_York'},timestamp:[1791811800,1791811860],indicators:{quote:[{close:[100,101],volume:[1,2]}]}}]}});};
  await assert.rejects(fetchIntraday([item()]),/unavailable/);
 });
 console.log('PASS 12 intraday fallback suites (synthetic upstream only)');
})().catch(error=>{console.error(error);process.exitCode=1;});
