// Production quote adapter + demand pool with synthetic sources and controlled scheduling.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), originalLoad = Module._load, RealDate = Date;
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const { ActiveQuotePool } = require('../lib/activeQuotePool.ts');
const DAY = 86_400_000, timers = new Set();
let now = RealDate.parse('2026-10-05T15:00:00Z'), pool;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const flush = async () => { for (let n = 0; n < 35; n++) await Promise.resolve(); };
async function advance(ms) {
  const end = now + ms; await flush();
  for (let n = 0; ; n++) {
    assert(n < 10000, 'scheduler must not spin');
    const next = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at; timers.delete(next); next.run(); await flush();
  }
  now = end; await flush();
}
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const raw = { name: 'Fixture', price: 100, change: 1, changePct: 1, open: 99, high: 101, low: 98,
  prevClose: 99, time: '2026-10-05 07:15:42.125', session: 'PRE', volume: 0 };
const calls = [];
let load = async rows => new Map(rows.map(row => [row.id, raw]));
let settings = { quoteSource: 'auto', quoteApiUrl: 'https://synthetic.test/', futuHost: 'localhost', futuPort: '11111' };
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
    if (id === './activeQuotePool') return { ActiveQuotePool: class extends ActiveQuotePool {
      constructor(options) { super({ ...options, now: () => now,
        setTimer: (run, delay) => { const timer = { at: now + delay, run, unref() {} }; timers.add(timer); return timer; },
        clearTimer: timer => timers.delete(timer) }); pool = this; }
    } };
    if (id === './settings') return { getSiteSettings: () => settings };
    if (id === './futuQuotes') return { fetchFutuQuotes: async rows => { calls.push(rows); return load(rows); }, searchFutu: async () => [] };
    if (id === './usExtendedQuote') return { fetchUsExtendedQuote: async () => null, fetchUsRegularQuote: async () => null };
    if (id === './assetQuotes') return { getCryptoQuote: async () => null };
    if (id === './net') return { proxyFetch: async () => { throw Error('Unexpected synthetic request'); } };
  }
  return originalLoad.call(this, id, parent, ...rest);
};
global.fetch = async () => { throw Error('No real network permitted'); };
const { fetchQuotes, fetchOverviewQuotes } = require('../lib/quotes.ts');
const item = (id, code = 'AAPL') => ({ id, code, market: 'US' });
let count = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); count++; }
(async () => {
  await test('normalized aliases across users share one demand lease and one upstream quote', async () => {
    const first = await fetchQuotes([item('one', 'aapl.oq'), item('two', 'AAPL.N')]);
    assert.equal(pool.stats().active, 0); assert.equal(pool.stats().candidates, 1);
    assert.equal(calls.length, 1); assert.equal(first.one.price, first.two.price);
    await fetchQuotes([item('different-owner')]); await advance(0);
    assert.equal(pool.stats().active, 1); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [{ market: 'US', code: 'AAPL', id: '["US","AAPL"]' }]);
  });
  await test('independent module entries reuse the process pool and current source callbacks', async () => {
    const firstPool = pool;
    delete require.cache[path.join(root, 'lib/quotes.ts')];
    const otherEntry = require('../lib/quotes.ts');
    await advance(3000);
    const q = (await otherEntry.fetchQuotes([item('other-entry')]))['other-entry'];
    assert.equal(pool, firstPool); assert.equal(calls.length, 1); assert.equal(q.cached, true);
    assert.equal(q.time, raw.time); assert.equal(q.source, 'futu');
  });
  await test('slow scheduled refresh allows fast snapshot reads with original source, time and session', async () => {
    const slow = gate(); load = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, { ...raw, price: 101 }])); };
    await advance(5000); const started = performance.now();
    const q = (await fetchQuotes([item('reader')])).reader;
    assert(performance.now() - started < 100); assert.equal(q.price, 100); assert.equal(q.cached, true);
    assert.equal(q.time, raw.time); assert.equal(q.source, 'futu'); assert.equal(q.session, 'PRE');
    const overview = await fetchOverviewQuotes([item('overview')]);
    assert.equal(overview.pending, true); assert.deepEqual(overview.cached, ['overview']);
    assert.equal(overview.quotes.overview.price, 100); assert.equal(calls.length, 2);
    q.price = -1; assert.equal((await fetchQuotes([item('isolated')])).isolated.price, 100);
    await advance(6000); let tooOldFinished = false;
    const tooOld = fetchQuotes([item('too-old')]).then(q => { tooOldFinished = true; return q; });
    await flush(); assert.equal(tooOldFinished, false); assert.equal(calls.length, 2);
    slow.release(); assert.equal((await tooOld)['too-old'].price, 101); await advance(0);
    const fresh = (await fetchQuotes([item('fresh')])).fresh;
    assert.equal(fresh.price, 101); assert.equal(fresh.cached, undefined); assert.equal(fresh.time, raw.time);
  });
  await test('sleeping symbols stop source requests; a third-day read waits for a new actual price', async () => {
    load = async rows => new Map(rows.map(row => [row.id, raw]));
    await advance(90_000); assert.equal(pool.stats().dormant, 1); const before = calls.length;
    await advance(2 * DAY); assert.equal(calls.length, before);
    const slow = gate(); let completed = false;
    load = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, { ...raw, price: 123, time: '2026-10-07 11:02:03' }])); };
    const read = fetchQuotes([item('third-day')]).then(q => { completed = true; return q; });
    await flush(); assert.equal(completed, false);
    await advance(0); assert.equal(calls.length, before + 1); // Timer joins the foreground lookup.
    slow.release(); const fresh = (await read)['third-day']; await flush();
    assert.equal(fresh.price, 123); assert.equal(fresh.cached, undefined); assert.equal(fresh.time, '2026-10-07 11:02:03');
    await advance(7 * DAY); assert.equal(pool.stats().active, 0); assert.equal(timers.size, 0);
  });
  await test('source changes invalidate prior active snapshots before the next foreground read', async () => {
    load = async rows => new Map(rows.map(row => [row.id, raw]));
    await fetchQuotes([item('initial', 'MSFT')]); await fetchQuotes([item('repeat', 'MSFT')]); await advance(0);
    await advance(3000); settings = { ...settings, quoteApiUrl: 'https://new-source.test/' };
    const slow = gate(); let completed = false;
    load = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, { ...raw, price: 222 }])); };
    const read = fetchQuotes([item('new-source', 'MSFT')]).then(q => { completed = true; return q; });
    await flush(); assert.equal(completed, false); assert.equal(pool.stats().active, 0);
    slow.release(); assert.equal((await read)['new-source'].price, 222);
    pool.dispose(); assert.equal(timers.size, 0);
  });
  console.log(`Active quote adapter review: ${count} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { pool?.dispose(); global.Date = RealDate; Module._load = originalLoad; });
