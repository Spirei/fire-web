const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(name,mocks={}){
 const exports={};const code=ts.transpileModule(fs.readFileSync('lib/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:id=>mocks[id]||{},Intl,Date,Map,Set});return exports;
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
