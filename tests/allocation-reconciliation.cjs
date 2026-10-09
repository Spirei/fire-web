const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-reconciliation-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),db=load('lib/db.ts').getDb(),auth=load('lib/auth.ts'),store=load('lib/store.ts'),orders=load('lib/orders.ts'),allocation=load('lib/assetAllocation.ts'),overlay=load('lib/assetAllocationStore.ts');
db.prepare("UPDATE users SET uid='1' WHERE id='demo-user' AND (uid IS NULL OR uid='')").run();
let seq=0,passed=0;const rates={USD:1,HKD:8,CNY:4};
const user=()=>auth.createUser('basis_test_'+(++seq),'Basis-Test-123');
const rec=(u,input={})=>store.createRecord(u.id,{name:'Test',code:'00001',market:'HK',price:8,cost:4,qty:10,group:'',note:'',...input});
const snap=(u,quotes={})=>allocation.buildAssetAllocation(u.id,rates,quotes,'USD');
const broker=(u,id,quotes={})=>snap(u,quotes).accounts.find(a=>a.id===id);
const ledgers=u=>['trade_orders','fund_transactions'].map(t=>db.prepare('SELECT * FROM '+t+' WHERE user_id=? ORDER BY id').all(u.id));
function reconcile(u,a,amount,extra={}){return overlay.saveAllocationAccount(u.id,{id:a.id,revision:a.revision,name:a.name,currency:a.currency,category:a.category,amount,amountMode:'statement',excluded:false,amountChanged:true,...extra},new Set(snap(u).accounts.filter(a=>a.kind!=='manual').map(a=>a.id)),a);}
async function test(name,fn){await fn();console.log('PASS '+name);passed++;}
(async()=>{
await test('manual equity starts at the entered amount, follows quotes, buys, sells and actual dividends without counting internal transfers twice',()=>{
 const u=user(),r=rec(u),a=snap(u).accounts.find(a=>a.kind==='broker'),old=ledgers(u);reconcile(u,a,1000);assert.equal(broker(u,a.id).amount,1000);assert.deepEqual(ledgers(u),old);
 assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1020);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:2,price:10,fees:1});assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1019);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:5,price:10,fees:2});assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1017);
 const dividend=orders.executeOrder({userId:u.id,recordId:r.id,side:'dividend',qty:7,price:1,fees:1}).order;assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1023);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:7,price:10,fees:3});const sold=broker(u,a.id);assert.equal(sold.amount,1020);assert.equal(sold.kind,'broker');assert.equal(sold.excluded,false);assert.equal(sold.holdings,0);
 orders.deleteOrder({userId:u.id,orderId:dividend.id});assert.equal(broker(u,a.id).amount,1014);
 const after=ledgers(u);snap(u);snap(u);assert.deepEqual(ledgers(u),after,'reads never repair or append cash');
});
await test('rename and include edits retain the original amount and checkpoint even when the displayed value has changed',()=>{
 const u=user(),r=rec(u),a=snap(u).accounts[0];reconcile(u,a,1000);const row=overlay.allocationRows(u.id)[0];
 const current=broker(u,a.id,{[r.id]:{price:10}});assert.equal(current.amount,1020);
 reconcile(u,current,current.amount,{name:'Renamed',excluded:true,amountChanged:false});const next=overlay.allocationRows(u.id)[0];assert.equal(next.amount,1000);assert.equal(next.statement_basis,row.statement_basis);
 assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1020);assert.equal(broker(u,a.id).excluded,true);
 assert.throws(()=>reconcile(u,a,2000,{amountChanged:false}),/更新|核对/,'stale metadata writes remain CAS protected');
});
await test('a fresh reconciliation rebases once, and correcting/deleting a fill follows both position and native cash changes',()=>{
 const u=user(),r=rec(u),a=snap(u).accounts[0];reconcile(u,a,1000);
 const buy=orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:2,price:8,fees:1}).order;assert.equal(broker(u,a.id).amount,999);
 orders.updateOrder({userId:u.id,orderId:buy.id,side:'buy',qty:2,price:8,fees:3});assert.equal(broker(u,a.id).amount,997);
 reconcile(u,broker(u,a.id),2000);assert.equal(broker(u,a.id).amount,2000);
 orders.deleteOrder({userId:u.id,orderId:buy.id});assert.equal(broker(u,a.id).amount,2003);
});
await test('Stock Connect equity uses HK quotes and actual CNY net settlement; unchanged legacy HK cash is not translated into fictitious CNY transactions',()=>{
 const u=user(),r=rec(u);orders.executeOrder({userId:u.id,recordId:r.id,side:'sell',qty:1,price:8,fees:1});
 store.updateRecord(r.id,u.id,{...store.readRecord(u.id,r.id),accountMarket:'CN'});
 const a=snap(u).accounts.find(a=>a.kind==='broker'),oldHK=ledgers(u)[1].filter(f=>f.currency==='HKD');reconcile(u,a,1000);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:2,price:8,fees:1,settlementAmount:9});assert.equal(broker(u,a.id).amount,999);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'dividend',qty:11,price:1,fees:0,settlementAmount:5});assert.equal(broker(u,a.id).amount,1004);
 assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1015);assert.deepEqual(ledgers(u)[1].filter(f=>f.currency==='HKD'),oldHK);
 assert.equal(allocation.buildAssetAllocation(u.id,{USD:1,CNY:4},{},'USD').accounts.find(b=>b.id===a.id).amount,null);
});
await test('a manually checked fund follows the canonical balance through a zero balance and later dividend',()=>{
 const u=user(),r=rec(u,{market:'US',code:'TEST',qty:1,price:10});
 db.prepare("INSERT INTO fund_transactions(id,user_id,currency,type,amount,direction,note,occurred_at,created_at) VALUES(?,?,?,'deposit',100,1,'',?,?)").run('seed-'+u.id,u.id,'USD',new Date().toISOString(),new Date().toISOString());
 const a=snap(u).accounts.find(a=>a.id==='fund:USD');reconcile(u,a,500);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:10,price:10,fees:0});assert.equal(broker(u,a.id).amount,400);assert.equal(broker(u,a.id).excluded,false);
 orders.executeOrder({userId:u.id,recordId:r.id,side:'dividend',qty:11,price:1,fees:0});assert.equal(broker(u,a.id).amount,411);
});
await test('legacy statements retain their exact numbers until explicitly checked again; corrupt checkpoints produce missing valuation',()=>{
 const u=user(),r=rec(u),a=snap(u).accounts[0];overlay.saveAllocationAccount(u.id,{id:a.id,revision:0,name:'Legacy',currency:a.currency,amount:1000,category:a.category,excluded:false,amountMode:'statement'},new Set([a.id]));
 assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1000);assert.equal(broker(u,a.id).reconciledAt,null);
 reconcile(u,broker(u,a.id),1000);assert.equal(broker(u,a.id,{[r.id]:{price:10}}).amount,1020);
 db.prepare("UPDATE asset_allocation_accounts SET statement_basis=? WHERE user_id=? AND source_id=?").run('{"version":9}',u.id,a.id);assert.equal(broker(u,a.id).amount,null);assert.equal(snap(u).summary.complete,false);
});
await test('Web writes capture a server-owned valuation checkpoint and metadata-only requests cannot overwrite it',async()=>{
 const u=user(),r=rec(u),a=snap(u).accounts[0],token=auth.createSession(u.id),origin='https://basis.example.test';process.env.FIRE_APP_ORIGIN=origin;
 const route=load('app/api/v1/asset-allocation/route.ts'),send=body=>route.PUT(new Request(origin+'/api/v1/asset-allocation',{method:'PUT',headers:{cookie:'fire_session='+token,origin,'content-type':'application/json'},body:JSON.stringify(body)}));
 const body={id:a.id,revision:a.revision,name:'Checked',currency:a.currency,amount:1000,category:a.category,excluded:false,amountMode:'statement',amountChanged:true};const response=await send(body);assert.equal(response.status,200);const row=overlay.allocationRows(u.id)[0];assert(row.statement_basis);
 const updated=await send({...body,revision:row.revision,name:'Renamed',amount:999999,amountChanged:false});assert.equal(updated.status,200);assert.equal(overlay.allocationRows(u.id)[0].amount,1000);assert.equal(overlay.allocationRows(u.id)[0].statement_basis,row.statement_basis);
 assert.equal((await send({...body,revision:overlay.allocationRows(u.id)[0].revision,amountChanged:'false'})).status,400);assert.equal(ledgers(u)[0].length,0);
});
await test('a missing holding price cannot become a fictitious zero reconciliation baseline',async()=>{
 const u=user();rec(u,{price:''});const a=snap(u).accounts[0],token=auth.createSession(u.id),origin='https://basis.example.test';
 const response=await load('app/api/v1/asset-allocation/route.ts').PUT(new Request(origin+'/api/v1/asset-allocation',{method:'PUT',headers:{cookie:'fire_session='+token,origin,'content-type':'application/json'},body:JSON.stringify({id:a.id,revision:a.revision,name:a.name,currency:a.currency,category:a.category,excluded:false,amountMode:'statement',amountChanged:true,amount:1000})}));
 assert.equal(response.status,400);assert.equal(overlay.allocationRows(u.id).length,0);assert.equal(ledgers(u)[0].length,0);
});
console.log(`Allocation reconciliation: ${passed} passed`);db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
