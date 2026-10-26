// Real v1/v2 handlers, tokens and SQLite; every financial write is disposable.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
require.extensions['.tsx']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-api-trading-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://trades.example.test';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),app=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/store.ts'),orders=load('lib/orders.ts'),funds=load('lib/funds.ts'),assets=load('lib/appAssets.ts'),trading=load('lib/appTrading.ts');
let quote,afterQuote,quoteReads=0,index=0,count=0;
load('lib/quotes.ts').fetchOverviewQuotes=async items=>{quoteReads++;if(afterQuote)await afterQuote();return{quotes:quote?Object.fromEntries(items.map(i=>[i.id,quote])):{},cached:[],pending:false};};
load('lib/rates.ts').getRates=async()=>({USD:1,HKD:7,CNY:7});
const full='portfolio.read portfolio.write assets.read positions.read cash.read orders.read orders.write orders.cancel';
function fixture(scope=full){
 const user=auth.createUser('api_trade_'+(++index),'Trade-test-123'),cookie=auth.createSession(user.id),verifier=crypto.randomBytes(32).toString('base64url');
 const a={client_id:app.APP_CLIENT_ID,redirect_uri:app.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
 const code=app.issueAppCode(app.parseAppAuthorization(a),user.id,cookie),grant=app.exchangeAppCode({...a,code,code_verifier:verifier});
 const r=store.createRecord(user.id,{name:'Synthetic',code:'TEST',market:'US',qty:10,cost:5,price:10,group:'Broker',note:''});
 assets.declareInstrument(user.id,r.id,{requestId:crypto.randomUUID(),recordRevision:r.revision,revision:0,kind:'cash_equity',listingStatus:'listed'},()=>user.id);
 funds.createFundTransaction({userId:user.id,currency:'USD',type:'opening',amount:1000,direction:1});return{user,cookie,grant,r};
}
const state=f=>trading.tradingSnapshot(f.user.id);
function input(f,over={}){const s=state(f),r=store.readRecord(f.user.id,f.r.id);return{requestId:crypto.randomUUID(),accountId:f.user.id,recordId:r.id,recordRevision:r.revision,snapshotRevision:s.snapshotRevision,side:'buy',mode:'record',orderType:'limit',qty:2,price:10,fees:1,tif:'gtc',session:'REGULAR',tradedAt:new Date(Date.now()-1000).toISOString(),...over};}
async function call(v,f,tail='trading',method='GET',body,headers={}){
 let file=tail.split('?')[0],params={};
 if(file.startsWith('operations/')){params.requestId=file.split('/')[1];file='operations/[requestId]';}
 if(file.startsWith('trading/orders/')){params.orderId=file.split('/')[2];file='trading/orders/[orderId]'+(file.endsWith('/observations')?'/observations':file.endsWith('/preview')?'/preview':'');}
 const request=new Request(process.env.FIRE_APP_ORIGIN+`/api/v${v}/account-assets/`+tail,{method,headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const r=await load(`app/api/v${v}/account-assets/${file}/route.ts`)[method](request,{params:Promise.resolve(params)});return{status:r.status,...await r.json()};
}
const economic=f=>Object.fromEntries(['records','trade_orders','fund_transactions','app_trade_metadata'].map(t=>[t,db.prepare('SELECT * FROM '+t+' WHERE '+(t==='app_trade_metadata'?'order_id IN(SELECT id FROM trade_orders WHERE user_id=?)':'user_id=?')+' ORDER BY rowid').all(f.user.id)]));
const observe=(f,o)=>({requestId:crypto.randomUUID(),accountId:f.user.id,snapshotRevision:state(f).snapshotRevision,orderRevision:o.revision,recordRevision:store.readRecord(f.user.id,f.r.id).revision});
async function pending(f,over={}){const reply=await call(2,f,'trading/submissions','POST',input(f,{mode:'order',tradedAt:undefined,...over}));assert.equal(reply.status,200,JSON.stringify(reply));return reply.data.data.items[0];}
async function test(name,run){quote=undefined;afterQuote=undefined;quoteReads=0;db.prepare('DELETE FROM rate_limit').run();await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('undeclared securities trade without modifying classification; declared delisting remains blocked',async()=>{
  const f=fixture();db.prepare('DELETE FROM app_asset_instruments WHERE user_id=? AND record_id=?').run(f.user.id,f.r.id);
  const before=assets.instrumentSnapshot(f.user.id,f.r.id).instrument;
  assert.equal(before.kind,'unknown');
  const request=input(f);assert.equal(trading.previewTrade(f.user.id,request).amount,20);
  const receipt=trading.submitTrade(f.user.id,request,()=>f.user.id);assert.equal(receipt.result.state,'completed');
  assert.equal(assets.instrumentSnapshot(f.user.id,f.r.id).instrument.kind,'unknown');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_asset_instruments WHERE user_id=? AND record_id=?').get(f.user.id,f.r.id).n,0);
  const current=store.readRecord(f.user.id,f.r.id);
  assets.declareInstrument(f.user.id,current.id,{requestId:crypto.randomUUID(),recordRevision:current.revision,revision:0,kind:'cash_equity',listingStatus:'delisted'},()=>f.user.id);
  assert.throws(()=>trading.previewTrade(f.user.id,input(f)),/已声明退市/);
 });
 await test('discovery provides fixed paths without expanding existing grants or broker claims',async()=>{
  for(const v of [1,2]){const r=await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(process.env.FIRE_APP_ORIGIN+`/api/v${v}/auth/config`));const d=(await r.json()).data;assert.equal(d.scope,'portfolio.read portfolio.write');assert.equal(d.account_trading.submit_path,`/api/v${v}/account-assets/trading/submissions`);assert.equal(d.account_trading.amend_preview_path,`/api/v${v}/account-assets/trading/orders/{orderId}/preview`);assert.equal(d.account_trading.external_broker_execution,false);assert.equal(d.account_trading.background_execution,false);assert.equal(d.account_assets.cancel_scope,'orders.cancel');}
  const f=fixture('portfolio.read portfolio.write');assert.equal((await call(2,f)).status,403);assert.equal((await call(1,f,'trading/preview','POST',input(f))).status,403);
  assert.equal(app.refreshAppTokens('fire-ios',f.grant.refresh_token).scope,'portfolio.read portfolio.write');
 });
 await test('native permission consent issues usable explicit trading rights without upgrading the original grant',async()=>{
  const f=fixture('portfolio.read portfolio.write'),original=f.grant,scope='assets.read positions.read cash.read orders.read orders.write orders.cancel';
  const request=new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/auth/permissions',{method:'POST',headers:{authorization:'Bearer '+original.access_token,'content-type':'application/json'},body:JSON.stringify({client_id:'fire-ios',scope})});
  const response=await load('app/api/v2/auth/permissions/route.ts').POST(request),reply=await response.json();assert.equal(response.status,200,JSON.stringify(reply));
  assert.equal(reply.data.replaces_grant_id,original.grant_id);for(const s of scope.split(' ')){assert(reply.data.scope.split(' ').includes(s));assert.equal(reply.data.user.capabilities[s],true);}
  assert.equal((await call(2,f)).status,403);assert.equal(app.authenticateAppAccess(original.access_token,new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/auth/me')).scope,'portfolio.read portfolio.write');
  f.grant=reply.data;assert.equal((await call(2,f)).status,200);assert.equal((await call(2,f,'cash')).status,200);assert.equal((await call(2,f,'trading/preview','POST',input(f))).status,200);
 });
 await test('scoped views and previews are read-only and preserve account/currency cash',async()=>{
  const f=fixture(),before=economic(f);for(const v of [1,2]){assert.equal((await call(v,f,'cash')).data.nativeBalancesByCurrency.USD,1000);assert.equal((await call(v,f,'positions')).data.items[0].recordId,f.r.id);assert.equal((await call(v,f,'summary')).data.summary.totalAsset,1100);const p=await call(v,f,'trading/preview','POST',input(f));assert.equal(p.status,200);assert.equal(p.data.cashAfter,979);assert.equal(p.data.feeBreakdown,null);}assert.deepEqual(economic(f),before);
 });
 await test('cash reads and previews avoid formatting unused order history while preserving the snapshot',async()=>{
  const f=fixture();for(let i=0;i<40;i++)orders.placeOrder({userId:f.user.id,recordId:f.r.id,side:'buy',qty:1,price:1,fees:0,orderType:'limit',tif:'gtc',mode:'order'});
  const module=load('lib/appAssetOrders.ts'),original=module.assetOrderItem;let formatted=0;
  module.assetOrderItem=(...args)=>{formatted++;return original(...args);};
  try {
   const full=state(f),b=input(f);assert.equal(full.orders.length,40);formatted=0;
   for(const v of [1,2]){
    const cash=await call(v,f,'cash');assert.equal(cash.status,200);assert.equal(cash.data.snapshotRevision,full.snapshotRevision);assert.equal(cash.data.nativeBalancesByCurrency.USD,full.cash.nativeBalancesByCurrency.USD);
    const preview=await call(v,f,'trading/preview','POST',b);assert.equal(preview.status,200);assert.equal(preview.data.snapshotRevision,full.snapshotRevision);assert.equal(preview.data.reservedCash,40);
   }
   assert.equal(formatted,0,'cash and preview must not format unused historical order DTOs');
   const again=await call(2,f);assert.deepEqual(again.data.orders,full.orders);assert.equal(again.data.snapshotRevision,full.snapshotRevision);assert.equal(formatted,40);
  } finally {module.assetOrderItem=original;}
 });
 await test('confirmed registration commits cash, position and durable cross-version receipt once',async()=>{
  const f=fixture(),b=input(f),reply=await call(2,f,'trading/submissions','POST',b);assert.equal(reply.status,200,JSON.stringify(reply));assert.equal(store.readRecord(f.user.id,f.r.id).qty,12);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,979);assert.equal(reply.data.data.items[0].status,'filled');assert.equal(reply.data.data.items[0].executionModel,'owner_recorded_fill');assert.equal((await call(1,f,'trading/submissions','POST',b)).code,40901);assert.deepEqual((await call(1,f,'operations/'+b.requestId)).data,reply.data);
 });
 await test('financial changes invalidate preview; failures preserve financial data and have receipts',async()=>{
  const f=fixture(),b=input(f);funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'withdrawal',amount:5,direction:-1});const before=economic(f),r=await call(1,f,'trading/submissions','POST',b);assert.equal(r.code,40902);assert.deepEqual(economic(f),before);assert.equal((await call(2,f,'operations/'+b.requestId)).data.state,'failed');assert.equal((await call(2,f,'trading/submissions','POST',b)).code,40901);
 });
 await test('invalid amounts, unknown fields, missing units, oversells and insufficient cash cannot commit',async()=>{
  const f=fixture(),before=economic(f);for(const change of [{qty:-1},{price:null},{fees:undefined},{fees:'0'},{userId:f.user.id},{qty:1000},{side:'sell',qty:11},{tradedAt:new Date(Date.now()+86400000).toISOString()}])assert.notEqual((await call(2,f,'trading/submissions','POST',input(f,change))).status,200);assert.deepEqual(economic(f),before);
  db.prepare("UPDATE app_asset_instruments SET kind='unknown' WHERE record_id=?").run(f.r.id);const unclassifiedBefore=economic(f);assert.equal((await call(1,f,'trading/preview','POST',input(f))).code,0);assert.deepEqual(economic(f),unclassifiedBefore);
 });
 await test('cash reconciliation records only a signed delta with CAS, pagination and one-time receipts',async()=>{
  const f=fixture(),s=state(f),b={requestId:crypto.randomUUID(),accountId:f.user.id,snapshotRevision:s.snapshotRevision,currency:'USD',balance:200};const r=await call(2,f,'cash','POST',b);assert.equal(r.status,200);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,200);assert.equal(funds.listFundTransactions(f.user.id)[0].amount,800);assert.equal((await call(1,f,'cash','POST',b)).code,40901);assert.equal((await call(1,f,'cash?limit=1&offset=1')).data.transactions.length,1);assert.equal((await call(2,f,'cash?snapshotRevision='+s.snapshotRevision)).code,40902);for(const q of ['limit=0','limit=201','offset=.1','offset=-1','currency=BAD','owner=x','limit=1&limit=2'])assert.equal((await call(2,f,'cash?'+q)).status,400);
 });
 await test('new conditions never execute from GET or the old lazy settlement path',async()=>{
  const f=fixture(),o=await pending(f),before=economic(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await call(1,f);await call(2,f,'orders?scope=all');const settled=await orders.settlePendingOrders(f.user.id);assert.equal(settled.checked,0);assert.deepEqual(economic(f),before);assert.equal(state(f).orders.find(x=>x.id===o.id).status,'pending');
 });
 await test('fresh server quotes execute once while stale, future and unsupported sessions cannot fill',async()=>{
  const f=fixture(),o=await pending(f),before=economic(f);for(const q of [{price:9,time:new Date(Date.now()-60000).toISOString(),source:'futu',session:'REGULAR'},{price:9,time:new Date(Date.now()+60000).toISOString(),source:'futu',session:'REGULAR'},{price:9,time:new Date().toISOString(),source:'futu',session:'OVERNIGHT'},{price:9,time:new Date().toISOString(),source:'auto',session:'REGULAR'}]){quote=q;assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o))).code,40902);assert.deepEqual(economic(f),before);}
  quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};const b=observe(f,o),r=await call(1,f,'trading/orders/'+o.id+'/observations','POST',b);assert.equal(r.status,200,JSON.stringify(r));assert.equal(store.readRecord(f.user.id,f.r.id).qty,12);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,981);assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',b)).code,40901);
 });
 await test('bracket children start only after full fill and one side atomically cancels its sibling',async()=>{
  const f=fixture(),a={takeProfit:{percent:10,orderType:'market',fees:0},stopLoss:{percent:10,orderType:'market',fees:0},session:'REGULAR',tif:'gtc'},o=await pending(f,{attachments:a});assert.equal(state(f).orders.length,1);
  quote={price:10,time:new Date().toISOString(),source:'futu',session:'REGULAR'};let r=await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o));assert.equal(r.status,200,JSON.stringify(r));assert.equal(state(f).orders.length,3);const children=db.prepare('SELECT * FROM app_trade_metadata WHERE parent_id=?').all(o.id),profit=children.find(x=>x.role==='take_profit'),child=state(f).orders.find(x=>x.id===profit.order_id);
  quote={price:12,time:new Date().toISOString(),source:'futu',session:'REGULAR'};r=await call(1,f,'trading/orders/'+child.id+'/observations','POST',observe(f,child));assert.equal(r.status,200,JSON.stringify(r));assert.equal(store.readRecord(f.user.id,f.r.id).qty,10);const states=children.map(c=>state(f).orders.find(x=>x.id===c.order_id).status);assert.deepEqual(states.sort(),['cancelled','filled']);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,1003);
 });
 await test('order reservations prevent oversubscribing cash or quantity, OCO shares one reservation',async()=>{
  const f=fixture();await pending(f,{qty:60});assert.equal((await call(1,f,'trading/preview','POST',input(f,{qty:50}))).code,40902);await pending(f,{side:'sell',qty:6});assert.equal((await call(2,f,'trading/preview','POST',input(f,{side:'sell',qty:5}))).code,40902);
 });
 await test('amend preserves the order number, increments revision and rejects stale or old-route writers',async()=>{
  const f=fixture(),o=await pending(f),b=input(f,{mode:'order',tradedAt:undefined,price:8,orderRevision:o.revision});const r=await call(1,f,'trading/orders/'+o.id,'PUT',b);assert.equal(r.status,200,JSON.stringify(r));const latest=state(f).orders.find(x=>x.id===o.id);assert.equal(latest.orderNo,o.orderNo);assert(latest.revision>o.revision);assert.equal(latest.price,8);assert.equal((await call(2,f,'trading/orders/'+o.id,'PUT',b)).code,40901);assert.throws(()=>orders.cancelOrder({userId:f.user.id,orderId:o.id}),/版本/);assert.throws(()=>orders.deleteOrder({userId:f.user.id,orderId:o.id}),/回执/);assert.throws(()=>orders.updateOrder({userId:f.user.id,orderId:o.id,side:'buy',qty:1,price:3,fees:0}),/版本/);
 });
 await test('amend previews exclude the original cash or quantity reservation and preserve other orders',async()=>{
  const f=fixture(),o=await pending(f,{qty:80,fees:0});await pending(f,{qty:10,fees:0});
  const b=input(f,{mode:'order',tradedAt:undefined,qty:85,fees:0,orderRevision:o.revision}),before=economic(f),receipts=db.prepare('SELECT count(*) AS n FROM app_asset_operations WHERE user_id=?').get(f.user.id).n;
  assert.equal((await call(1,f,'trading/preview','POST',b)).status,400);
  for(const v of [1,2]){const p=await call(v,f,'trading/orders/'+o.id+'/preview','POST',b);assert.equal(p.status,200,JSON.stringify(p));assert.equal(p.data.orderId,o.id);assert.equal(p.data.orderRevision,o.revision);assert.equal(p.data.reservedCash,100);assert.equal(p.data.cashAfter,150);}
  assert.deepEqual(economic(f),before);assert.equal(db.prepare('SELECT count(*) AS n FROM app_asset_operations WHERE user_id=?').get(f.user.id).n,receipts);
  const result=await call(2,f,'trading/orders/'+o.id,'PUT',b);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.data.preview.cashAfter,150);
  const g=fixture(),s=await pending(g,{side:'sell',qty:9,fees:0}),sb=input(g,{mode:'order',tradedAt:undefined,side:'sell',qty:8,fees:0,orderRevision:s.revision});
  assert.equal((await call(2,g,'trading/orders/'+s.id+'/preview','POST',sb)).data.qtyAfter,2);
 });
 await test('amend previews and mutations reject foreign, stale and changed security identities',async()=>{
  const f=fixture(),other=fixture(),o=await pending(f),b=input(f,{mode:'order',tradedAt:undefined,orderRevision:o.revision}),before=economic(f);
  assert.equal((await call(2,other,'trading/orders/'+o.id+'/preview','POST',input(other,{mode:'order',tradedAt:undefined,orderRevision:o.revision}))).status,404);
  assert.equal((await call(1,f,'trading/orders/'+o.id+'/preview','POST',{...b,orderRevision:o.revision+1})).code,40902);
  assert.equal((await call(2,f,'trading/orders/'+o.id+'/preview','POST',{...b,recordRevision:b.recordRevision+1})).code,40902);
  assert.equal((await call(2,f,'trading/orders/'+o.id+'/preview','POST',b,{authorization:'',cookie:'fire_session='+f.cookie})).status,401);
  assert.deepEqual(economic(f),before);
  const weak=fixture('portfolio.read portfolio.write');assert.equal((await call(2,weak,'trading/orders/'+o.id+'/preview','POST',input(weak,{mode:'order',tradedAt:undefined,orderRevision:1}))).status,403);
  db.prepare("UPDATE records SET code='CHANGED' WHERE id=?").run(f.r.id);const current=store.readRecord(f.user.id,f.r.id);
  assets.declareInstrument(f.user.id,current.id,{requestId:crypto.randomUUID(),recordRevision:current.revision,revision:assets.instrumentSnapshot(f.user.id,current.id).instrument.revision,kind:'cash_equity',listingStatus:'listed'},()=>f.user.id);
  const changed=input(f,{mode:'order',tradedAt:undefined,orderRevision:o.revision}),economicBefore=economic(f);
  assert.equal((await call(1,f,'trading/orders/'+o.id+'/preview','POST',changed)).code,40902);
  const result=await call(2,f,'trading/orders/'+o.id,'PUT',changed);assert.equal(result.code,40902);assert.deepEqual(economic(f),economicBefore);
  assert.equal((await call(1,f,'operations/'+changed.requestId)).data.state,'failed');
 });
 await test('pending parent order reads preserve attachment inputs before children exist and after amendment',async()=>{
  const f=fixture(),a={takeProfit:{percent:10,orderType:'market',fees:1},stopLoss:{percent:5,orderType:'limit',limitPrice:8,fees:2},session:'EXTENDED',tif:'gtc'},o=await pending(f,{attachments:a});
  assert.equal(o.attachmentInputsAvailable,true);assert.deepEqual(o.attachments,a);assert.equal(state(f).orders.length,1);
  for(const v of [1,2]){const list=await call(v,f,'orders?scope=all');assert.equal(list.data.items[0].attachmentInputsAvailable,true);assert.deepEqual(list.data.items[0].attachments,a);}
  const b=input(f,{mode:'order',tradedAt:undefined,price:9,orderRevision:o.revision,attachments:o.attachments});
  assert.equal((await call(2,f,'trading/orders/'+o.id+'/preview','POST',b)).status,200);
  const changed=await call(1,f,'trading/orders/'+o.id,'PUT',b);assert.equal(changed.status,200);assert.deepEqual(changed.data.data.items[0].attachments,a);
  const plain=await pending(f);assert.equal(plain.attachmentInputsAvailable,true);assert.equal(plain.attachments,null);
  const legacy=orders.placeOrder({userId:f.user.id,recordId:f.r.id,side:'buy',qty:1,price:1,fees:0,mode:'order',orderType:'limit'}).order;
  assert.equal(state(f).orders.find(x=>x.id===legacy.id).attachmentInputsAvailable,false);
 });
 await test('Stock Connect keeps HKD price/fees and records the actual CNY net amount exactly once',async()=>{
  const f=fixture();db.prepare("UPDATE records SET market='HK',code='00700',account_market='CN' WHERE id=?").run(f.r.id);const rr=store.readRecord(f.user.id,f.r.id);assert.equal(assets.declareInstrument(f.user.id,rr.id,{requestId:crypto.randomUUID(),recordRevision:rr.revision,revision:assets.instrumentSnapshot(f.user.id,rr.id).instrument.revision,kind:'cash_equity',listingStatus:'listed'},()=>f.user.id).error,null);funds.createFundTransaction({userId:f.user.id,currency:'CNY',type:'opening',amount:1000,direction:1});
  assert.equal((await call(2,f,'trading/submissions','POST',input(f))).status,400);const b=input(f,{settlementAmount:19}),r=await call(2,f,'trading/submissions','POST',b);assert.equal(r.status,200,JSON.stringify(r));assert.equal(state(f).cash.nativeBalancesByCurrency.CNY,981);assert.equal(state(f).cash.nativeBalancesByCurrency.HKD,0);const o=r.data.data.items[0];assert.equal(o.accountMarket,'CN');assert.equal(o.settlementCurrency,'CNY');assert.equal(o.settlementAmount,19);assert.equal(o.fees,1);assert.equal((await call(1,f,'trading/submissions','POST',input(f,{mode:'order',tradedAt:undefined,settlementAmount:19}))).status,400);
 });
 await test('owner, Cookie, method, origin and late grant revocation fail without financial changes',async()=>{
  const f=fixture(),other=fixture(),before=economic(f);assert.equal((await call(1,other,'trading/submissions','POST',input(f))).status,400);assert.equal((await call(2,f,'trading','GET',undefined,{authorization:'',cookie:'fire_session='+f.cookie})).status,401);assert.equal((await call(1,f,'cash','GET',undefined,{origin:'https://evil.test'})).status,403);assert.deepEqual(economic(f),before);
  const o=await pending(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};afterQuote=()=>app.revokeAppGrant(f.grant.grant_id);const rows=economic(f);assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o))).status,401);assert.deepEqual(economic(f),rows);
 });
 await test('exchange quote clocks handle compact dates, milliseconds, DST and invalid wall times',async()=>{
  assert.equal(trading.tradingQuoteTime('20261013160000','US'),Date.parse('2026-10-13T20:00:00Z'));assert.equal(trading.tradingQuoteTime('2026-10-13 09:30:00.123','HK'),Date.parse('2026-10-13T01:30:00.123Z'));assert.equal(trading.tradingQuoteTime('2026-11-01 01:30:00','US'),null);assert.equal(trading.tradingQuoteTime('2026-03-08 02:30:00','US'),null);assert.equal(trading.tradingQuoteTime('2026-02-30 09:30:00','HK'),null);assert.equal(trading.tradingQuoteTime('bad','US'),null);
  assert.equal(trading.tradingQuoteTime('2026-02-30T09:30:00Z','US'),null);
  assert.equal(trading.tradingQuoteTime('2026/10/13 09:30:00','HK'),Date.parse('2026-10-13T01:30:00Z'));assert.equal(trading.tradingQuoteTime('2026/02/30 09:30:00','HK'),null);
  assert.equal(trading.tradingQuoteTime(null,'HK'),null);assert.equal(trading.tradingQuoteTime(undefined,'US'),null);
 });
 await test('direct Hong Kong conditions consume real Tencent slash-date format and settle in HKD',async()=>{
  const f=fixture();db.prepare("UPDATE records SET market='HK',code='00700' WHERE id=?").run(f.r.id);const r=store.readRecord(f.user.id,f.r.id);assets.declareInstrument(f.user.id,r.id,{requestId:crypto.randomUUID(),recordRevision:r.revision,revision:assets.instrumentSnapshot(f.user.id,r.id).instrument.revision,kind:'cash_equity',listingStatus:'listed'},()=>f.user.id);funds.createFundTransaction({userId:f.user.id,currency:'HKD',type:'opening',amount:1000,direction:1});
  const o=await pending(f),d=JSON.parse(db.prepare('SELECT draft_json FROM app_trade_metadata WHERE order_id=?').get(o.id).draft_json);d.confirmedAt=new Date(Date.now()-2000).toISOString();db.prepare('UPDATE app_trade_metadata SET draft_json=? WHERE order_id=?').run(JSON.stringify(d),o.id);
  quote={price:9,time:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace(/-/g,'/').replace('T',' '),source:'tencent',session:'REGULAR'};
  const reply=await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o));assert.equal(reply.status,200,JSON.stringify(reply));assert.equal(state(f).cash.nativeBalancesByCurrency.HKD,981);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,1000);assert.equal(store.readRecord(f.user.id,f.r.id).qty,12);
 });
 await test('stop-limit activation survives recrossing and fills at its actual later limit price',async()=>{
  const f=fixture(),o=await pending(f,{attachments:{stopLoss:{percent:10,orderType:'limit',limitPrice:12,fees:0},session:'REGULAR',tif:'gtc'}});
  quote={price:10,time:new Date().toISOString(),source:'futu',session:'REGULAR'};assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o))).status,200);
  const id=db.prepare("SELECT order_id FROM app_trade_metadata WHERE parent_id=? AND role='stop_loss'").get(o.id).order_id;let child=state(f).orders.find(x=>x.id===id);
  quote={price:8,time:new Date().toISOString(),source:'futu',session:'REGULAR'};assert.equal((await call(1,f,'trading/orders/'+id+'/observations','POST',observe(f,child))).status,200);child=state(f).orders.find(x=>x.id===id);assert.equal(child.status,'pending');assert(child.triggerStatus.includes('已触发'));
  quote={price:13,time:new Date().toISOString(),source:'futu',session:'REGULAR'};const r=await call(2,f,'trading/orders/'+id+'/observations','POST',observe(f,child));assert.equal(r.status,200,JSON.stringify(r));assert.equal(state(f).orders.find(x=>x.id===id).status,'filled');assert.equal(state(f).cash.nativeBalancesByCurrency.USD,1005);
 });
 await test('day expiry is explicit and quotes cannot overwrite a concurrent financial mutation',async()=>{
  const f=fixture(),o=await pending(f,{tif:'day'}),meta=db.prepare('SELECT draft_json FROM app_trade_metadata WHERE order_id=?').get(o.id);const d=JSON.parse(meta.draft_json);d.confirmedAt='2000-01-01T00:00:00Z';db.prepare('UPDATE app_trade_metadata SET draft_json=? WHERE order_id=?').run(JSON.stringify(d),o.id);const position=store.readRecord(f.user.id,f.r.id),balance=state(f).cash.nativeBalancesByCurrency.USD;
  const r=await call(1,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o));assert.equal(r.status,200);assert.equal(state(f).orders.find(x=>x.id===o.id).status,'expired');assert.deepEqual(store.readRecord(f.user.id,f.r.id),position);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,balance);
  const g=fixture(),p=await pending(g),b=observe(g,p);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};afterQuote=()=>funds.createFundTransaction({userId:g.user.id,currency:'USD',type:'deposit',amount:1,direction:1});assert.equal((await call(2,g,'trading/orders/'+p.id+'/observations','POST',b)).code,40902);assert.equal(state(g).orders.find(x=>x.id===p.id).status,'pending');assert.equal(store.readRecord(g.user.id,g.r.id).qty,10);
 });
 await test('market conditions use server price; duplicate confirmations have exactly one winner',async()=>{
  const f=fixture(),o=await pending(f,{orderType:'market'});quote={price:20,time:new Date().toISOString(),source:'futu',session:'REGULAR'};assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o))).status,200);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,959);assert.equal(state(f).orders.find(x=>x.id===o.id).price,20);
  const g=fixture(),b=input(g),replies=await Promise.all([1,2].map(v=>call(v,g,'trading/submissions','POST',b)));assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal(store.readRecord(g.user.id,g.r.id).qty,12);const receipt=replies.find(r=>r.status===200).data;assert.equal(receipt.data.snapshot.orders,undefined,'receipt must not duplicate all account history');assert.equal(receipt.data.items.length,1);
 });
 await test('invalid calendar dates, quantities below supported precision and stale chronology are rejected',async()=>{
  const f=fixture();for(const over of [{qty:1e-11},{price:1e-11},{fees:1e-11},{tradedAt:'2026-02-30T09:30:00Z'}])assert.equal((await call(2,f,'trading/preview','POST',input(f,over))).status,400);
  assert.equal((await call(2,f,'trading/submissions','POST',input(f))).status,200);const before=economic(f);assert.equal((await call(1,f,'trading/submissions','POST',input(f,{tradedAt:'2000-01-01T00:00:00Z'}))).code,40902);assert.deepEqual(economic(f),before);
 });
 await test('clearing retains verified zero quantity and permits a new buy without guessing missing holdings',async()=>{
  for(const mode of ['record','order']){
   const f=fixture();let r;
   if(mode==='record')r=await call(2,f,'trading/submissions','POST',input(f,{side:'sell',qty:10}));
   else {const o=await pending(f,{side:'sell',qty:10});quote={price:10,time:new Date().toISOString(),source:'futu',session:'REGULAR'};r=await call(2,f,'trading/orders/'+o.id+'/observations','POST',observe(f,o));}
   assert.equal(r.status,200,JSON.stringify(r));assert.equal(store.readRecord(f.user.id,f.r.id).qty,0);assert.equal(state(f).positions[0].qty,0);assert.equal(state(f).positions[0].nativeMarketValue,0);
   r=await call(1,f,'trading/submissions','POST',input(f,{tradedAt:new Date().toISOString()}));assert.equal(r.status,200,JSON.stringify(r));assert.equal(store.readRecord(f.user.id,f.r.id).qty,2);
  }
  const f=fixture();db.prepare('UPDATE records SET qty=NULL WHERE id=?').run(f.r.id);assert.equal((await call(2,f,'trading/preview','POST',input(f))).code,40902);
 });
 await test('malformed observation versions never consume quote-provider work',async()=>{
  const f=fixture(),o=await pending(f);for(const bad of [{orderRevision:0},{recordRevision:-1},{requestId:'bad'},{unexpected:true}])assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',{...observe(f,o),...bad})).status,400);assert.equal(quoteReads,0);assert.equal(state(f).orders.find(x=>x.id===o.id).status,'pending');
 });
 await test('attachment fees, prices, percentages and net settlements obey the same precision limit',async()=>{
  const f=fixture(),before=economic(f);
  for(const balance of [1.000000001,-1.000000001]) assert.equal((await call(2,f,'cash','POST',{requestId:crypto.randomUUID(),accountId:f.user.id,snapshotRevision:state(f).snapshotRevision,currency:'USD',balance})).status,400);
  const leg={percent:10,orderType:'limit',limitPrice:12,fees:0};
  for(const field of ['percent','limitPrice','fees']) {
   const attachments={takeProfit:{...leg,[field]:0.000000001},session:'REGULAR',tif:'gtc'};
   assert.equal((await call(2,f,'trading/preview','POST',input(f,{attachments}))).status,400,field);
  }
  assert.equal((await call(1,f,'trading/preview','POST',input(f,{attachments:{takeProfit:{...leg,fees:0.00000001},session:'REGULAR',tif:'gtc'}}))).status,200);
  db.prepare("UPDATE records SET market='HK',code='00700',account_market='CN' WHERE id=?").run(f.r.id);
  assert.equal((await call(2,f,'trading/preview','POST',input(f,{settlementAmount:1.000000001}))).status,400);
  assert.deepEqual(economic(f).trade_orders,before.trade_orders);assert.deepEqual(economic(f).fund_transactions,before.fund_transactions);
 });
 await test('duplicate observation receipts are rejected before provider work and remain owner scoped',async()=>{
  const f=fixture(),o=await pending(f),b=observe(f,o);
  quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};
  assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',b)).status,200);
  const before=economic(f),receipt=(await call(2,f,'operations/'+b.requestId)).data;
  quoteReads=0;
  assert.equal((await call(1,f,'trading/orders/'+o.id+'/observations','POST',b)).code,40901);
  assert.equal(quoteReads,0);assert.deepEqual(economic(f),before);
  assert.deepEqual((await call(1,f,'operations/'+b.requestId)).data,receipt);
  const other=fixture(),otherOrder=await pending(other);
  quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};
  assert.equal((await call(2,other,'trading/orders/'+otherOrder.id+'/observations','POST',{...observe(other,otherOrder),requestId:b.requestId})).status,200);
  assert.equal(quoteReads,1);
 });
 await test('concurrent observation completion during provider wait cannot execute twice',async()=>{
  const f=fixture(),o=await pending(f),b=observe(f,o);
  quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};
  afterQuote=()=>{assert.equal(trading.observeTrade(f.user.id,o.id,b,quote,()=>f.user.id).error,null);};
  assert.equal((await call(2,f,'trading/orders/'+o.id+'/observations','POST',b)).code,40901);
  assert.equal(store.readRecord(f.user.id,f.r.id).qty,12);assert.equal(state(f).cash.nativeBalancesByCurrency.USD,981);
 });
 await test('legacy history replay cannot rewrite later API receipts and Web hides incompatible actions',async()=>{
  const f=fixture(),old=orders.executeOrder({userId:f.user.id,recordId:f.r.id,side:'buy',qty:1,price:10,fees:0,tradedAt:new Date(Date.now()-2000).toISOString()}).order;
  const React=load('node_modules/react'),render=load('node_modules/react-dom/server').renderToStaticMarkup,Panel=load('components/TradeOrdersPanel.tsx').default;
  const props={onEdit:()=>{},onDelete:()=>{}};assert(render(React.createElement(Panel,{...props,orders:[old]})).includes('>编辑</button>'));
  const receipt=await call(2,f,'trading/submissions','POST',input(f));assert.equal(receipt.status,200);const before=economic(f);
  assert.throws(()=>orders.updateOrder({userId:f.user.id,orderId:old.id,side:'buy',qty:2,price:10,fees:0}),/不能重放历史/);assert.throws(()=>orders.deleteOrder({userId:f.user.id,orderId:old.id}),/不能重放历史/);assert.deepEqual(economic(f),before);
  const rows=orders.listOrders(f.user.id,'all'),locked=rows.find(o=>o.id===old.id),managed=rows.find(o=>o.apiManaged);assert.equal(locked.historyLocked,true);assert.equal(locked.apiManaged,undefined);
  const lockedMarkup=render(React.createElement(Panel,{...props,orders:[locked]}));assert(lockedMarkup.includes('只读'));assert(!lockedMarkup.includes('>编辑</button>'));
  const managedMarkup=render(React.createElement(Panel,{...props,orders:[managed]}));assert(managedMarkup.includes('App 订单'));assert(!managedMarkup.includes('>编辑</button>'));assert(!managedMarkup.includes('title="撤单"'));
 });
 await test('portable backups cannot erase API execution metadata or historical receipts',async()=>{
  const transfer=load('lib/dataTransfer.ts'),source=fixture(),payload=transfer.buildBackupPayload(source.user.id,false),target=fixture();await pending(target);const before=economic(target);
  assert.throws(()=>transfer.buildBackupPayload(target.user.id,false),/完整数据库备份/);assert.throws(()=>transfer.restoreBackupPayload(payload,target.user.id,false),/完整数据库备份/);assert.deepEqual(economic(target),before);
  assert.throws(()=>transfer.validateBackupAccess(payload,target.user.id,false),/完整数据库备份/);
  const response=await load('app/api/v1/data/export/route.ts').GET(new Request(process.env.FIRE_APP_ORIGIN+'/api/v1/data/export',{headers:{cookie:'fire_session='+target.cookie}}));assert.equal(response.status,409);assert((await response.json()).error.includes('完整数据库备份'));
  const backup=path.join(temp,'complete-api-backup.db');await db.backup(backup);const clone=load('node_modules/better-sqlite3')(backup);
  try{for(const [table,where] of [['app_trade_metadata','order_id IN(SELECT id FROM trade_orders WHERE user_id=?)'],['app_asset_order_versions','order_id IN(SELECT id FROM trade_orders WHERE user_id=?)'],['app_asset_operations','user_id=?']]){const sql='SELECT * FROM '+table+' WHERE '+where+' ORDER BY rowid';assert.deepEqual(clone.prepare(sql).all(target.user.id),db.prepare(sql).all(target.user.id));}}finally{clone.close();fs.rmSync(backup,{force:true});}
 });
 await test('Stock Connect portable restore preserves account market, actual CNY cash, and rolls back cash-sync failures',async()=>{
  const transfer=load('lib/dataTransfer.ts'),f=fixture(),target=fixture();db.prepare("UPDATE records SET market='HK',code='00700',account_market='CN' WHERE id=?").run(f.r.id);funds.createFundTransaction({userId:f.user.id,currency:'CNY',type:'opening',amount:1000,direction:1});orders.executeOrder({userId:f.user.id,recordId:f.r.id,side:'buy',qty:2,price:10,fees:1,settlementAmount:19});
  const payload=transfer.buildBackupPayload(f.user.id,false);assert.equal(payload.data.records[0].account_market,'CN');assert.equal(payload.data.tradeOrders[0].settlement_amount,19);
  const before=economic(target),sync=funds.syncOrderCashTransactions;funds.syncOrderCashTransactions=()=>{throw Error('injected cash failure');};try{assert.throws(()=>transfer.restoreBackupPayload(payload,target.user.id,false),/injected cash failure/);assert.deepEqual(economic(target),before);}finally{funds.syncOrderCashTransactions=sync;}
  transfer.restoreBackupPayload(payload,target.user.id,false);const r=store.listRecords(target.user.id).find(r=>r.code==='00700');assert.equal(r.accountMarket,'CN');assert.equal(r.qty,12);const o=orders.listOrders(target.user.id,'all').find(o=>o.code==='00700');assert.equal(o.settlementCurrency,'CNY');assert.equal(o.settlementAmount,19);assert.equal(funds.readFundBalances(target.user.id).CNY,981);assert.equal(funds.readFundBalances(target.user.id).HKD,0);
 });
 const continuous=async(f,over={})=>{const r=await call(2,f,'trading/submissions','POST',input(f,{mode:'order',tradedAt:undefined,...over}),{'X-Alcor-Order-Execution':'continuous-v1'});assert.equal(r.status,200,JSON.stringify(r));return r.data.data.items[0];};
 const tick=()=>load('lib/orderExecutionWorker.ts').orderExecutionTick();
 await test('continuous execution negotiated; legacy orders require reconfirmation',async()=>{
  const f=fixture();for(const v of [1,2]){const req=new Request(process.env.FIRE_APP_ORIGIN+`/api/v${v}/auth/config`,{headers:{'X-Alcor-Order-Execution':'continuous-v1'}});const response=await load(`app/api/v${v}/auth/config/route.ts`).GET(req);assert.equal((await response.json()).data.account_trading.background_execution,true);}
  const o=await pending(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();const old=state(f).orders.find(x=>x.id===o.id);assert.equal(old.status,'pending');assert.equal(old.executionStatus,'待重新确认委托');
 });
 await test('worker fills TSLL-shaped sell once without any page request',async()=>{
  const f=fixture(),o=await continuous(f,{side:'sell',qty:10,price:10.88});assert.equal(o.continuousExecution,true);quote={price:10.91,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();assert.equal(state(f).orders.find(x=>x.id===o.id).status,'filled');assert.equal(store.readRecord(f.user.id,f.r.id).qty,0);const before=economic(f);await tick();assert.deepEqual(economic(f),before);
  const receipts=db.prepare('SELECT result_json FROM app_asset_operations WHERE user_id=?').all(f.user.id).map(r=>JSON.parse(r.result_json));assert.equal(receipts.filter(r=>r.kind==='observe_trade'&&r.state==='completed').length,1);
 });
 await test('worker rejects stale future overnight wrong-session and display-only quotes',async()=>{
  const f=fixture(),o=await continuous(f),before=economic(f);
  for(const q of [{price:9,time:new Date(Date.now()-60000).toISOString(),source:'futu',session:'REGULAR'},{price:9,time:new Date(Date.now()+60000).toISOString(),source:'futu',session:'REGULAR'},{price:9,time:new Date().toISOString(),source:'futu',session:'OVERNIGHT'},{price:9,time:new Date().toISOString(),source:'futu',session:'PRE'},{price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR',displayStale:true}]){quote=q;await tick();assert.deepEqual(economic(f),before);}
  const ext=fixture(),e=await continuous(ext,{session:'EXTENDED'});quote={price:9,time:new Date().toISOString(),source:'futu',session:'PRE'};await tick();assert.equal(state(ext).orders.find(x=>x.id===e.id).status,'filled');assert.equal(state(f).orders.find(x=>x.id===o.id).status,'pending');
 });
 await test('expiry works without provider; GTC preserved and cross-process lease honored',async()=>{
  const f=fixture(),o=await continuous(f,{tif:'day'}),g=await continuous(f,{tif:'gtc'});for(const id of [o.id,g.id])db.prepare("UPDATE app_trade_metadata SET draft_json=json_set(draft_json,'$.confirmedAt',?) WHERE order_id=?").run(new Date(Date.now()-86400000).toISOString(),id);
  db.prepare("UPDATE app_order_worker_lease SET owner='other',until_at=?").run(Date.now()+30000);await tick();assert.equal(state(f).orders.find(x=>x.id===o.id).status,'pending');db.prepare('UPDATE app_order_worker_lease SET until_at=0').run();await tick();assert.equal(state(f).orders.find(x=>x.id===o.id).status,'expired');assert.equal(state(f).orders.find(x=>x.id===g.id).status,'pending');
 });
 await test('revocation during network wait prevents fill',async()=>{
  const f=fixture(),o=await continuous(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};afterQuote=async()=>{app.revokeAppGrant(f.grant.grant_id);};await tick();afterQuote=undefined;const row=state(f).orders.find(x=>x.id===o.id);assert.equal(row.status,'pending');assert.equal(row.executionStatus,'授权失效，执行已暂停');
 });
 await test('amend during quote wait rejects old draft and next scan uses new limit',async()=>{
  const f=fixture(),o=await continuous(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};afterQuote=async()=>{const r=await call(2,f,'trading/orders/'+o.id,'PUT',input(f,{mode:'order',tradedAt:undefined,price:8,orderRevision:o.revision}),{'X-Alcor-Order-Execution':'continuous-v1'});assert.equal(r.status,200);};await tick();afterQuote=undefined;assert.equal(state(f).orders.find(x=>x.id===o.id).status,'pending');quote={price:7,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();assert.equal(state(f).orders.find(x=>x.id===o.id).status,'filled');
 });
 await test('worker OCO inherits grant, latches trigger and cancels sibling',async()=>{
  const f=fixture(),o=await continuous(f,{attachments:{takeProfit:{percent:10,orderType:'limit',limitPrice:12,fees:0},stopLoss:{percent:10,orderType:'market',fees:0},session:'REGULAR',tif:'gtc'}});quote={price:10,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();let children=state(f).orders.filter(x=>x.parentOrderId===o.id);assert.equal(children.length,2);assert(children.every(x=>x.continuousExecution));quote={price:11.5,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();children=state(f).orders.filter(x=>x.parentOrderId===o.id);assert.equal(children.find(x=>x.attachmentRole==='take_profit').triggerStatus,'已触发，等待委托价');quote={price:12,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();assert.deepEqual(state(f).orders.filter(x=>x.parentOrderId===o.id).map(x=>x.status).sort(),['cancelled','filled']);
 });
 await test('cash changes block background fill with a readable reason',async()=>{
  const f=fixture(),o=await continuous(f,{qty:60});funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'withdrawal',amount:990,direction:-1});quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();const r=state(f).orders.find(x=>x.id===o.id);assert.equal(r.status,'pending');assert.match(r.executionStatus,/可用现金/);const before=economic(f);await tick();assert.deepEqual(economic(f),before);
 });
 await test('worker cancellation and security change during read preserve financial data',async()=>{
  const f=fixture(),o=await continuous(f);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};afterQuote=async()=>{db.prepare("UPDATE trade_orders SET status='cancelled' WHERE id=?").run(o.id);};await tick();afterQuote=undefined;assert.equal(state(f).orders.find(x=>x.id===o.id).status,'cancelled');assert.equal(store.readRecord(f.user.id,f.r.id).qty,10);
  const g=fixture(),p=await continuous(g);afterQuote=async()=>{db.prepare("UPDATE users SET password_hash='changed' WHERE id=?").run(g.user.id);};await tick();afterQuote=undefined;assert.equal(state(g).orders.find(x=>x.id===p.id).status,'pending');
 });
 await test('legacy amendment opts in without changing its order number',async()=>{
  const f=fixture(),o=await pending(f);const r=await call(2,f,'trading/orders/'+o.id,'PUT',input(f,{mode:'order',tradedAt:undefined,orderRevision:o.revision}),{'X-Alcor-Order-Execution':'continuous-v1'});assert.equal(r.status,200);const bound=state(f).orders.find(x=>x.id===o.id);assert.equal(bound.continuousExecution,true);assert.equal(bound.orderNo,o.orderNo);quote={price:9,time:new Date().toISOString(),source:'futu',session:'REGULAR'};await tick();assert.equal(state(f).orders.find(x=>x.id===o.id).status,'filled');
 });
 console.log(count+' API trading chain suites passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
