// Production routes/adapters with deterministic upstreams; never open the application database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
let settings = { futuHost: 'localhost', futuPort: '11111' };
const detailReads = { quotes: 0, rates: 0, cap: 0 };
const load = Module._load;
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/kline.ts')) {
    if (id === './settings') return { getSiteSettings: () => settings };
    if (id === './futuQuotes') return { fetchFutuDailyKline: async () => { throw new Error('Unavailable OpenD'); } };
    if (id === './net') return { proxyFetch: (...args) => fetch(...args) };
  }
  if (parent?.filename === path.join(root, 'app/api/v1/stock-detail/route.ts')) {
    if (id === '@/lib/quotes') return { fetchQuotes: async items => { detailReads.quotes++; return { [items[0].id]: { name: 'Fixture', price: 100, change: 1, marketCap: 200 } }; } };
    if (id === '@/lib/rates') return { getRates: async () => { detailReads.rates++; return { USD: 1, HKD: 7.8 }; } };
    if (id === '@/lib/etfMarketCap') return { resolveEtfMarketCap: async () => { detailReads.cap++; return 200; } };
  }
  return load.call(this, id, parent, ...rest);
};
const { HistoryCache } = require('../lib/historyCache.ts');
const { fetchMonthlyKline } = require('../lib/monthlyKline.ts');
const { fetchDailyKline } = require('../lib/kline.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const monthly = (price = 20) => Response.json({ data: { klines: [`2026-08-31,10,${price},22,9,100`, `2026-09-30,11,${price + 1},23,9,100`] } });
const daily = symbol => Response.json({ data: { [symbol]: { qfqday: [['2026-09-29', '10', '11', '12', '9', '100']] } } });
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
(async () => {
  await test('history cache merges in-flight reads, clones values, expires and bounds capacity', async () => {
    const cache = new HistoryCache(25, 2); let calls = 0;
    const read = () => cache.fetch('a', async () => { calls++; await sleep(5); return [{ c: calls }]; });
    const [a, b] = await Promise.all([read(), read()]);
    assert.equal(calls, 1); a[0].c = 99; assert.equal(b[0].c, 1); assert.equal((await read())[0].c, 1);
    await cache.fetch('b', async () => []); await cache.fetch('c', async () => []);
    assert.equal((await read())[0].c, 2);
    await sleep(30); assert.equal((await read())[0].c, 3);
    await assert.rejects(cache.fetch('failure', async () => { throw new Error('offline'); }));
    assert.equal(await cache.fetch('failure', async () => 10), 10);
  });
  await test('20 monthly requests and Hong Kong aliases share one upstream without mutable cache leakage', async () => {
    let calls = 0;
    global.fetch = async url => { calls++; assert(new URL(url).searchParams.get('secid') === '116.00999'); await sleep(10); return monthly(); };
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => fetchMonthlyKline('HK', i % 2 ? '999' : '00999')));
    assert.equal(calls, 1); results[0].closes[0] = 999;
    assert.deepEqual((await fetchMonthlyKline('HK', '00999')).closes, [20, 21]);
  });
  await test('US exchange probes survive a failed exchange and cancel the losing slow request', async () => {
    let aborted = false; const calls = [];
    global.fetch = async (url, init) => {
      const secid = new URL(url).searchParams.get('secid'); calls.push(secid);
      if (secid === '105.PROBE') return new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
      if (secid === '106.PROBE') throw new Error('Exchange unavailable');
      await sleep(5); return monthly(30);
    };
    assert.deepEqual((await fetchMonthlyKline('US', 'PROBE.AM')).closes, [30, 31]);
    assert.equal(calls.length, 3); assert(aborted);
  });
  await test('Tencent monthly fallback uses close, orders months and removes duplicate or invalid months', async () => {
    global.fetch = async () => Response.json({ data: { jp2001: { month: [
      ['2026-09-30', '100', '31'], ['2026-08-31', '99', '20'], ['2026-09-30', '101', '32'], ['2026-13-01', '1', '50']
    ] } } });
    assert.deepEqual(await fetchMonthlyKline('JP', '2001.T'), { months: ['2026-08', '2026-09'], closes: [20, 32] });
  });
  await test('empty and failed monthly results release the request and can immediately recover', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return Response.json({ data: {} }); };
    await assert.rejects(fetchMonthlyKline('HK', '00998'));
    assert.equal(calls, 2);
    global.fetch = async () => { calls++; return monthly(40); };
    assert.deepEqual((await fetchMonthlyKline('HK', '998')).closes, [40, 41]); assert.equal(calls, 3);
  });
  await test('daily aliases coalesce and source changes bypass old history, including failed benchmark fallback', async () => {
    let calls = 0;
    global.fetch = async url => { calls++; await sleep(5); return daily('hk02800'); };
    const [a, b] = await Promise.all([fetchDailyKline('HK', '2800', 1), fetchDailyKline('HK', '02800', 1)]);
    assert.equal(calls, 1); a[0].c = 999; assert.equal(b[0].c, 11);
    assert.equal((await fetchDailyKline('HK', '02800', 1))[0].c, 11);
    settings = { ...settings, futuPort: '11112' }; await fetchDailyKline('HK', '02800', 1); assert.equal(calls, 2);
  });
  await test('A-share daily history continues to Eastmoney after Tencent fails', async () => {
    const calls = [];
    global.fetch = async url => {
      calls.push(String(url));
      if (String(url).includes('gtimg.cn')) throw new Error('Tencent offline');
      return Response.json({ data: { klines: ['2026-09-29,10,11,12,9,100'] } });
    };
    assert.equal((await fetchDailyKline('CN', '600123', 1))[0].c, 11);
    assert.equal(calls.length, 2);
  });
  await test('history view skips quote/rates/ETF work while the default detail contract stays intact', async () => {
    const { GET } = require('../app/api/v1/stock-detail/route.ts');
    global.fetch = async () => daily('hk00555');
    const response = await GET(new Request('https://fire.test/api/v1/stock-detail?market=HK&code=555&view=history'));
    assert.equal(response.status, 200); assert.equal((await response.json()).data.kline[0].c, 11);
    assert.deepEqual(detailReads, { quotes: 0, rates: 0, cap: 0 });
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    const standard = await GET(new Request('https://fire.test/api/v1/stock-detail?market=HK&code=555&includeKline=0'));
    const body = await standard.json(); assert(body.data.quote); assert(body.data.rates); assert.deepEqual(body.data.kline, []);
    assert.deepEqual(detailReads, { quotes: 1, rates: 1, cap: 0 });
    assert.equal((await GET(new Request('https://fire.test/api/v1/stock-detail?market=HK&code=' + 'A'.repeat(41)))).status, 400);
  });
  await test('monthly route returns retryable upstream errors instead of caching successful empty arrays', async () => {
    const { GET } = require('../app/api/v1/kline/route.ts');
    global.fetch = async () => { throw new Error('offline'); };
    const request = () => new Request('https://fire.test/api/v1/kline?market=HK&code=556');
    const failed = await GET(request()); assert.equal(failed.status, 502); assert.equal((await failed.json()).code, 50002);
    global.fetch = async () => monthly(50);
    assert.deepEqual((await (await GET(request())).json()).data.closes, [50, 51]);
  });
  await test('Web legacy mini-chart and v1 monthly routes use one series and one upstream request', async () => {
    const legacy = require('../app/api/kline/route.ts').GET;
    const modern = require('../app/api/v1/kline/route.ts').GET;
    let calls = 0;
    global.fetch = async () => { calls++; await sleep(5); return monthly(60); };
    const [web, app] = await Promise.all([
      legacy(new Request('https://fire.test/api/kline?market=HK&code=557')),
      modern(new Request('https://fire.test/api/v1/kline?market=HK&code=00557'))
    ]);
    assert.equal(calls, 1); assert.deepEqual((await web.json()).closes, (await app.json()).data.closes.slice(-12));
  });
  console.log(`PASS ${count} history channel suites`);
})().catch(error => { console.error(error); process.exitCode = 1; });
