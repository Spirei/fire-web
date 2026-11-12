const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {}; cache.set(name, exports);
  const file = path.resolve('lib', name + '.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: id => load(id.replace('./', '')), Number, localStorage: {
    getItem: key => key === 'fire:rates' ? JSON.stringify({USD:1,HKD:7.85,CNY:7.2}) : null,
    setItem: () => {}
  }});
  return exports;
}
const {positionFigures, accountHoldingPrice, convertAccountAmount, positionWeight} = load('accountCash');
const r = {id:'one',market:'US',code:'AAPL',qty:10,cost:20,price:25};
let f = positionFigures(r, {});
assert.equal(f.marketValue,250); assert.equal(f.costValue,200); assert.equal(f.holdingPnl,50);
assert(Number.isNaN(f.dayPnl), 'absence of a day observation is not zero daily profit');
f = positionFigures({...r,cost:0}, {one:{price:30,change:0}});
assert.equal(f.holdingPnl,300,'a recorded zero cost is valid'); assert.equal(f.dayPnl,0);
f = positionFigures({...r,cost:-5}, {one:{price:30,change:2}});
assert.equal(f.holdingPnl,350,'negative diluted costs are preserved'); assert.equal(f.dayPnl,20);
for (const price of [0,'',null,undefined,NaN,-1]) {
  assert(Number.isNaN(accountHoldingPrice({...r,price},{})), 'an unfilled mark is not a zero valuation');
}
f = positionFigures({...r,cost:''},{one:{price:30,change:2}});
assert.equal(f.marketValue,300); assert(Number.isNaN(f.holdingPnl));
assert.equal(convertAccountAmount(100,'HKD',{},'HKD'),100,'native values require no FX observation');
assert(Number.isNaN(convertAccountAmount(100,'HKD',{USD:1},'USD')));
assert.equal(convertAccountAmount(100,'HKD',{USD:1,HKD:8},'USD'),12.5);
assert.equal(positionWeight(25,100),.25);
assert.equal(positionWeight(0,100),0);
for(const total of [NaN,Infinity,0,-1]) assert(Number.isNaN(positionWeight(25,total)),'missing totals and FX must not become zero shares');
assert(Number.isNaN(positionWeight(NaN,100)));
const rates = load('ratesCache');
assert.equal(rates.readCachedRates(),null,'old mixed guessed-rate caches cannot be restored');
assert.deepEqual(Object.keys(rates.normalizeCachedRates({USD:1})),['USD']);
assert.equal(rates.normalizeCachedRates({USD:1,HKD:8}).CNY,undefined);
const {fmtPct} = load('format');
for (const missing of [NaN,Infinity,-Infinity]) assert.equal(fmtPct(missing),'—');
assert.equal(fmtPct(0),'0.00%');
console.log('PASS independent position values, unknown marks/daily change, zero/negative cost and observed-only FX');
