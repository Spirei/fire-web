// Account, source and App integration tests in a disposable SQLite database.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-allocation-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://allocation.example.test';global.fetch=async()=>{throw Error('Network disabled');};
const dir=path.join(temp,'public/uploads/cards');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({regions:[{label:'美国',banks:[{name:'Test Bank',cards:[{file:'debit.png',name:'Debit',type:'借记卡'},{file:'prepaid.png',name:'Prepaid',type:'预付卡'},{file:'credit.png',name:'Credit',type:'信用卡'}]}]}]}));
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),app=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/store.ts'),funds=load('lib/funds.ts'),cards=load('lib/cardAmounts.ts'),simple=load('lib/simpleStore.ts'),allocation=load('lib/assetAllocation.ts'),overlay=load('lib/assetAllocationStore.ts'),bodies=load('lib/requestBody.ts');
let rates={USD:1,HKD:7,CNY:7},quotes={},onRates=null,onQuotes=null,index=0,count=0;
load('lib/rates.ts').getRates=async()=>{if(onRates)await onRates();return rates;};load('lib/quotes.ts').fetchOverviewQuotes=async()=>{if(onQuotes)await onQuotes();return{quotes,pending:false,cached:[]};};
function fixture(scope='portfolio.read portfolio.write'){
 const user=auth.createUser('allocation_'+(++index),'Allocation-test-123'),cookie=auth.createSession(user.id),verifier=crypto.randomBytes(32).toString('base64url');
 const args={client_id:app.APP_CLIENT_ID,redirect_uri:app.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
 const code=app.issueAppCode(app.parseAppAuthorization(args),user.id,cookie),grant=app.exchangeAppCode({...args,code,code_verifier:verifier});return{user,cookie,grant};
}
const rec=(f,over={})=>store.createRecord(f.user.id,{name:'Synthetic',code:'TEST',market:'US',qty:2,cost:5,price:10,group:'Broker One',note:'',...over});
const input=(over={})=>({...(over.id?{}:{requestId:crypto.randomUUID()}),revision:0,name:'Savings',currency:'USD',amount:100,category:'cash',excluded:false,...over});
async function call(f,method='GET',body,version=1,extra={},tail=''){
 const url=process.env.FIRE_APP_ORIGIN+`/api/v${version}/asset-allocation`+tail,request=new Request(url,{method,headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const response=await load(`app/api/v${version}/asset-allocation${tail}/route.ts`)[method](request),parsed=response.status===304?null:await response.json();
 if(method==='GET'&&response.status===200)assert(load('lib/assetAllocationClient.ts').validAllocationSnapshot(parsed.data,'USD',f.user.id),'every real server fixture conforms to the Web/App snapshot contract');
 return{status:response.status,body:parsed,headers:response.headers};
}
const snap=f=>allocation.buildAssetAllocation(f.user.id,rates,quotes,'USD');
const business=()=>Object.fromEntries(['records','fund_transactions','trade_orders','card_amounts','card_holdings','card_details','custom_cards','user_settings'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));
async function test(name,fn){rates={USD:1,HKD:7,CNY:7};quotes={};onRates=onQuotes=null;await fn();count++;console.log('PASS '+name);}
(async()=>{
 await test('weak conditional snapshots are stable, currency/owner bound and reauthorize before 304',async()=>{
  const f=fixture(),g=fixture(),first=await call(f),tag=first.headers.get('etag');
  assert.match(tag,/^W\/"[a-f0-9]{64}"$/);assert.equal(first.body.data.snapshotRevision,tag.slice(3,-1));
  assert.equal(first.headers.get('cache-control'),'no-store, private');assert.match(first.headers.get('vary'),/Authorization.*Cookie.*X-Allocation-User/);
  assert.equal(allocation.allocationSnapshotRevision(first.body.data),allocation.allocationSnapshotRevision({...first.body.data,observedAt:'2030-01-01T00:00:00.000Z'}));
  assert.notEqual(first.body.data.snapshotRevision,allocation.allocationSnapshotRevision({...first.body.data,currency:'CNY'}));
  for(const v of[1,2])for(const condition of[tag,tag.slice(2),'"irrelevant", '+tag,'*']){
   const cached=await call(f,'GET',undefined,v,{'if-none-match':condition,'x-allocation-user':f.user.id});assert.equal(cached.status,304);assert.equal(cached.body,null);assert.equal(cached.headers.get('etag'),tag);assert(Number.isFinite(Date.parse(cached.headers.get('x-allocation-observed-at'))));
  }
  assert.equal((await call(g,'GET',undefined,2,{'if-none-match':tag})).status,200);
  assert.equal((await call(g,'GET',undefined,2,{'if-none-match':tag,'x-allocation-user':f.user.id})).status,409);
  await call(f,'POST',input());assert.equal((await call(f,'GET',undefined,1,{'if-none-match':tag})).status,200);
  onQuotes=()=>app.revokeAppGrant(f.grant.grant_id);assert.equal((await call(f,'GET',undefined,2,{'if-none-match':'*'})).status,401);
 });
 await test('cancelled reads stop at asynchronous boundaries and never return a conditional success',async()=>{
  const f=fixture(),controller=new AbortController();onQuotes=()=>controller.abort();
  const request=new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/asset-allocation',{signal:controller.signal,headers:{authorization:'Bearer '+f.grant.access_token,'if-none-match':'*'}});
  const response=await load('app/api/v2/asset-allocation/route.ts').GET(request);assert.equal(response.status,499);assert.equal((await response.json()).code,49901);
 });
 await test('multiple brokers/cards are separate sources and canonical portfolio cash is counted once',async()=>{
  const f=fixture();rec(f);rec(f,{code:'SECOND',group:'Broker Two',price:15});funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});
  for(const [key,amount,cur]of[['debit.png',7,'USD'],['prepaid.png',14,'HKD'],['credit.png',10000,'USD']]){cards.setCardHeld(f.user.id,key,true);cards.upsertCardAmount(f.user.id,{cardKey:key,amount,currency:cur});}
  const before=business(),s=snap(f);assert.equal(s.accounts.filter(a=>a.kind==='broker').length,2);assert.equal(s.accounts.filter(a=>a.kind==='bank').length,2);assert.deepEqual(s.bankSummary,{count:2,includedCount:2,value:9});assert.equal(s.summary.totalAsset,159);assert.equal(s.summary.portfolioTotalAsset,159);assert.equal(s.summary.difference,0);assert.equal(s.categories.find(c=>c.id==='cash').value,109);assert.deepEqual(business(),before);
 });
 await test('linked legacy equity needs explicit opening cash and price changes never reverse cash',async()=>{
  const f=fixture(),r=rec(f);simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,invest:[{id:'legacy',name:'Broker',market:'US',cur:'USD',amount:100}]});
  let s=snap(f);assert.equal(s.summary.totalAsset,null);assert.equal(s.summary.portfolioTotalAsset,null);assert(s.issues.some(i=>i.code==='source_unavailable'));assert.equal(s.accounts.find(a=>a.kind==='fund').amount,null);assert.equal(s.accounts.filter(a=>a.kind==='ledger').length,0);
  funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'opening',amount:80,direction:1});
  s=snap(f);assert.equal(s.summary.totalAsset,100);assert.equal(s.summary.portfolioTotalAsset,100);assert.equal(s.accounts.find(a=>a.kind==='fund').amount,80);
  quotes={[r.id]:{price:15,time:'2026-10-09T00:01:00Z'}};const before=business();s=snap(f);assert.equal(s.summary.totalAsset,110);assert.equal(s.summary.portfolioTotalAsset,110);assert.equal(s.accounts.find(a=>a.kind==='fund').amount,80);assert.deepEqual(business(),before);
 });
 await test('manual accounts persist, CAS rejects stale writes, empty and signed balances stay distinct',async()=>{
  const f=fixture(),body=input();const create=await call(f,'POST',body);assert.equal(create.status,200);const id=create.body.data.id;assert.equal((await call(f,'POST',body)).status,409);assert.equal(snap(f).accounts.length,1);
  const first=snap(f);assert.equal(first.summary.totalAsset,100);assert.equal(first.summary.difference,100);assert.equal(first.accounts[0].revision,1);
  assert.equal((await call(f,'PUT',input({id,revision:0,amount:900}))).status,409);assert.equal((await call(f,'PUT',input({id,revision:1,amount:-5}))).status,200);assert.equal(snap(f).summary.totalAsset,-5);
  assert.equal((await call(f,'DELETE',{id,revision:1})).status,409);assert.equal((await call(f,'DELETE',{id,revision:2})).status,200);assert.equal(snap(f).summary.totalAsset,0);
 });
 await test('broker total equity replaces its position value, unresolved cash overlap prevents a complete sum',async()=>{
  const f=fixture();rec(f);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});const original=snap(f),broker=original.accounts.find(a=>a.kind==='broker'),fund=original.accounts.find(a=>a.kind==='fund');
  assert.equal((await call(f,'PUT',input({id:broker.id,name:broker.name,category:'securities',amount:150}))).status,200);let s=snap(f);assert.equal(s.summary.totalAsset,null);assert(s.issues.some(i=>i.code==='cash_overlap'));assert.equal(s.accounts.find(a=>a.id===broker.id).cash,130);
  assert.equal((await call(f,'PUT',input({id:fund.id,name:fund.name,amount:100,excluded:true}))).status,200);s=snap(f);assert.equal(s.summary.totalAsset,150);assert.equal(s.categories.find(c=>c.id==='securities').value,20);assert.equal(s.categories.find(c=>c.id==='cash').value,130);
  assert.equal((await call(f,'DELETE',{id:broker.id,revision:1})).status,200);assert.equal(snap(f).accounts.find(a=>a.id===broker.id).reconciled,false);
  assert.equal(snap(f).accounts.find(a=>a.id===broker.id).revision,2);assert.equal((await call(f,'PUT',input({id:broker.id,name:broker.name,category:'securities',amount:150}))).status,409,'restoring a source cannot revive an old revision-zero form');
  assert.equal((await call(f,'PUT',input({id:broker.id,revision:2,name:broker.name,category:'securities',amount:150}))).status,200);assert.equal(snap(f).accounts.find(a=>a.id===broker.id).revision,3);
 });
 await test('renaming live broker accounts preserves automatic valuation and the center total after quotes change',async()=>{
  for(const version of[1,2]){
   const f=fixture(),r=rec(f);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});
   const before=snap(f),a=before.accounts.find(a=>a.kind==='broker'),unchanged=business();assert.equal(before.summary.netAsset,120);
   const amountMode=load('lib/assetAllocationClient.ts').allocationAmountMode(a,a.amount);assert.equal(amountMode,'automatic');
   assert.equal((await call(f,'PUT',input({id:a.id,name:'Renamed Broker',category:a.category,amount:a.amount,amountMode}),version)).status,200);
   quotes={[r.id]:{price:11,time:'actual'}};const after=(await call(f,'GET',undefined,version)).body.data,renamed=after.accounts.find(x=>x.id===a.id);
   assert.equal(after.summary.netAsset,122);assert.equal(after.summary.complete,true);assert.equal(renamed.name,'Renamed Broker');assert.equal(renamed.amount,22);assert.equal(renamed.reconciled,false);assert.equal(renamed.cash,null);assert.equal(after.summary.difference,0);assert.deepEqual(after.issues,[]);assert.deepEqual(business(),unchanged);
   assert.equal((await call(f,'PUT',input({id:a.id,name:'Stale Rename',category:a.category,amount:22,amountMode}),version)).status,409);
  }
 });
 await test('bank, fund and ledger labels and exclusions keep following their original balances',async()=>{
  const f=fixture();funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});cards.setCardHeld(f.user.id,'debit.png',true);cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:7,currency:'USD'});
  simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,cash:[{id:'cash',name:'Cash',cur:'USD',amount:10}]});
  const original=snap(f);for(const a of original.accounts)assert.equal((await call(f,'PUT',input({id:a.id,name:'Renamed '+a.kind,category:a.category,amount:a.amount,amountMode:'automatic',excluded:a.kind==='ledger'}))).status,200);
  funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:5,direction:1});cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:9,currency:'USD'});simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,cash:[{id:'cash',name:'Cash',cur:'USD',amount:30}]});
  const after=snap(f);assert.equal(after.summary.netAsset,114);assert.equal(after.bankSummary.value,9);assert.equal(after.accounts.find(a=>a.kind==='fund').amount,105);assert.equal(after.accounts.find(a=>a.kind==='ledger').amount,30);assert.equal(after.accounts.find(a=>a.kind==='ledger').excluded,true);assert(after.accounts.every(a=>a.name.startsWith('Renamed ')&&!a.reconciled));
  cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:0,currency:'USD'});assert.equal(snap(f).accounts.filter(a=>a.kind==='bank').length,0);
 });
 await test('restoring a previously frozen renamed account keeps its name and recovers complete live totals',async()=>{
  const f=fixture(),r=rec(f);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:100,direction:1});const a=snap(f).accounts.find(a=>a.kind==='broker');
  assert.equal((await call(f,'PUT',input({id:a.id,name:'Keep My Name',category:a.category,amount:a.amount}))).status,200);quotes={[r.id]:{price:11,time:'actual'}};assert.equal(snap(f).summary.netAsset,null);
  const statement=snap(f).accounts.find(x=>x.id===a.id);assert.equal(load('lib/assetAllocationClient.ts').allocationAmountMode(statement,statement.amount),'statement');
  assert.equal((await call(f,'PUT',input({id:a.id,revision:1,name:'Keep New Name',category:a.category,amount:statement.amount,amountMode:'statement'}))).status,200);assert.equal(snap(f).summary.netAsset,null,'a real statement is never silently discarded');
  assert.equal((await call(f,'DELETE',{id:a.id,revision:2},2)).status,200);const restored=snap(f).accounts.find(x=>x.id===a.id);assert.equal(restored.name,'Keep New Name');assert.equal(restored.reconciled,false);assert.equal(restored.revision,3);assert.equal(snap(f).summary.netAsset,122);
  assert.equal((await call(f,'DELETE',{id:a.id,revision:2},2)).status,409);
 });
 await test('automatic modes are limited to current owned linked sources and old databases preserve statements',async()=>{
  const f=fixture(),other=fixture();rec(f);const a=snap(f).accounts[0];assert.equal((await call(f,'POST',input({amountMode:'automatic'}))).status,400);
  const manual=(await call(f,'POST',input())).body.data;assert.equal((await call(f,'PUT',input({id:manual.id,revision:1,amountMode:'automatic'}))).status,400);
  assert.equal((await call(other,'PUT',input({id:a.id,category:a.category,amountMode:'automatic'}))).status,404);assert.equal((await call(f,'PUT',input({id:a.id,category:a.category,amountMode:'invalid'}))).status,400);
  const Database=require('better-sqlite3'),legacy=new Database(':memory:');
  try{
   legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('legacy');CREATE TABLE asset_allocation_accounts(user_id TEXT NOT NULL,source_id TEXT NOT NULL,name TEXT NOT NULL,currency TEXT NOT NULL,amount REAL NOT NULL,category TEXT NOT NULL,excluded INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,source_id));INSERT INTO asset_allocation_accounts VALUES('legacy','fund:USD','Old Name','USD',150,'cash',0,7,'2026-10-09T00:00:00Z');");
   const before=legacy.prepare('SELECT * FROM asset_allocation_accounts').get(),install=load('lib/assetAllocationSchema.ts').installAssetAllocation;install(legacy);install(legacy);
   const row=legacy.prepare('SELECT * FROM asset_allocation_accounts').get();assert.deepEqual(row,{...before,amount_mode:'statement'});assert.equal(legacy.prepare('SELECT revision FROM asset_allocation_revisions').get().revision,7);
   legacy.prepare("UPDATE asset_allocation_accounts SET amount_mode='automatic'").run();assert.equal(legacy.prepare('SELECT revision FROM asset_allocation_accounts').get().revision,8);
  }finally{legacy.close();}
 });
 await test('foreign owners, missing sources, stale owners and linked currency/category changes are rejected',async()=>{
  const f=fixture(),other=fixture();rec(f);const a=snap(f).accounts[0];assert.equal((await call(other,'PUT',input({id:a.id,category:'securities'}))).status,404);
  assert.equal((await call(f,'PUT',input({id:a.id,category:'securities',currency:'CNY'}))).status,400);assert.equal((await call(f,'PUT',input({id:a.id,category:'cash'}))).status,400);
  assert.equal((await call(f,'POST',input(),1,{'x-allocation-user':other.user.id})).status,409);
  const c=await call(f,'POST',input());assert.equal((await call(other,'DELETE',{id:c.body.data.id,revision:1})).status,409);assert.equal(snap(other).summary.totalAsset,0);
 });
 await test('unknown card data, missing FX and corrupt source data preserve incomplete nulls',async()=>{
  const f=fixture();cards.setCardHeld(f.user.id,'unknown.png',true);cards.upsertCardAmount(f.user.id,{cardKey:'unknown.png',amount:5,currency:'USD'});assert.equal(snap(f).summary.totalAsset,null);assert.equal((await call(f)).body.data.summary.complete,false,'unknown sources remain readable rather than failing client validation');
  const g=fixture();await call(g,'POST',input({currency:'RUB'}));assert.equal(snap(g).summary.totalAsset,null);assert(snap(g).issues.some(i=>i.code==='value_unavailable'));
  db.prepare("INSERT INTO user_settings(user_id,fire,simple) VALUES(?,'{}','{broken')").run(g.user.id);assert.equal(snap(g).summary.totalAsset,null);
  const emptyCard=fixture();cards.setCardHeld(emptyCard.user.id,'debit.png',true);const e=snap(emptyCard);assert.equal(e.accounts.length,0);assert.equal(e.summary.totalAsset,0);assert.equal(e.summary.complete,true);assert.deepEqual(e.bankSummary,{count:0,includedCount:0,value:0});
  const corrupt=fixture();simple.setSimpleLedger(corrupt.user.id,simple.EMPTY_SIMPLE);db.prepare('UPDATE user_settings SET simple=? WHERE user_id=?').run('{"cash":{}}',corrupt.user.id);assert.equal(snap(corrupt).summary.totalAsset,null);
 });
 await test('only recorded nonzero bank balances enter Web/App snapshots; cleared statements remain editable and restorable',async()=>{
  const f=fixture();for(const [key,amount,currency]of[['debit.png',0,'USD'],['prepaid.png',14,'HKD'],['credit.png',10000,'USD']]){cards.setCardHeld(f.user.id,key,true);cards.upsertCardAmount(f.user.id,{cardKey:key,amount,currency});}
  const before=business(),s=snap(f),bank=s.accounts.find(a=>a.kind==='bank');assert.equal(s.accounts.length,1);assert.deepEqual(s.bankSummary,{count:1,includedCount:1,value:2});
  for(const v of[1,2])assert.deepEqual((await call(f,'GET',undefined,v)).body.data.bankSummary,s.bankSummary);
  const body=input({id:bank.id,name:bank.name,currency:'HKD',amount:0});assert.equal((await call(f,'PUT',body,2)).status,200);assert.equal(snap(f).accounts.length,0);assert.deepEqual(snap(f).bankSummary,{count:0,includedCount:0,value:0});
  assert.equal((await call(f,'PUT',{...body,revision:1,currency:'USD',amount:21})).status,400);assert.equal((await call(f,'PUT',{...body,revision:0,amount:21})).status,409);
  assert.equal((await call(f,'PUT',{...body,revision:1,amount:21})).status,200);assert.equal(snap(f).bankSummary.value,3);
  assert.equal((await call(f,'DELETE',{id:bank.id,revision:2},2)).status,200);assert.equal(snap(f).bankSummary.value,2);assert.deepEqual(business(),before);
 });
 await test('bank grouping rounds once, respects exclusions and keeps missing FX incomplete',async()=>{
  const f=fixture();for(const key of['debit.png','prepaid.png']){cards.setCardHeld(f.user.id,key,true);cards.upsertCardAmount(f.user.id,{cardKey:key,amount:.004,currency:'USD'});}
  let s=snap(f);assert.equal(s.bankSummary.value,.01);assert.equal(s.summary.totalAsset,.01);
  const a=s.accounts[0];assert.equal((await call(f,'PUT',input({id:a.id,name:a.name,amount:.004,excluded:true}))).status,200);s=snap(f);assert.deepEqual(s.bankSummary,{count:2,includedCount:1,value:0});
  const g=fixture();cards.setCardHeld(g.user.id,'debit.png',true);cards.upsertCardAmount(g.user.id,{cardKey:'debit.png',amount:7,currency:'HKD'});rates.HKD=0;const missing=snap(g);assert.equal(missing.bankSummary.value,null);assert.equal(missing.bankSummary.count,1);assert.equal(missing.summary.complete,false);
 });
 await test('all ledger categories and debt reconcile without using the ledger personal FX table',async()=>{
  const f=fixture();simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,fx:{USD:999},cash:[{id:'cash',name:'Cash',cur:'USD',amount:10}],fixed:[{id:'house',name:'House',cur:'CNY',amount:700}],debt:[{id:'loan',name:'Loan',cur:'USD',amount:20}],invest:[{id:'other',name:'Other',cur:'USD',amount:30}],receivable:[{id:'rec',name:'Receivable',cur:'USD',amount:5}]});
  const s=snap(f);assert.equal(s.summary.totalAsset,145);assert.equal(s.summary.totalDebt,20);assert.equal(s.summary.netAsset,125);assert.equal(s.summary.difference,125);assert.equal(s.categories.find(c=>c.id==='debt').weightPct,null);
  rates.CNY=0;assert.equal(snap(f).summary.netAsset,null);
 });
 await test('post-I/O freshness and revocation reject stale quotations and failed grant snapshots',async()=>{
  const f=fixture(),r=rec(f);quotes={[r.id]:{price:999,time:'actual'}};onQuotes=()=>db.prepare('UPDATE records SET price=12 WHERE id=?').run(r.id);let s=(await call(f)).body.data;assert.equal(s.summary.totalAsset,24);assert.deepEqual(s.quoteStatus.missing,[r.id]);
  onQuotes=()=>app.revokeAppGrant(f.grant.grant_id);assert.equal((await call(f)).status,401);
  const g=fixture();onQuotes=null;onRates=()=>app.revokeAppGrant(g.grant.grant_id);assert.equal((await call(g,'GET',undefined,2)).status,401);
 });
 await test('both App versions enforce read/write grants; v2 rejects Cookie fallback and foreign origins',async()=>{
  const f=fixture('portfolio.read');for(const v of[1,2]){assert.equal((await call(f,'GET',undefined,v)).status,200);assert.equal((await call(f,'POST',input(),v)).status,403);assert.equal((await call(f,'GET',undefined,v,{origin:'https://foreign.example'})).status,403);}
  const r=await load('app/api/v2/asset-allocation/route.ts').GET(new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/asset-allocation',{headers:{cookie:'fire_session='+f.cookie}}));assert.equal(r.status,401);
  for(const v of[1,2]){const r=await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(process.env.FIRE_APP_ORIGIN+`/api/v${v}/auth/config`));const c=(await r.json()).data.asset_allocation;assert.equal(c.snapshot_path,`/api/v${v}/asset-allocation`);assert.equal(c.read_scope,'portfolio.read');assert.equal(c.conditional_read,'weak-etag');assert.equal(c.snapshot_revision_field,'snapshotRevision');assert.equal(c.recommended_read_timeout_ms,8000);assert.equal(c.recommended_write_timeout_ms,12000);assert.equal(c.external_institution_connections,false);assert.equal(c.automatic_mutation_replay,false);}
 });
 await test('removed linked source does not resurrect statement money, and restores are owner/revision bound',async()=>{
  const f=fixture(),r=rec(f),a=snap(f).accounts[0];await call(f,'PUT',input({id:a.id,category:'securities',amount:90}));db.prepare('DELETE FROM records WHERE id=?').run(r.id);const s=snap(f);assert.equal(s.summary.totalAsset,0);assert.equal(s.accounts[0].excluded,true);assert(s.issues.some(i=>i.code==='source_removed'));
 });
 await test('sub-cent rounding happens after aggregation and exclusions persist across v1/v2',async()=>{
  const f=fixture();await call(f,'POST',input({name:'One',amount:.004}));await call(f,'POST',input({name:'Two',amount:.004}),2);assert.equal(snap(f).summary.totalAsset,.01);
  const a=snap(f).accounts[0];await call(f,'PUT',input({id:a.id,name:a.name,revision:1,amount:.004,excluded:true}),2);assert.equal((await call(f)).body.data.accounts.find(x=>x.id===a.id).excluded,true);
 });
 await test('strict inputs and authorization after mutation body I/O prevent corrupt or revoked writes',async()=>{
  const f=fixture();for(const b of[input({amount:'10'}),input({amount:1e13}),input({category:'debt',amount:-1}),input({extra:1}),input({name:''}),input({requestId:undefined})])assert.equal((await call(f,'POST',b)).status,400);
  assert.match(load('lib/randomId.ts').clientRequestId(),/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  const original=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const b=await original(...args);app.revokeAppGrant(f.grant.grant_id);return b;};try{assert.equal((await call(f,'POST',input())).status,401);assert.equal(overlay.allocationRows(f.user.id).length,0);}finally{bodies.readJsonBody=original;}
 });
 await test('broker assignment changes owned real holdings atomically with CAS and updates all linked accounts',async()=>{
  load('lib/settings.ts').updateSiteSettings({groups:[{id:'test-broker',name:'Test Broker'},{id:'second-broker',name:'Second Broker'}]});
  const f=fixture(),other=fixture(),r=rec(f),r2=rec(f,{code:'SECOND'}),foreign=rec(other);const broker=snap(f).brokers[0];assert(broker);
  const body={brokerId:broker.id,records:[{id:r.id,revision:r.revision},{id:foreign.id,revision:foreign.revision}]};
  assert.equal((await call(f,'POST',body,2,{},'/assign')).status,404);assert.equal(store.readRecord(f.user.id,r.id).group,'Broker One');
  body.records=[{id:r.id,revision:r.revision},{id:r2.id,revision:r2.revision-1}];assert.equal((await call(f,'POST',body,1,{},'/assign')).status,409);assert.equal(store.readRecord(f.user.id,r.id).group,'Broker One');
  body.records=[{id:r.id,revision:r.revision},{id:r2.id,revision:r2.revision}];assert.equal((await call(f,'POST',body,2,{},'/assign')).status,200);const s=snap(f);assert.equal(s.accounts.filter(a=>a.kind==='broker').length,1);assert.equal(s.accounts[0].name,broker.name);assert.equal(s.positions[0].brokerId,broker.id);assert.equal(s.summary.totalAsset,40);assert.equal(store.readRecord(f.user.id,r.id).qty,2);assert.equal(store.readRecord(f.user.id,r.id).cost,5);
  const a=s.accounts[0];await call(f,'PUT',input({id:a.id,category:'securities',amount:90}));const rr=store.readRecord(f.user.id,r.id);assert.equal((await call(f,'POST',{brokerId:broker.id,records:[{id:rr.id,revision:rr.revision}]},2,{},'/assign')).status,409);
  const read=fixture('portfolio.read'),rd=rec(read);assert.equal((await call(read,'POST',{brokerId:broker.id,records:[{id:rd.id,revision:rd.revision}]},2,{},'/assign')).status,403);
 });
 console.log(`Asset allocation: ${count} checks passed`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
