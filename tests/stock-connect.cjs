const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-stock-connect-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),db=load('lib/db.ts').getDb(),auth=load('lib/auth.ts'),store=load('lib/store.ts'),orders=load('lib/orders.ts'),funds=load('lib/funds.ts'),allocation=load('lib/assetAllocation.ts'),overlay=load('lib/assetAllocationStore.ts'),migration=load('lib/stockConnectMigration.ts'),contracts=load('lib/recordsContract.ts'),account=load('lib/stockAccount.ts');
// A deployed database has assigned numeric UIDs; the development seed leaves its first UID blank.
db.prepare("UPDATE users SET uid='1' WHERE id='demo-user' AND (uid IS NULL OR uid='')").run();
const rates={USD:1,HKD:8,CNY:4},snap=u=>allocation.buildAssetAllocation(u.id,rates,{},'USD');
let seq=0,passed=0;const user=()=>auth.createUser('connect_test_'+(++seq),'Connect-Test-123');
const rec=(u,input={})=>store.createRecord(u.id,{name:'Test HK',code:'00001',market:'HK',qty:10,cost:4,price:8,group:'',note:'',...input});
const cash=u=>db.prepare('SELECT * FROM fund_transactions WHERE user_id=? ORDER BY id').all(u.id);
const ledger=u=>db.prepare('SELECT * FROM trade_orders WHERE user_id=? ORDER BY id').all(u.id);
const move=(u,rs)=>migration.migrateStockConnect(u.id,rs.map(r=>({id:r.id,revision:r.revision})),rates);
async function test(name,run){await run();console.log('PASS '+name);passed++;}
(async()=>{
await test('account routing keeps quote identity and cannot route a CN or US listing into HK',()=>{
 const u=user(),r=rec(u,{accountMarket:'CN'});assert.equal(account.holdingAccountMarket(r),'CN');assert.equal(account.holdingAccountCurrency(r),'CNY');assert.equal(r.market,'HK');assert.equal(r.code,'00001');assert(account.isStockConnect(r));
 const app=load('lib/appAssets.ts').buildAssets(u.id,{username:'Test',nickname:'',uid:'',avatar:''},rates,{}, {currency:'CNY',costMethod:'diluted',usPrice:'observed'});assert(app.markets.find(m=>m.market==='CN').date,'a Connect-only account still has a CN account calendar date');
 assert.throws(()=>rec(u,{market:'US',accountMarket:'CN'}));assert.throws(()=>rec(u,{accountMarket:null}));
 const changed=store.updateRecord(r.id,u.id,{...r,name:'Renamed'});assert.equal(changed.accountMarket,'CN');assert(changed.revision>r.revision);
 const same=store.readRecord(u.id,r.id),body={name:same.name,code:same.code,market:same.market,price:same.price,cost:same.cost,qty:same.qty,group:same.group,note:same.note,requestId:require('crypto').randomUUID(),revision:r.revision};
 const stale=contracts.mutateRecords(u.id,'update',same.id,body,()=>u.id,true);assert.equal(stale.error.status,409);assert.equal(store.readRecord(u.id,r.id).accountMarket,'CN');
 const {revision,...newBody}=body;const added=contracts.mutateRecords(u.id,'create','',{...newBody,requestId:require('crypto').randomUUID(),accountMarket:'CN'},()=>u.id,true);assert.equal(added.error,null);assert.equal(added.operation.record.accountMarket,'CN');
});
await test('CN account combines converted Stock Connect and ordinary A shares without duplicate global totals',()=>{
 const u=user(),direct=rec(u,{code:'00002'}),connect=rec(u,{accountMarket:'CN'}),cn=rec(u,{market:'CN',code:'600001',price:4,cost:2}),asset=rec(u,{market:'ASSET',code:'BTC',price:10,cost:5,qty:1});
 const s=snap(u);assert.equal(s.summary.totalAsset,40);assert.equal(s.summary.portfolioTotalAsset,40);assert.equal(s.accounts.find(a=>a.currency==='CNY').amount,80);
 assert.equal(s.positions.find(p=>p.id===connect.id).channel,'stock_connect');assert.equal(s.positions.find(p=>p.id===connect.id).market,'HK');assert.equal(s.positions.find(p=>p.id===direct.id).currency,'HKD');assert.equal(s.positions.find(p=>p.id===asset.id).currency,'USD');
 const overview=load('lib/overview.ts').buildOverview(store.listRecords(u.id),rates);assert.equal(overview.byMarket.CN.market,20);assert.equal(overview.byMarket.HK.market,10);
 const app=load('lib/appAssets.ts').buildAssets(u.id,{username:'Test',nickname:'',uid:'',avatar:''},rates,{}, {currency:'CNY',costMethod:'diluted',usPrice:'observed'});
 assert.equal(app.positions.find(p=>p.recordId===connect.id).currency,'HKD');assert.equal(app.positions.find(p=>p.recordId===connect.id).accountCurrency,'CNY');assert.equal(app.markets.find(m=>m.market==='CN').nativeMarketValue,80);assert.equal(app.markets.find(m=>m.market==='CN').positionCount,2);
 assert(load('lib/assetAllocationClient.ts').validAllocationSnapshot(s,'USD',u.id));
 const broken=structuredClone(s);broken.positions.find(p=>p.channel).currency='HKD';assert.equal(load('lib/assetAllocationClient.ts').validAllocationSnapshot(broken,'USD',u.id),false);
});
await test('missing exchange rates produce incomplete valuation and never 1:1 or zero',()=>{
 const u=user();rec(u,{accountMarket:'CN'});for(const bad of [{USD:1,CNY:4},{USD:1,HKD:8},{USD:1,CNY:0,HKD:8}]){const s=allocation.buildAssetAllocation(u.id,bad,{},'USD');assert.equal(s.accounts[0].amount,null);assert.equal(s.summary.totalAsset,null);assert.equal(s.summary.complete,false);}assert(Number.isNaN(account.holdingMoneyFactor({market:'HK',accountMarket:'CN'},{USD:1,CNY:4},'CNY')));
});
await test('migration moves five held and two sold identities, preserves every historical order and cash row, clears orphan automatic overlay',()=>{
 const u=user(),held=Array.from({length:5},(_,i)=>rec(u,{code:String(i+1).padStart(5,'0')})),sold=[rec(u,{code:'00006',qty:1}),rec(u,{code:'00007',qty:1})],watch=rec(u,{code:'00008',qty:'',source:'watchlist'});rec(u,{market:'CN',code:'600019',price:4});
 for(const r of sold)orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:1,price:8,fees:1});
 const selected=[...held,...sold.map(r=>store.readRecord(u.id,r.id))],before=snap(u),oldHk=before.accounts.find(a=>a.currency==='HKD');overlay.saveAllocationAccount(u.id,{id:oldHk.id,revision:oldHk.revision,name:'Old HK label',currency:'HKD',amount:oldHk.amount,category:'securities',excluded:false,amountMode:'automatic'},new Set(before.accounts.map(a=>a.id)));
 const oldOrders=ledger(u),oldFunds=cash(u),original=selected.map(r=>({id:r.id,code:r.code,market:r.market,qty:r.qty,cost:r.cost,price:r.price}));const result=move(u,selected),after=snap(u);
 assert.equal(after.summary.totalAsset,before.summary.totalAsset);assert.deepEqual(ledger(u),oldOrders);assert.deepEqual(cash(u),oldFunds);assert(result.removedSources.includes(oldHk.id));assert.equal(after.accounts.filter(a=>a.kind==='broker'&&a.currency==='HKD').length,0);assert.equal(after.positions.filter(p=>p.channel==='stock_connect').length,5);
 assert.deepEqual(selected.map(r=>{const n=store.readRecord(u.id,r.id);assert.equal(n.accountMarket,'CN');return{id:n.id,code:n.code,market:n.market,qty:n.qty,cost:n.cost,price:n.price};}),original);assert.equal(store.readRecord(u.id,watch.id).accountMarket,undefined);
 assert.equal(orders.listOrders(u.id,'all',100,undefined,'CN').length,2);assert.equal(orders.listOrders(u.id,'all',100,undefined,'HK').length,0);assert(orders.listOrders(u.id,'all').every(o=>o.accountMarket==='CN'&&o.market==='HK'&&!o.settlementCurrency));
 const revisions=result.records.map(r=>r.revision);move(u,selected);assert.deepEqual(selected.map(r=>store.readRecord(u.id,r.id).revision),revisions);
});
await test('migration rejects stale, foreign, pending and fixed statement records atomically',()=>{
 const u=user(),r=rec(u),second=rec(u,{code:'00002'}),foreign=rec(user());assert.throws(()=>move(u,[r,foreign]));assert.equal(store.readRecord(u.id,r.id).accountMarket,undefined);
 assert.throws(()=>migration.migrateStockConnect(u.id,[{id:r.id,revision:0}],rates));
 orders.placeOrder({userId:u.id,recordId:r.id,side:'buy',qty:1,price:1,fees:0,mode:'order',orderType:'limit'});assert.throws(()=>move(u,[second,r]));assert.equal(store.readRecord(u.id,second.id).accountMarket,undefined);
 const s=snap(u),a=s.accounts.find(a=>a.kind==='broker');overlay.saveAllocationAccount(u.id,{id:a.id,revision:a.revision,name:'Statement',currency:'HKD',amount:200,category:'securities',excluded:false,amountMode:'statement'},new Set(s.accounts.map(a=>a.id)));assert.throws(()=>move(u,[second]));
});
await test('new Stock Connect fills require actual net CNY; buy sell and dividend affect only CNY once',()=>{
 const u=user(),r=rec(u,{accountMarket:'CN'});const before=store.readRecord(u.id,r.id),oldOrders=ledger(u);
 for(const value of [undefined,0,-1,NaN,Infinity])assert.throws(()=>orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:1,price:8,fees:1,settlementAmount:value}));assert.deepEqual(store.readRecord(u.id,r.id),before);assert.deepEqual(ledger(u),oldOrders);
 const buy=orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:2,price:8,fees:1,settlementAmount:9});assert.equal(buy.order.market,'HK');assert.equal(buy.order.amount,16);assert.equal(buy.order.settlementCurrency,'CNY');assert.equal(funds.readFundBalances(u.id).CNY,-9);assert.equal(funds.readFundBalances(u.id).HKD,0);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:1,price:10,fees:2,settlementAmount:4});orders.executeOrder({userId:u.id,recordId:r.id,side:'dividend',qty:11,price:1,fees:0,settlementAmount:5});assert.equal(funds.readFundBalances(u.id).CNY,0);assert.equal(funds.readFundBalances(u.id).HKD,0);
 funds.syncOrderCashTransactions(u.id);assert.deepEqual(funds.fundBalances(u.id),funds.readFundBalances(u.id));assert.equal(cash(u).length,3);assert(cash(u).every(f=>f.currency==='CNY'));
});
await test('CNY order edits preserve net settlement on note edits, require replacement on financial edits, delete reverses correct currency',()=>{
 const u=user(),r=rec(u,{accountMarket:'CN'}),o=orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:1,price:8,fees:1,settlementAmount:4}).order;
 orders.updateOrder({userId:u.id,orderId:o.id,side:o.side,qty:o.qty,price:o.price,fees:o.fees,note:'Note'});assert.equal(funds.readFundBalances(u.id).CNY,-4);
 assert.throws(()=>orders.updateOrder({userId:u.id,orderId:o.id,side:o.side,qty:2,price:8,fees:1}));assert.equal(funds.readFundBalances(u.id).CNY,-4);
 orders.updateOrder({userId:u.id,orderId:o.id,side:o.side,qty:2,price:8,fees:1,settlementAmount:9});assert.equal(funds.readFundBalances(u.id).CNY,-9);orders.deleteOrder({userId:u.id,orderId:o.id});assert.equal(funds.readFundBalances(u.id).CNY,0);assert.equal(funds.readFundBalances(u.id).HKD,0);
});
await test('migrated legacy HK orders keep HKD on note correction and require actual CNY for financial correction',()=>{
 const u=user(),r=rec(u),o=orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:1,price:8,fees:1}).order;move(u,[store.readRecord(u.id,r.id)]);
 orders.updateOrder({userId:u.id,orderId:o.id,side:o.side,qty:o.qty,price:o.price,fees:o.fees,note:'Legacy'});assert.equal(funds.readFundBalances(u.id).HKD,7);assert.equal(funds.readFundBalances(u.id).CNY,0);assert.throws(()=>orders.updateOrder({userId:u.id,orderId:o.id,side:o.side,qty:1,price:10,fees:1}));
});
await test('Stock Connect cannot create automatic native cash through orders, import or dividends',async()=>{
 const u=user(),r=rec(u,{accountMarket:'CN'});assert.throws(()=>orders.placeOrder({userId:u.id,recordId:r.id,side:'buy',qty:1,price:8,fees:0,mode:'order',orderType:'market',settlementAmount:4}));
 const input=[{'市场':'HK','股票代码':'00001','股票名称':'Test HK','订单状态':'已成交','成交数量':'1','成交均价':'8','方向':'买入','委托时间':'2026-10-01 10:00:00'}];const result=load('lib/orderImport.ts').importBrokerOrders(u.id,input,false);assert.equal(result.imported,0);assert.equal(result.skipped,1);assert.match(result.groups[0].reason,/人民币/);assert.equal(cash(u).length,0);assert.equal(ledger(u).length,0);await assert.rejects(()=>load('lib/dividendSettlement.ts').settleRecordDividends(u.id,r.id),/人民币/);
});
await test('Web order API requires actual settlement and export retains net CNY and CN account metadata',async()=>{
 const u=user(),r=rec(u,{accountMarket:'CN'}),token=auth.createSession(u.id),origin='https://connect.example.test';
 process.env.FIRE_APP_ORIGIN=origin;
 const request=body=>new Request(origin+'/api/v1/orders',{method:'POST',headers:{cookie:'fire_session='+token,origin,'content-type':'application/json'},body:JSON.stringify({recordId:r.id,side:'buy',qty:1,price:8,fees:1,mode:'record',tradedAt:new Date(Date.now()-10000).toISOString(),...body})});
 const route=load('app/api/v1/orders/route.ts');assert.equal((await route.POST(request({}))).status,400);
 const response=await route.POST(request({settlementAmount:4}));assert.equal(response.status,200);const result=await response.json();assert.equal(result.data.order.settlementCurrency,'CNY');assert.equal(result.data.order.accountMarket,'CN');assert.equal(funds.readFundBalances(u.id).CNY,-4);assert.equal(funds.readFundBalances(u.id).HKD,0);
 const exported=await load('app/api/v1/orders/export/route.ts').GET(new Request(origin+'/api/v1/orders/export?scope=all&market=CN',{headers:{cookie:'fire_session='+token}}));assert.equal(exported.status,200);const sheet=load('lib/orderImportXlsx.ts').readBrokerOrderSheet(Buffer.from(await exported.arrayBuffer()));assert(sheet.headers.includes('实际结算净额'));assert.equal(sheet.rows[0]['结算币种'],'CNY');assert.equal(sheet.rows[0]['实际结算净额'],'4');assert.equal(sheet.rows[0]['账户归属'],'A股');assert.equal(sheet.rows[0]['币种'],'HKD');
});
await test('deployed CLI uses existing Next SWC, verifies a private backup and migrates only named owner records',()=>{
 const u=user(),r=rec(u),watch=rec(u,{code:'00002',qty:''});
 const run=require('node:child_process').spawnSync(process.execPath,[path.join(root,'scripts/migrate-stock-connect.cjs'),'--user',u.id,'--records',r.id,'--apply'],{cwd:temp,encoding:'utf8',timeout:30000,env:{...process.env,STOCKLOG_FUTU:'off'}});
 assert.equal(run.status,0,run.stderr);assert.equal(store.readRecord(u.id,r.id).accountMarket,'CN');assert.equal(store.readRecord(u.id,watch.id).accountMarket,undefined);
 const dir=path.join(temp,'data/migration-backups'),files=fs.readdirSync(dir);assert.equal(files.length,1);assert.equal(fs.statSync(path.join(dir,files[0])).mode&0o777,0o600);
 const backup=new (require('better-sqlite3'))(path.join(dir,files[0]),{readonly:true});assert.equal(backup.pragma('integrity_check',{simple:true}),'ok');assert.equal(backup.prepare('SELECT account_market FROM records WHERE id=?').get(r.id).account_market,'');backup.close();
});
console.log(`Stock Connect regression: ${passed} passed`);db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(0);
})().catch(error=>{console.error(error);process.exit(1);});
