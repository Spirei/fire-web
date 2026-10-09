// Real overview routes and SQLite with synthetic accounts; external data is deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname,'..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id,parent,...rest) { return resolve.call(this,id.startsWith('@/') ? path.join(root,id.slice(2)) : id,parent,...rest); };
require.extensions['.ts'] = (module,filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'alcor-overview-')); process.chdir(temp);
process.env.STOCKLOG_FUTU='off'; global.fetch=async()=>{throw new Error('Network disabled in isolated tests');};
const cardsDir=path.join(temp,'public/uploads/cards'); fs.mkdirSync(cardsDir,{recursive:true});
fs.writeFileSync(path.join(cardsDir,'manifest.json'),JSON.stringify({regions:[{label:'美国',banks:[{cards:[{file:'debit.png',type:'借记卡'},{file:'prepaid.png',type:'预付卡'},{file:'credit.png',type:'信用卡'}]}]}]}));
const load=file=>require(path.join(root,file));
const auth=load('lib/auth.ts'), db=load('lib/db.ts').getDb(), store=load('lib/store.ts');
const funds=load('lib/funds.ts'), simple=load('lib/simpleStore.ts'), cards=load('lib/cardAmounts.ts');
const cash=load('lib/accountCash.ts'), cashStore=load('lib/accountCashStore.ts'), {buildOverview}=load('lib/overview.ts');
let rates={USD:1,HKD:7,CNY:7,JPY:150,KRW:1400,SGD:1.3,GBP:.8,EUR:.9}, quotes={};
const ratesModule=load('lib/rates.ts'), quotesModule=load('lib/quotes.ts');
ratesModule.getRates=async()=>rates; quotesModule.fetchQuotes=async()=>quotes;
quotesModule.fetchOverviewQuotes=async()=>({quotes:await quotesModule.fetchQuotes(),pending:false,cached:[]});
const route=load('app/api/v1/overview/route.ts');
let sequence=0,count=0;
function fixture() {
  const user=auth.createUser('overview_'+(++sequence),'Overview-test-123');
  const record=store.createRecord(user.id,{name:'Synthetic',code:'TEST',market:'US',qty:2,cost:5,price:10,group:'',note:'',source:''});
  const token=auth.createSession(user.id);
  funds.createFundTransaction({userId:user.id,currency:'USD',type:'deposit',amount:100,direction:1});
  for(const [key,amount,currency] of [['debit.png',7,'USD'],['prepaid.png',14,'HKD'],['credit.png',10000,'USD']]) {
    cards.setCardHeld(user.id,key,true); cards.upsertCardAmount(user.id,{cardKey:key,amount,currency});
  }
  return {user,record,token};
}
const request=(token,currency='USD')=>new Request('http://localhost/api/v1/overview?currency='+currency,{headers:{cookie:'fire_session='+token}});
async function overview(f,currency) { const response=await route.GET(request(f.token,currency)); assert.equal(response.status,200); assert.match(response.headers.get('cache-control'),/no-store/); return (await response.json()).data; }
function businessSnapshot() {
  return Object.fromEntries(['users','records','fund_transactions','trade_orders','card_amounts','card_holdings','card_details','custom_cards','user_settings'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
}
async function test(name,run) { rates={USD:1,HKD:7,CNY:7,JPY:150,KRW:1400,SGD:1.3,GBP:.8,EUR:.9}; quotes={}; await run(); count++; console.log('PASS '+name); }
(async()=>{
  await test('canonical total includes signed ledger cash and debit/prepaid balances once, not credit limits',async()=>{
    const f=fixture(), foreign=fixture(); funds.createFundTransaction({userId:foreign.user.id,currency:'USD',type:'deposit',amount:999999,direction:1});
    const before=businessSnapshot(), result=await overview(f);
    assert.equal(result.totalMarket,20); assert.equal(result.totalCash,109); assert.equal(result.totalAsset,129); assert.equal(result.totalAssetComplete,true); assert.equal(result.cashComplete,true); assert.equal(result.complete,true); assert.deepEqual(result.unconvertedCurrencies,[]); assert.deepEqual(businessSnapshot(),before,'overview must not repair or mutate business data');
    const {fundState}=load('lib/fundState.ts'), balances=fundState(f.user.id).balances;
    const web=cash.accountTotals(20,balances,rates,'USD'); assert.equal(web.totalAsset,result.totalAsset); assert.equal(web.totalCash,result.totalCash);
  });
  await test('custom debit cards count but credit limits and another account metadata cannot leak into cash',async()=>{
    const f=fixture(), foreign=fixture(), {createCustomCard}=load('lib/cardCustom.ts');
    for(const [user,key,type,amount] of [[f.user,'/uploads/custom/debit.png','借记卡',5],[f.user,'/uploads/custom/shared.png','信用卡',10000],[foreign.user,'/uploads/custom/shared.png','借记卡',99999]]) {
      createCustomCard(user.id,{name:'Synthetic',bank:'Test',region:'美国',type,brand:'',level:'',image:key,currencyScope:'single'});
      cards.setCardHeld(user.id,key,true); cards.upsertCardAmount(user.id,{cardKey:key,amount,currency:'USD'});
    }
    const result=await overview(f); assert.equal(result.totalCash,114); assert.equal(result.totalAsset,134); assert.equal(result.totalAssetComplete,true);
    assert.equal(cash.accountTotals(20,load('lib/fundState.ts').fundState(f.user.id).balances,rates,'USD').totalAsset,result.totalAsset);
  });
  await test('negative cash and financing reduce total assets, not clamped or counted as profit',async()=>{
    const f=fixture(); funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'withdrawal',amount:150,direction:-1});
    const result=await overview(f); assert.equal(result.totalCash,-41); assert.equal(result.totalAsset,-21); assert.equal(result.totalPnl,10);
  });
  await test('linked imported equity never blocks independent cash or reverse-infers a balance',async()=>{
    const f=fixture(); simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,invest:[{market:'US',cur:'USD',amount:90},{market:'US',cur:'USD',amount:10},{market:'',cur:'USD',amount:99999}]});
    const before=businessSnapshot(), result=await overview(f);assert.equal(result.totalMarket,20);assert.equal(result.totalCash,109);assert.equal(result.totalAsset,129);assert.equal(result.cashSourceComplete,true);assert.deepEqual(result.missingOpeningCashCurrencies,[]);
    quotes={[f.record.id]:{price:30,time:'2026-10-09T00:00:00Z'}};const next=await overview(f);assert.equal(next.totalMarket,60);assert.equal(next.totalCash,109);assert.equal(next.totalAsset,169);assert.deepEqual(businessSnapshot(),before);
    funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'opening',amount:50,direction:1});
    const funded=await overview(f);assert.equal(funded.totalCash,159);assert.equal(funded.totalAsset,219);quotes={[f.record.id]:{price:40,time:'2026-10-09T00:01:00Z'}};const moved=await overview(f);assert.equal(moved.totalCash,159);assert.equal(moved.totalAsset,239);assert.equal(moved.cashValuationIndependent,true);
    funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:5,direction:1});assert.equal((await overview(f)).totalCash,164);
    const snapshot=cashStore.readAccountCash(f.user.id);assert.equal(cash.accountTotals(80,snapshot.balances,rates,'USD').totalAsset,244);
  });
  await test('wrong-currency equity cannot override another settlement balance',async()=>{
    const f=fixture(); simple.setSimpleLedger(f.user.id,{...simple.EMPTY_SIMPLE,invest:[{market:'US',cur:'HKD',amount:9000}]});
    const result=await overview(f); assert.equal(result.totalCash,109); assert.equal(result.totalAsset,129);
  });
  await test('filled order cash is derived read-only; pending, cancelled and stale auto rows do not inflate cash',async()=>{
    const f=fixture(), orders=load('lib/orders.ts');
    const traded=orders.executeOrder({userId:f.user.id,recordId:f.record.id,side:'buy',qty:1,price:6,fees:2}).order;
    db.prepare('DELETE FROM fund_transactions WHERE id=?').run('fund-order-'+traded.id);
    funds.writeFundTransaction({id:'fund-order-missing',userId:f.user.id,currency:'USD',type:'adjustment',amount:9999,direction:1});
    const before=businessSnapshot(), result=await overview(f); assert.equal(result.totalMarket,30); assert.equal(result.totalCash,101); assert.equal(result.totalAsset,131); assert.deepEqual(businessSnapshot(),before);
    funds.syncOrderCashTransactions(f.user.id); assert.deepEqual(funds.readFundBalances(f.user.id),funds.fundBalances(f.user.id),'same canonical amount after explicit legacy repair');
    db.prepare("UPDATE trade_orders SET status='pending' WHERE id=?").run(traded.id);
    assert.equal((await overview(f)).totalCash,109,'pending/reserved cash still belongs to total assets');
    db.prepare("UPDATE trade_orders SET status='cancelled' WHERE id=?").run(traded.id); assert.equal((await overview(f)).totalCash,109);
  });
  await test('FX is applied uniformly and ratios do not change with display currency',async()=>{
    const f=fixture(); const usd=await overview(f), cny=await overview(f,'CNY');
    assert.equal(cny.totalAsset,usd.totalAsset*7); assert.equal(cny.totalCash,usd.totalCash*7); assert.equal(cny.totalMarket,usd.totalMarket*7); assert.equal(cny.totalPnlPct,usd.totalPnlPct); assert.equal(cny.byMarket.US.currency,'CNY');
  });
  await test('missing cash FX is null, not zero/partial cash or a 1:1 converted total',async()=>{
    const f=fixture(); delete rates.HKD; const result=await overview(f);
    assert.equal(result.complete,true,'legacy complete remains securities-only'); assert.equal(result.totalMarket,20); assert.equal(result.cashComplete,false); assert.equal(result.totalAssetComplete,false); assert.equal(result.totalCash,null); assert.equal(result.totalAsset,null); assert.deepEqual(result.unconvertedCurrencies,['HKD']);
  });
  await test('missing holdings FX preserves legacy partial summary but cannot masquerade as total assets',async()=>{
    const f=fixture(), hk=store.createRecord(f.user.id,{name:'Synthetic HK',code:'00001',market:'HK',qty:1,cost:10,price:14,group:'',note:'',source:''});
    cards.setCardHeld(f.user.id,'prepaid.png',false); delete rates.HKD;
    const result=await overview(f); assert.equal(result.complete,false); assert.deepEqual(result.unconverted,[hk.id]); assert.equal(result.totalMarket,20); assert.equal(result.totalAsset,null); assert.equal(result.cashComplete,true); assert.equal(result.totalCash,107); assert.deepEqual(result.unconvertedCurrencies,['HKD']);
  });
  await test('unknown card metadata/currency and corrupt simple sources explicitly fail completeness',async()=>{
    const f=fixture(); cards.setCardHeld(f.user.id,'unregistered.png',true); cards.upsertCardAmount(f.user.id,{cardKey:'unregistered.png',amount:500,currency:'USD'});
    let result=await overview(f); assert.equal(result.totalAsset,null); assert.equal(result.cashComplete,false); assert(result.unconvertedCurrencies.includes('UNKNOWN'));
    const fundState=load('lib/fundState.ts').fundState(f.user.id);
    assert.equal(cash.accountTotals(20,JSON.parse(JSON.stringify(fundState.balances)),rates,'USD').totalAsset,null,'Web cannot treat JSON null from an unavailable card as zero');
    assert(Number.isNaN(cash.reconcileAccountCash({USD:null},{USD:null},[{market:'US',cur:'USD',amount:100}],{US:20}).USD));
    cards.setCardHeld(f.user.id,'unregistered.png',false); cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:500,currency:'RUB'});
    result=await overview(f); assert.equal(result.totalAsset,null); assert(result.unconvertedCurrencies.includes('RUB'));
    cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:7,currency:'USD'});
    for(const value of ['{broken','null','[]','{"invest":{}}','{"invest":[{"market":"US","amount":"invalid"}]}']) {
      db.prepare("INSERT INTO user_settings(user_id,fire,simple) VALUES(?,'{}',?) ON CONFLICT(user_id) DO UPDATE SET simple=excluded.simple").run(f.user.id,value);
      result=await overview(f); assert.equal(result.totalMarket,20); assert.equal(result.cashComplete,false,value); assert.equal(result.totalCash,null); assert.equal(result.totalAsset,null);
    }
  });
  await test('empty accounts, fractional rounding and all holdings beyond a single page stay accurate',async()=>{
    const user=auth.createUser('overview_empty','Overview-test-123'), token=auth.createSession(user.id);
    const empty=await overview({token}); assert.equal(empty.totalAsset,0); assert.equal(empty.totalCash,0); assert.equal(empty.totalAssetComplete,true);
    const record={id:'tiny',market:'US',qty:1,cost:0,price:.004,updatedAt:''};
    const result=buildOverview([record],rates,{},'USD',{balances:{USD:.004},cardCash:{},investmentEquities:[],sourceComplete:true});
    assert.equal(result.totalMarket,0); assert.equal(result.totalCash,0); assert.equal(result.totalAsset,.01,'round the raw sum only once');
    for(let i=0;i<105;i++) store.createRecord(user.id,{name:'Test '+i,code:'T'+i,market:'US',qty:1,cost:1,price:2,group:'',note:'',source:''});
    const all=await overview({token}); assert.equal(all.count,105); assert.equal(all.totalMarket,210); assert.equal(all.totalAsset,210);
  });
  await test('quote fallback uses Web record prices, and global-market currency is shared',async()=>{
    const f=fixture(); store.createRecord(f.user.id,{name:'Synthetic SG',code:'SGT',market:'SG',qty:1,cost:1,price:13,group:'',note:'',source:''});
    const result=await overview(f); assert.equal(result.totalMarket,30); assert.equal(result.totalAsset,139);
    const record={...f.record,price:'',cost:50}; assert.equal(cash.accountHoldingPrice(record,{}),0); assert.equal(buildOverview([record],rates).totalMarket,0); assert.equal(cash.convertAccountAmount(13,cash.ACCOUNT_MARKET_CURRENCY.SG,rates,'USD'),10);
  });
  await test('pending/cache metadata distinguishes record fallback without changing money or quote timestamps',async()=>{
    const f=fixture(), hk=store.createRecord(f.user.id,{name:'Synthetic HK',code:'00001',market:'HK',qty:1,cost:7,price:14,group:'',note:'',source:''});
    const read=quotesModule.fetchOverviewQuotes, before=businessSnapshot();
    quotesModule.fetchOverviewQuotes=async()=>({quotes:{[f.record.id]:{price:12,time:'2026-10-01 23:36:54.780'}},pending:true,cached:[f.record.id,'unrelated-id']});
    try {
      const result=await overview(f); assert.equal(result.totalMarket,26); assert.equal(result.totalAsset,135);
      assert.deepEqual(result.quoteStatus,{pending:true,cached:[f.record.id],missing:[hk.id]});
      assert.equal(result.valuation.find(x=>x.id===f.record.id).source,'quote');
      assert.equal(result.valuation.find(x=>x.id===f.record.id).at,'2026-10-01 23:36:54.780');
      assert.equal(result.valuation.find(x=>x.id===hk.id).source,'record'); assert.deepEqual(businessSnapshot(),before);
      db.prepare('UPDATE records SET qty=0 WHERE id=?').run(f.record.id);
      const closed=await overview(f); assert.deepEqual(closed.quoteStatus,{pending:true,cached:[],missing:[hk.id]});
      assert.equal(closed.valuation.length,1); assert.equal(closed.totalMarket,2);
    } finally { quotesModule.fetchOverviewQuotes=read; }
  });
  await test('fresh positions and cash form one snapshot after async quotes; changed symbols reject old quotes',async()=>{
    const f=fixture(), fetch=quotesModule.fetchQuotes;
    quotesModule.fetchQuotes=async()=>{
      db.prepare("UPDATE records SET code='NEW',qty=3,price=4 WHERE id=?").run(f.record.id);
      funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:5,direction:1});
      return {[f.record.id]:{price:100,time:'stale-symbol'}};
    };
    try { const result=await overview(f); assert.equal(result.totalMarket,12); assert.equal(result.totalCash,114); assert.equal(result.totalAsset,126); assert.equal(result.valuation[0].source,'record'); }
    finally { quotesModule.fetchQuotes=fetch; }
  });
  await test('logout during quote I/O cannot return account data; unsupported currencies reject',async()=>{
    const f=fixture(); assert.equal((await route.GET(request(f.token,'XXX'))).status,400);
    const fetch=quotesModule.fetchQuotes; quotesModule.fetchQuotes=async()=>{auth.deleteSession(f.token);return {};};
    try { const response=await route.GET(request(f.token)); assert.equal(response.status,401); assert.equal((await response.json()).data,undefined); }
    finally { quotesModule.fetchQuotes=fetch; }
    assert.equal((await route.GET(new Request('http://localhost/api/v1/overview'))).status,401);
  });
  await test('unavailable asset storage returns an error, not a zero total or private SQLite diagnostic',async()=>{
    const f=fixture(), read=cashStore.readAccountCash;
    cashStore.readAccountCash=()=>{throw new Error('private SQLite diagnostic');};
    try {
      const response=await route.GET(request(f.token)), body=await response.json(); assert.equal(response.status,500); assert.equal(body.code,50001); assert.equal(body.data,undefined); assert(!JSON.stringify(body).includes('SQLite'));
    } finally { cashStore.readAccountCash=read; }
  });
  const fundsRoute=load('app/api/v1/funds/route.ts');
  const saveCash=(f,body)=>fundsRoute.POST(new Request('http://localhost/api/v1/funds',{method:'POST',headers:{cookie:'fire_session='+f.token,'content-type':'application/json'},body:JSON.stringify({action:'set_balance',...body})}));
  await test('manual cash reconciliation includes bank once and synchronizes overview and allocation',async()=>{
    const f=fixture(), other=fixture(), before=businessSnapshot();
    const response=await saveCash(f,{currency:'USD',expectedBalance:107,targetBalance:200});
    assert.equal(response.status,200); const saved=(await response.json()).data;
    assert.equal(saved.balances.USD,200); assert.equal(saved.cardCash.USD,7);
    assert.equal(saved.transaction.type,'adjustment'); assert.equal(saved.transaction.amount,93); assert.equal(saved.transaction.direction,1);
    const result=await overview(f); assert.equal(result.totalCash,202); assert.equal(result.totalAsset,222);
    const allocation=load('lib/assetAllocation.ts').buildAssetAllocation(f.user.id,rates,{},'USD');
    assert.equal(allocation.summary.totalAsset,222);
    assert.equal(cashStore.readAccountCash(other.user.id).balances.USD,107);
    const after=businessSnapshot(); for(const table of ['records','trade_orders','card_amounts','card_holdings']) assert.deepEqual(after[table],before[table]);
    const again=await saveCash(f,{currency:'USD',expectedBalance:107,targetBalance:200}); assert.equal(again.status,200);
    assert.equal((await again.json()).data.transaction,null); assert.deepEqual(businessSnapshot(),after);
  });
  await test('native zero balance is accepted and does not change another currency or bank record',async()=>{
    const f=fixture(); const response=await saveCash(f,{currency:'USD',expectedBalance:107,targetBalance:0});
    assert.equal(response.status,200); const saved=(await response.json()).data;
    assert.equal(saved.balances.USD,0); assert.equal(saved.balances.HKD,14); assert.equal(saved.cardCash.USD,7);
    assert.equal(saved.transaction.amount,107); assert.equal(saved.transaction.direction,-1);
    assert.equal((await overview(f)).totalCash,2);
  });
  await test('concurrent ledger and bank changes reject stale cash edits without overwriting',async()=>{
    const f=fixture(); funds.createFundTransaction({userId:f.user.id,currency:'USD',type:'deposit',amount:10,direction:1});
    const before=businessSnapshot(); assert.equal((await saveCash(f,{currency:'USD',expectedBalance:107,targetBalance:200})).status,409); assert.deepEqual(businessSnapshot(),before);
    cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:8,currency:'USD'});
    const changed=businessSnapshot(); assert.equal((await saveCash(f,{currency:'USD',expectedBalance:117,targetBalance:200})).status,409); assert.deepEqual(businessSnapshot(),changed);
  });
  await test('cash adjustments remain a ledger entry and later sell proceeds and bank updates still apply',async()=>{
    const f=fixture(); assert.equal((await saveCash(f,{currency:'USD',expectedBalance:107,targetBalance:200})).status,200);
    load('lib/orders.ts').executeOrder({userId:f.user.id,recordId:f.record.id,side:'sell',qty:1,price:12,fees:1});
    assert.equal(cashStore.readAccountCash(f.user.id).balances.USD,211);
    cards.upsertCardAmount(f.user.id,{cardKey:'debit.png',amount:8,currency:'USD'});
    assert.equal(cashStore.readAccountCash(f.user.id).balances.USD,212);
  });
  await test('manual cash edits validate inputs and require an authenticated owner',async()=>{
    const f=fixture(), before=businessSnapshot();
    for(const body of [{currency:'XXX',expectedBalance:107,targetBalance:200},{currency:'USD',expectedBalance:null,targetBalance:200},{currency:'USD',expectedBalance:107,targetBalance:null},{currency:'USD',expectedBalance:107,targetBalance:''},{currency:'USD',expectedBalance:107,targetBalance:-1},{currency:'USD',expectedBalance:107,targetBalance:1e13}]) assert.equal((await saveCash(f,body)).status,400);
    assert.equal((await saveCash({token:'invalid'},{currency:'USD',expectedBalance:107,targetBalance:200})).status,401);
    assert.deepEqual(businessSnapshot(),before);
  });
  console.log(`PASS ${count} canonical account overview suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
