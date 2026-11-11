const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(name,mocks={}){
 const exports={};const code=ts.transpileModule(fs.readFileSync('lib/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:id=>mocks[id]||(id.startsWith("./")&&fs.existsSync("lib/"+id.slice(2)+".ts")?load(id.slice(2)): {}),Intl,Date,Map,Set});return exports;
}
const ledger=load('portfolioLedger');
const record={id:'r1',qty:10,cost:7,price:11,market:'US'};
const order={id:'o1',recordId:'r1',status:'filled',side:'sell',qty:999,price:100,fees:0,amount:99900,realizedPnl:12.345678,
 positionQtyBefore:100,positionQtyAfter:0,positionCostBefore:1,tradedAt:'2025-01-02T00:00:00Z',createdAt:'2025-01-02T00:00:00Z',market:'US',executionModel:'source_registered_history',historicalCoverageKnown:false};
const value=ledger.buildPortfolioLedger([record],[order],()=>11).get('r1');
assert.equal(value.realizedPnl,12.345678);assert.equal(value.unrealizedPnl,40);assert.equal(value.totalPnl,52.345678);
assert.equal(value.complete,false);assert.equal(value.sourceRegistered,true);
const calendar=load('pnlCalendar',{'./currency':{MARKET_CURRENCY:{US:'USD'}}});
assert.equal(calendar.buildDailyAssetSeries({positions:[record],closesMap:{r1:[{d:'2025-01-02',c:10},{d:'2025-01-03',c:11}]},orders:[order],rates:{USD:1}}).length,0);
console.log('PASS registered P/L survives inconsistent old trade projections; missing opening evidence never becomes an asset curve');
const closed=ledger.buildPortfolioLedger([{...record,qty:0,cost:''}],[order],()=>NaN).get('r1');assert.equal(closed.totalPnl,12.345678);assert.equal(closed.unrealizedPnl,0);
const missing=ledger.buildPortfolioLedger([record],[{...order,realizedPnl:null}],()=>11).get('r1');assert(Number.isNaN(missing.realizedPnl));
assert.equal(calendar.buildDailyAssetSeries({positions:[{...record,market:'HK'}],closesMap:{r1:[{d:'2025-01-02',c:10},{d:'2025-01-03',c:11}]},orders:[],rates:{USD:1}}).length,0,'missing FX cannot create a 1:1 historical curve');

const mixed={...order,market:'HK',realizedPnl:70,realizedPnlCurrency:'CNY'};const hkRecord={...record,market:'HK',qty:0,cost:''};const settled=ledger.buildPortfolioLedger([hkRecord],[mixed],()=>NaN,{USD:1,HKD:8,CNY:7}).get('r1');assert.equal(settled.realizedPnl,80,'registered CNY P/L is converted before adding to HKD position values');assert(Number.isNaN(ledger.buildPortfolioLedger([hkRecord],[mixed],()=>NaN,{USD:1}).get('r1').realizedPnl));
