// Production market pools and adapters, synthetic upstream only; no application database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const originalLoad = Module._load;
let settings = { quoteSource: 'tencent', quoteApiUrl: 'https://quote.test/q=', chartApiUrl: 'https://chart.test/?code={code}', futuHost: 'localhost', futuPort: '11111' };
Module._load = function (id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
    if (id === './settings') return { getSiteSettings: () => settings };
    if (id === './futuQuotes') return { fetchFutuQuotes: async () => new Map(), searchFutu: async () => [] };
    if (id === './usExtendedQuote') return { fetchUsExtendedQuote: async () => null, fetchUsRegularQuote: async () => null };
    if (id === './assetQuotes') return { getCryptoQuote: async () => null };
    if (id === './net') return { proxyFetch: async () => { throw new Error('Synthetic upstream only'); } };
  }
  return originalLoad.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { MarketDataPool } = require('../lib/marketDataPool.ts');
const { fetchQuotes, fetchIntraday } = require('../lib/quotes.ts');
let count = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); count++; }
const item = (id, code = 'AAPL') => ({ id, market: 'US', code });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const value = { price: 200, points: [{ price: 200 }] };
(async () => {
  await test('overlapping batches reuse symbols while retaining each caller record ID', async () => {
    const pool = new MarketDataPool(2000);
    const requests = [];
    const load = async items => { requests.push(items.map(x => x.code)); await sleep(15); return Object.fromEntries(items.map(x => [x.id, value])); };
    const [a, b] = await Promise.all([pool.fetch([item('a'), item('b', 'MSFT')], 'source', load), pool.fetch([item('other'), item('c', 'NVDA')], 'source', load)]);
    assert.deepEqual(Object.keys(a), ['a', 'b']); assert.deepEqual(Object.keys(b), ['other', 'c']);
    assert.equal(requests.flat().filter(code => code === 'AAPL').length, 1);
    assert.deepEqual(requests.flat().sort(), ['AAPL', 'MSFT', 'NVDA']);
    b.other.points[0].price = 1;
    const next = await pool.fetch([item('new')], 'source', load);
    assert.equal(a.a.points[0].price, 200); assert.equal(next.new.points[0].price, 200);
    assert.equal(requests.length, 2);
  });
  await test('changed data sources do not share a cache or pending transfer', async () => {
    const pool = new MarketDataPool(2000); let calls = 0;
    const load = async items => { calls++; await sleep(10); return { [items[0].id]: value }; };
    await Promise.all([pool.fetch([item('a')], 'one', load), pool.fetch([item('a')], 'two', load)]);
    assert.equal(calls, 2);
  });
  await test('lookup IDs contain no source configuration and arbitrary caller keys stay intact', async () => {
    const pool = new MarketDataPool(2000);
    const result = await pool.fetch([item('__proto__')], 'private-source-config', async items => {
      assert(!items[0].id.includes('private-source-config'));
      return { [items[0].id]: value };
    });
    assert.deepEqual(Object.keys(result), ['__proto__']);
    assert.equal(JSON.parse(JSON.stringify(result)).__proto__.price, 200);
  });
  await test('finished cache is bounded and evicted symbols can be loaded again', async () => {
    const pool = new MarketDataPool(2000); let calls = 0;
    const load = async items => { calls++; return Object.fromEntries(items.map(x => [x.id, value])); };
    await pool.fetch(Array.from({ length: 1025 }, (_, index) => item('row-' + index, 'CODE' + index)), 'source', load);
    await pool.fetch([item('first', 'CODE0')], 'source', load);
    assert.equal(calls, 2);
  });
  await test('quotes expire and unavailable or stale data can be retried', async () => {
    const pool = new MarketDataPool(15, value => !value.stale); let calls = 0;
    const load = async items => ({ [items[0].id]: { ...value, price: ++calls } });
    await pool.fetch([item('a')], 'source', load); await sleep(20);
    assert.equal((await pool.fetch([item('a')], 'source', load)).a.price, 2);
    const fresh = new MarketDataPool(2000, value => !value.stale);
    await fresh.fetch([item('a')], 'source', async () => ({}));
    await fresh.fetch([item('a')], 'source', async items => ({ [items[0].id]: { stale: true } }));
    assert.equal((await fresh.fetch([item('a')], 'source', load)).a.price, 3);
  });
  await test('upstream failures release all joined requests for a later retry', async () => {
    const pool = new MarketDataPool(2000); let calls = 0;
    const failing = async () => { calls++; await sleep(10); throw new Error('offline'); };
    const failures = await Promise.allSettled([pool.fetch([item('a')], 'source', failing), pool.fetch([item('b')], 'source', failing)]);
    assert(failures.every(x => x.status === 'rejected')); assert.equal(calls, 1);
    const next = await pool.fetch([item('a')], 'source', async items => ({ [items[0].id]: value }));
    assert.equal(next.a.price, 200);
  });
  await test('production quote adapter deduplicates aliases and protects enriched values', async () => {
    const calls = [];
    global.fetch = async url => {
      calls.push(String(url)); await sleep(15);
      const fields = Array(70).fill('0');
      Object.assign(fields, { 1: 'Tencent', 3: '400', 4: '398', 5: '398', 30: '20260930093000', 31: '2', 32: '0.5', 33: '401', 34: '397', 36: '1000', 37: '400000' });
      return new Response(`v_hk00700="${fields.join('~')}";`);
    };
    const [a, b] = await Promise.all([fetchQuotes([{ id: 'web', market: 'HK', code: '700' }]), fetchQuotes([{ id: 'app', market: 'HK', code: '00700' }])]);
    assert.equal(calls.length, 1); assert.equal(a.web.price, b.app.price);
    a.web.marketCap = 123;
    assert.equal((await fetchQuotes([{ id: 'other', market: 'HK', code: '00700' }])).other.marketCap, undefined);
    settings = { ...settings, quoteApiUrl: 'https://changed.test/q=' };
    await fetchQuotes([{ id: 'web', market: 'HK', code: '00700' }]);
    assert.equal(calls.length, 2); assert(calls[1].startsWith(settings.quoteApiUrl));
    const empty = await fetchQuotes([{ id: 'cash-hk', market: 'HK', code: '' }, { id: 'cash-cn', market: 'CN', code: '' }]);
    assert.equal(Object.keys(empty).length, 0); assert.equal(calls.length, 2);
  });
  await test('production chart adapter joins duplicate reads and follows a changed endpoint immediately', async () => {
    const calls = [];
    global.fetch = async url => {
      calls.push(String(url)); await sleep(15);
      return Response.json({ data: { hk00700: { data: { date: '20260930', data: ['09:30 400 10', '09:31 401 20'] } } } });
    };
    const [a, b] = await Promise.all([fetchIntraday([{ id: 'web', market: 'HK', code: '700' }]), fetchIntraday([{ id: 'app', market: 'HK', code: '00700' }])]);
    assert.equal(calls.length, 1); assert.equal(a.web.points.length, 2); assert.equal(b.app.points.length, 2);
    a.web.points[0].price = 1;
    assert.equal((await fetchIntraday([{ id: 'other', market: 'HK', code: '00700' }])).other.points[0].price, 400);
    settings = { ...settings, chartApiUrl: 'https://changed-chart.test/?code={code}' };
    await fetchIntraday([{ id: 'web', market: 'HK', code: '00700' }]);
    assert.equal(calls.length, 2); assert(calls[1].startsWith('https://changed-chart.test/'));
  });
  console.log(`PASS ${count} market channel suites`);
})().catch(error => { console.error(error); process.exitCode = 1; });
