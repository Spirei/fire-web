// Real App handlers/SQLite; disposable accounts, no real mail or external data.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-assets-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://assets.example.test';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),app=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/store.ts'),orders=load('lib/orders.ts'),funds=load('lib/funds.ts'),assets=load('lib/appAssets.ts'),bodies=load('lib/requestBody.ts');
let rates={USD:1,HKD:7,CNY:7},quotes={},onRates=null,onQuotes=null,index=0,count=0;
load('lib/rates.ts').getRates=async()=>{if(onRates)await onRates();return rates;};
load('lib/quotes.ts').fetchOverviewQuotes=async items=>{if(onQuotes)await onQuotes(items);return{quotes,pending:false,cached:[]};};
function fixture(scope='portfolio.read portfolio.write'){
 const user=auth.createUser('asset_owner_'+(++index),'Asset-test-123'),cookie=auth.createSession(user.id),verifier=crypto.randomBytes(32).toString('base64url');
 const args={client_id:app.APP_CLIENT_ID,redirect_uri:app.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
 const code=app.issueAppCode(app.parseAppAuthorization(args),user.id,cookie),grant=app.exchangeAppCode({...args,code,code_verifier:verifier});
 return{user,cookie,grant};
}
const record=(f,over={})=>store.createRecord(f.user.id,{name:'Synthetic',code:'TEST',market:'US',qty:2,cost:5,price:10,group:'Broker',note:'',source:'',...over});
const origin=process.env.FIRE_APP_ORIGIN;
function request(v,f,tail='',method='GET',body,headers={}){return new Request(origin+`/api/v${v}/account-assets`+tail,{method,headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function call(v,f,tail='',method='GET',body,headers={}){
 const isInst=tail.startsWith('/instruments/'),isOp=tail.startsWith('/operations/'),file=isInst?'account-assets/instruments/[recordId]':isOp?'account-assets/operations/[requestId]':'account-assets';
 const params=Promise.resolve(isInst?{recordId:tail.split('/')[2]}:{requestId:tail.split('/')[2]});
 const r=await load(`app/api/v${v}/${file}/route.ts`)[method](request(v,f,tail,method,body,headers),{params});return{status:r.status,data:await r.json(),headers:r.headers};
}
const declare=(f,r,over={})=>({requestId:crypto.randomUUID(),recordRevision:store.readRecord(f.user.id,r.id).revision,revision:assets.instrumentSnapshot(f.user.id,r.id).instrument.revision,kind:'cash_equity',listingStatus:'unknown',...over});
async function classify(f,r,over={}){const result=await call(1,f,'/instruments/'+r.id,'PUT',declare(f,r,over));assert.equal(result.status,200);return result;}
const snapshot=()=>Object.fromEntries(['records','trade_orders','fund_transactions','app_asset_instruments','app_asset_operations','record_collections'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));
async function test(name,run){rates={USD:1,HKD:7,CNY:7};quotes={};onRates=onQuotes=null;db.prepare('DELETE FROM rate_limit').run();await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('anonymous discovery freezes selected-version paths/scopes and truthfully unavailable features',async()=>{
  for(const v of [1,2]){const r=await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(origin+`/api/v${v}/auth/config`)),d=(await r.json()).data,c=d.account_assets;assert.equal(c.version,1);for(const key of ['snapshot_path','instrument_path','operation_path'])assert(c[key].startsWith(`/api/v${v}/account-assets`));assert.equal(c.features.derivatives,false);assert.equal(c.features.account_day_pnl,false);assert.equal(c.automatic_mutation_replay,false);assert.equal(d.scope,'portfolio.read portfolio.write');}
 });
 await test('unknown security units stay unavailable; real empty and cash are distinct from missing',async()=>{
  const f=fixture(),r=record(f);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});
  const s=(await call(1,f)).data.data;assert.equal(s.positions[0].instrument.kind,'unknown');assert.equal(s.positions[0].marketValue,null);assert.equal(s.summary.totalMarket,null);assert.equal(s.summary.totalAsset,null);assert.equal(s.summary.totalCash,100);assert.equal(s.summary.dayPnl,null);
  const e=fixture(),empty=(await call(2,e)).data.data;assert.equal(empty.summary.totalMarket,0);assert.equal(empty.summary.totalAsset,0);assert.equal(empty.todayOrders.count,0);assert.equal(empty.todayOrders.emptyReason,'no_recorded_orders_today');
 });
 await test('classified cash equities share canonical Web totals, uniform FX and post-addition rounding',async()=>{
  const f=fixture(),r=record(f);await classify(f,r);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});
  for(const v of [1,2]){const reply=await call(v,f),s=reply.data.data;assert.equal(reply.status,200);assert.match(reply.headers.get('cache-control'),/private/);assert.equal(s.summary.totalMarket,20);assert.equal(s.summary.holdingPnl,10);assert.equal(s.summary.totalCash,100);assert.equal(s.summary.totalAsset,120);assert.equal(s.positions[0].weightPct,100);assert.equal(s.markets[0].cash,null);assert.equal(s.profile.accountId,f.user.id);}
  const c=(await call(2,f,'?currency=CNY')).data.data;assert.equal(c.summary.totalAsset,840);assert.equal(c.positions[0].holdingPnl,70);assert.equal(c.positions[0].holdingPnlPct,100);
  store.updateRecord(r.id,f.user.id,{...r,price:.004,qty:1});const r2=record(f,{code:'SECOND',price:.004,qty:1});await classify(f,r2);const s=(await call(1,f)).data.data;assert.equal(s.summary.totalMarket,.01,'round after adding');
 });
 await test('declarations require explicit scope/CAS/owner and yield persistent one-time receipts',async()=>{
  const f=fixture(),r=record(f),other=fixture(),read=fixture('portfolio.read'),rr=record(read),payload=declare(f,r);
  for(const v of [1,2]){assert.equal((await call(v,other,'/instruments/'+r.id)).status,404);assert.equal((await call(v,read,'/instruments/'+rr.id,'PUT',declare(read,rr),{cookie:'fire_session='+f.cookie})).status,403);}
  const a=await call(1,f,'/instruments/'+r.id,'PUT',payload);assert.equal(a.data.data.state,'completed');assert.equal((await call(2,f,'/instruments/'+r.id,'PUT',payload)).data.code,40901);
  const receipt=await call(2,f,'/operations/'+payload.requestId);assert.deepEqual(receipt.data.data,a.data.data);assert.equal((await call(1,other,'/operations/'+payload.requestId)).status,404);
  const stale=declare(f,r,{revision:0});assert.equal((await call(1,f,'/instruments/'+r.id,'PUT',stale)).data.code,40902);assert.equal((await call(2,f,'/operations/'+stale.requestId)).data.data.state,'failed');
  for(const extra of [{kind:'option'},{kind:['etf']},{underlyingRecordId:r.id},{multiplier:100}])assert.equal((await call(1,f,'/instruments/'+r.id,'PUT',declare(f,r,extra))).status,400);
 });
 await test('both versions reject Cookie-only/foreign origins and never borrow another account',async()=>{
  const f=fixture(),foreign=fixture();record(foreign,{price:9999});
  for(const v of [1,2]){const handler=load(`app/api/v${v}/account-assets/route.ts`);const r=await handler.GET(new Request(origin+`/api/v${v}/account-assets`,{headers:{cookie:'fire_session='+f.cookie}}));assert.equal(r.status,401);assert.equal((await call(v,f,'','GET',undefined,{origin:'https://evil.example'})).status,403);const s=(await call(v,f)).data.data;assert.equal(s.positions.length,0);assert.equal(s.accountId,f.user.id);}
 });
 await test('live identity is checked after rates, quotes, params and mutation bodies yield',async()=>{
  for(const v of [1,2])for(const boundary of ['rates','quotes']){const f=fixture(),r=record(f);await classify(f,r);const revoke=()=>app.revokeAppGrant(f.grant.grant_id);if(boundary==='rates')onRates=revoke;else onQuotes=revoke;assert.equal((await call(v,f)).status,401);onRates=onQuotes=null;}
  const f=fixture(),r=record(f),original=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const b=await original(...args);app.revokeAppGrant(f.grant.grant_id);return b;};try{assert.equal((await call(1,f,'/instruments/'+r.id,'PUT',declare(f,r))).status,401);assert.equal(assets.instrumentSnapshot(f.user.id,r.id).instrument.revision,0);}finally{bodies.readJsonBody=original;}
 });
 await test('post-I/O record revisions discard stale quote; reidentified rows invalidate declarations',async()=>{
  const f=fixture(),r=record(f);await classify(f,r);quotes={[r.id]:{price:100,time:'2026-10-05T00:00:00Z',session:'REGULAR'}};onQuotes=()=>db.prepare('UPDATE records SET price=12 WHERE id=?').run(r.id);
  let s=(await call(1,f)).data.data;assert.equal(s.positions[0].price,12);assert.equal(s.positions[0].priceSource,'record');
  onQuotes=()=>db.prepare("UPDATE records SET code='CHANGED' WHERE id=?").run(r.id);s=(await call(1,f)).data.data;assert.equal(s.positions[0].instrument.kind,'unknown');assert.equal(s.summary.totalMarket,null);assert.equal(s.positions[0].instrument.identityMatches,false);
  db.prepare('UPDATE records SET code=? WHERE id=?').run(r.code,r.id);onQuotes=null;s=(await call(2,f)).data.data;assert.equal(s.positions[0].instrument.kind,'unknown');assert.equal(s.positions[0].instrument.identityMatches,false,'ABA identity cannot revive a past declaration');
 });
 await test('filled/pending/cancelled daily orders are real/read-only and use per-market local dates',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});await classify(f,r);const o=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:2,price:10,fees:1}).order;
  db.prepare("UPDATE trade_orders SET status='pending' WHERE id=?").run(o.id);const before=snapshot(),s=(await call(1,f)).data.data;assert.deepEqual(snapshot(),before);assert.equal(s.todayOrders.count,1);assert.equal(s.todayOrders.items[0].status,'pending');assert.equal(s.todayOrders.settlesPendingOrders,false);
  assert.equal(assets.assetLocalDate('2026-10-05T02:00:00Z','US'),'2026-10-04');assert.equal(assets.assetLocalDate('2026-10-05T02:00:00Z','HK'),'2026-10-05');assert.equal(assets.assetLocalDate('2026-11-02T04:30:00Z','US'),'2026-11-01');assert.equal(assets.assetLocalDate('bad','US'),null);assert.equal(assets.assetLocalDate(Date.now(),'OTHER'),null);
 });
 await test('average-open cost is a reconciled zero-opening fee-inclusive cycle, not old diluted basis',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});await classify(f,r);orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:10,price:10,fees:2});orders.executeOrder({userId:f.user.id,recordId:r.id,side:'sell',qty:4,price:15,fees:1});
  let s=(await call(1,f,'?costMethod=average_open')).data.data;assert.equal(s.positions[0].averageOpenCost,10.2);assert.equal(s.positions[0].averageCostComplete,true);assert.equal(s.positions[0].dilutedCost,7);assert.equal(s.summary.holdingPnl,-1.2);assert(s.positions[0].cycleStartedAt);
  db.prepare('UPDATE records SET cost=9 WHERE id=?').run(r.id);s=(await call(1,f,'?costMethod=average_open')).data.data;assert.equal(s.positions[0].averageOpenCost,null);assert.equal(s.summary.holdingPnl,null);
  const older=record(f,{code:'OLD'});await classify(f,older);orders.executeOrder({userId:f.user.id,recordId:older.id,side:'buy',qty:1,price:12,fees:0});s=(await call(1,f)).data.data;assert.equal(s.positions.find(p=>p.recordId===older.id).averageOpenCost,null);
 });
 await test('NULL historical opening snapshots cannot impersonate verified zero opening',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});await classify(f,r);const o=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:1,price:10,fees:0}).order;db.prepare('UPDATE trade_orders SET position_qty_before=NULL WHERE id=?').run(o.id);const s=(await call(1,f)).data.data;assert.equal(s.positions[0].averageOpenCost,null);
 });
 await test('today clear derives from true last sale; zero watchlist rows do not invent clear dates',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''}),watch=record(f,{code:'WATCH',qty:0,cost:''});await classify(f,r);orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:1,price:10,fees:0});const sell=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'sell',qty:1,price:12,fees:0}).order;
  const s=(await call(1,f)).data.data;assert.equal(s.positions.find(p=>p.recordId===r.id).clearedAt,sell.tradedAt);assert.equal(s.positions.find(p=>p.recordId===r.id).clearedToday,true);assert.equal(s.positions.find(p=>p.recordId===watch.id).clearedAt,null);assert.equal(s.summary.totalMarket,0);
 });
 await test('FX, unknown order units, regular-session gaps and declared delisting preserve nulls',async()=>{
  const f=fixture(),r=record(f,{market:'HK'});await classify(f,r,{listingStatus:'delisted'});delete rates.HKD;let s=(await call(1,f)).data.data;assert.equal(s.summary.totalAsset,null);assert(s.summary.unconvertedCurrencies.includes('HKD'));assert.equal(s.positions[0].instrument.listingStatus,'delisted');
  const u=record(f,{code:'UNCLASSIFIED',qty:0,cost:''});orders.executeOrder({userId:f.user.id,recordId:u.id,side:'buy',qty:1,price:10,fees:0});s=(await call(2,f)).data.data;assert.equal(s.summary.totalCash,null);
  const g=fixture(),us=record(g);await classify(g,us);quotes={[us.id]:{price:20,time:'actual',session:'PRE'}};s=(await call(1,g,'?usPrice=regular')).data.data;assert.equal(s.positions[0].price,null);assert.equal(s.summary.totalMarket,null);
 });
 await test('opaque snapshot revision changes for real account inputs, not observation timestamp',async()=>{
  const f=fixture(),r=record(f);await classify(f,r);const first=(await call(1,f)).data.data;const second=(await call(2,f)).data.data;assert.equal(first.snapshotRevision,second.snapshotRevision);assert.match(first.snapshotRevision,/^[a-f0-9]{64}$/);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:1,direction:1});assert.notEqual((await call(1,f)).data.data.snapshotRevision,first.snapshotRevision);
 });
 await test('complete discovery fixture exactly matches the frozen JSON contract',async()=>{
  const blocks=[...fs.readFileSync(path.join(root,'docs/native-account-assets-contract.md'),'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)];
  const frozen=JSON.parse(blocks[blocks.length-1][1]);assert.deepEqual(load('lib/appAssetsConfig.ts').assetsDiscovery(2),frozen);
 });
 await test('original market amounts and account-wide weights never use the display currency label',async()=>{
  const f=fixture(),us=record(f),hk=record(f,{code:'HKFIX',market:'HK',qty:7,price:10,cost:5});await classify(f,us);await classify(f,hk,{kind:'etf'});
  const s=(await call(2,f)).data.data,m=s.markets.find(m=>m.market==='HK'),p=s.positions.find(p=>p.recordId===hk.id);
  assert.equal(m.currency,'HKD');assert.equal(m.valuationCurrency,'USD');assert.equal(m.nativeMarketValue,70);assert.equal(m.marketValue,10);assert.equal(p.nativeHoldingPnl,35);assert.equal(p.weightPct,33.33);
  delete rates.HKD;const missing=(await call(2,f)).data.data;assert.equal(missing.markets.find(m=>m.market==='HK').nativeMarketValue,70);assert(missing.positions.every(p=>p.weightPct===null));
 });
 await test('parameter awaits revalidate access and new declarations race through one CAS winner',async()=>{
  const f=fixture(),r=record(f),params=Promise.resolve().then(()=>{app.revokeAppGrant(f.grant.grant_id);return{recordId:r.id};});
  const reply=await load('app/api/v1/account-assets/instruments/[recordId]/route.ts').GET(request(1,f,'/instruments/'+r.id),{params});assert.equal(reply.status,401);
  const g=fixture(),rr=record(g);const replies=await Promise.all([1,2].map(v=>call(v,g,'/instruments/'+rr.id,'PUT',declare(g,rr))));assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 });
 await test('missing FX preserves trustworthy native cash including equity reconciliation',async()=>{
  const f=fixture(),r=record(f,{market:'HK',qty:7,price:100});await classify(f,r);
  const simple=load('lib/simpleStore.ts');simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,invest:[{market:'HK',cur:'HKD',amount:1400}]});
  delete rates.HKD;
  for(const v of [1,2]){const s=(await call(v,f)).data.data;assert.equal(s.cash.sourceComplete,true);assert.equal(s.cash.nativeBalancesByCurrency.HKD,700);assert.equal(s.cash.complete,false);assert.equal(s.cash.balancesByCurrency,null);assert.equal(s.summary.totalCash,null);assert.equal(s.positions[0].valuationUnavailableReason,'missing_exchange_rate');}
 });
 await test('unclassified transaction units never become available native cash',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:1,price:10,fees:0});
  const s=(await call(2,f)).data.data;assert.equal(s.cash.sourceComplete,false);assert.equal(s.cash.nativeBalancesByCurrency,null);assert.equal(s.positions[0].valuationUnavailableReason,'instrument_unclassified');
 });
 await test('a verified fresh zero-opening cycle recovers from an incomplete older closed cycle',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});await classify(f,r);
  const old=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:2,price:10,fees:0,tradedAt:'2026-10-01T13:30:00Z'}).order;
  orders.executeOrder({userId:f.user.id,recordId:r.id,side:'sell',qty:2,price:12,fees:0,tradedAt:'2026-10-02T13:30:00Z'});
  orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:3,price:20,fees:3,tradedAt:'2026-10-03T13:30:00Z'});
  db.prepare('UPDATE trade_orders SET position_qty_before=NULL WHERE id=?').run(old.id);
  for(const v of [1,2]){const s=(await call(v,f,'?costMethod=average_open')).data.data;assert.equal(s.positions[0].averageOpenCost,21);assert.equal(s.positions[0].averageCostComplete,true);assert.equal(s.positions[0].cycleStartedAt,'2026-10-03T13:30:00.000Z');}
  db.prepare("UPDATE trade_orders SET position_qty_before=NULL WHERE traded_at='2026-10-03T13:30:00.000Z' AND user_id=?").run(f.user.id);
  assert.equal((await call(1,f,'?costMethod=average_open')).data.data.positions[0].averageOpenCost,null);
 });
 await test('invalid historical dates remain unassigned and cannot invent a clearing date',async()=>{
  const f=fixture(),r=record(f,{qty:0,cost:''});await classify(f,r);
  orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:1,price:10,fees:0});
  const sold=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'sell',qty:1,price:12,fees:0}).order;
  db.prepare("UPDATE trade_orders SET traded_at='invalid' WHERE id=?").run(sold.id);
  const s=(await call(2,f)).data.data;assert.equal(s.positions[0].clearedAt,null);assert.equal(s.positions[0].clearedToday,false);assert(s.todayOrders.unknownDateOrderIds.includes(sold.id));
  assert.equal(assets.assetLocalDate(Date.now(),'constructor'),null);
 });
 if(process.env.ALCOR_ASSET_FIXTURE_OUT){
  const f=fixture(),us=record(f,{qty:0,cost:'',code:'USFIX',name:'Fixture Equity'}),hk=record(f,{code:'HKFIX',market:'HK',qty:7,price:70,cost:60,name:'Fixture ETF'});
  await classify(f,us);await classify(f,hk,{kind:'etf'});funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:500,direction:1});
  orders.executeOrder({userId:f.user.id,recordId:us.id,side:'buy',qty:10,price:10,fees:2,tradedAt:'2026-10-05T13:30:00.000Z'});
  orders.executeOrder({userId:f.user.id,recordId:us.id,side:'sell',qty:4,price:15,fees:1,tradedAt:'2026-10-05T14:00:00.000Z'});
  const quote={[us.id]:{name:'Fixture Equity',price:12,change:2,changePct:20,open:10,high:12,low:10,prevClose:10,time:'2026-10-05T14:30:00.000Z',session:'REGULAR',source:'auto'},[hk.id]:{name:'Fixture ETF',price:70,change:0,changePct:0,open:70,high:70,low:70,prevClose:70,time:'2026-10-05T08:00:00.000Z',session:'REGULAR',source:'auto'}};
  const data=db.transaction(()=>assets.buildAssets(f.user.id,{username:'fixture_owner',nickname:'Fixture Account',uid:'1',avatar:''},rates,quote,{currency:'USD',costMethod:'diluted',usPrice:'observed'},Date.parse('2026-10-05T14:30:00.000Z')))();
  fs.writeFileSync(process.env.ALCOR_ASSET_FIXTURE_OUT,JSON.stringify({code:0,message:'ok',data},null,2)+'\n');
 }
 console.log(`${count} asset contract tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{db.close();fs.rmSync(temp,{recursive:true,force:true});}catch{}});
