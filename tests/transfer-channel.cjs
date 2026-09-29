// Real transfer helpers and adapters; synthetic upstream + in-memory ETF rows only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { gunzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const rows = new Map(); let dbReads = 0, enrichmentCalls = 0;
const db = { prepare(sql) { return {
  get(code) { dbReads++; return rows.get(code); },
  run(code, shares, market_cap, fetched_at) { assert(sql.startsWith('INSERT')); rows.set(code, { shares, market_cap, fetched_at }); }
}; } };
const load = Module._load;
let samples;
const points = Array.from({ length: 940 }, (_, index) => ({ time: String(index), price: index === 9 ? 1200 : index === 899 ? 50 : 100 + index % 10 }));
const chart = { date: '20260930', points };
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
    if (id === './settings') return { getSiteSettings: () => ({}) };
    if (id === './futuQuotes') return {};
    if (id === './usExtendedQuote' || id === './assetQuotes') return {};
    if (id === './net') return {};
  }
  if (parent?.filename === path.join(root, 'lib/etfMarketCap.ts')) {
    if (id === './db') return { getDb: () => db };
    if (id === './net') return { proxyFetch: (...args) => fetch(...args) };
  }
  if (parent?.filename.includes('/app/api/') && /\/(quotes|charts)\/route\.ts$/.test(parent.filename)) {
    if (id === '@/lib/rateLimit') return { clientIp: () => 'fixture', rateLimit: () => true, rateLimitGlobal: () => true };
    if (id === '@/lib/store') return { parseMarket: value => value || 'US' };
    if (id === '@/lib/quotes') return {
      samplePoints: samples,
      fetchIntraday: async items => Object.fromEntries(items.map(item => [item.id, structuredClone(chart)])),
      fetchQuotes: async items => Object.fromEntries(items.map(item => [item.id, { name: item.code, price: 100, change: 1, changePct: 1, open: 99, high: 101, low: 98, time: '20260930' }]))
    };
    if (id === '@/lib/etfMarketCap') {
      const actual = load.call(this, path.join(root, 'lib/etfMarketCap.ts'), parent, ...rest);
      return { ...actual, fillEtfMarketCaps: async (...args) => { enrichmentCalls++; return actual.fillEtfMarketCaps(...args); } };
    }
  }
  return load.call(this, id, parent, ...rest);
};
samples = require('../lib/quotes.ts').samplePoints;
const { readQuoteBatches, applyQuoteBatches, quoteInstrumentKey, restoreQuoteSnapshot } = require('../lib/quoteBatches.ts');
const { resolveEtfMarketCap, fillEtfMarketCaps } = require('../lib/etfMarketCap.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
async function test(name, run) { await run(); count++; console.log('PASS ' + name); }
const item = (id, code = 'AAPL') => ({ id, market: 'US', code });
const request = (path, items, fields = {}, encoding = '') => new Request('https://fire.test/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': encoding }, body: JSON.stringify({ items, ...fields }) });
(async () => {
  await test('Web batches roll with two transfers and retain failed-batch prices', async () => {
    const items = Array.from({ length: 301 }, (_, i) => item(String(i)));
    let active = 0, peak = 0, calls = 0;
    global.fetch = async (_, init) => {
      const body = JSON.parse(init.body); assert.equal(body.includeMarketCap, false); assert(body.items.length <= 100);
      active++; peak = Math.max(peak, active); calls++; await sleep(5); active--;
      if (body.items[0].id === '0') return new Response('unavailable', { status: 503 });
      return Response.json({ quotes: Object.fromEntries(body.items.map(item => [item.id, { price: 200 }])) });
    };
    const result = await readQuoteBatches(items);
    assert.equal(calls, 4); assert.equal(peak, 2); assert.equal(result.completed.size, 201);
    const applied = applyQuoteBatches({ '0': { price: 99 }, '100': { price: 100 } }, result, items, items);
    assert.equal(applied['0'].price, 99); assert.equal(applied['100'].price, 200);
  });
  await test('changed/deleted instruments reject late prices; unavailable prices affect only completed batches', async () => {
    const before = [item('changed'), item('deleted'), item('missing'), item('failed')];
    const result = { quotes: { changed: { price: 200 }, deleted: { price: 200 } }, completed: new Set(['changed', 'deleted', 'missing']) };
    const applied = applyQuoteBatches(Object.fromEntries(before.map(x => [x.id, { price: 100 }])), result, before, [item('changed', 'MSFT'), item('missing'), item('failed')]);
    assert.equal(applied.changed, undefined); assert.equal(applied.deleted, undefined); assert.equal(applied.missing, undefined); assert.equal(applied.failed.price, 100);
    assert.notEqual(quoteInstrumentKey(item('changed')), quoteInstrumentKey(item('changed', 'MSFT')));
    assert.equal(quoteInstrumentKey(item('alias', 'AAPL.OQ')), quoteInstrumentKey(item('alias')));
    const proto = applyQuoteBatches({}, { quotes: { ['__proto__']: { price: 100 } }, completed: new Set(['__proto__']) }, [item('__proto__')], [item('__proto__')]);
    assert.equal(JSON.parse(JSON.stringify(proto)).__proto__.price, 100);
  });
  await test('cancellation ends both active reads and starts no remaining batch', async () => {
    let calls = 0;
    global.fetch = async (_, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); };
    const controller = new AbortController();
    const pending = readQuoteBatches(Array.from({ length: 400 }, (_, i) => item(String(i))), controller.signal);
    await sleep(5); controller.abort(); await assert.rejects(pending); assert.equal(calls, 2);
  });
  await test('restored snapshots match current instruments and reject corrupt prices or missing identity', async () => {
    const previous = [item('same'), item('changed'), item('removed'), item('broken')];
    const quotes = { same: { price: 100 }, changed: { price: 100 }, removed: { price: 100 }, broken: { price: 0 } };
    const identities = Object.fromEntries(previous.map(x => [x.id, quoteInstrumentKey(x)]));
    const current = [item('same', 'AAPL.OQ'), item('changed', 'TSLA'), item('broken')];
    const restored = restoreQuoteSnapshot(quotes, identities, current);
    assert.deepEqual(Object.keys(restored), ['same']); assert.equal(restored.same.price, 100);
    assert.equal(Object.keys(restoreQuoteSnapshot(quotes, undefined, current)).length, 0);
  });
  await test('ETF readers share one upstream while retaining caller-specific prices', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; await sleep(5); return new Response('sharesOut:"10M" aum:"2B"'); };
    const caps = await Promise.all(Array.from({ length: 20 }, (_, i) => resolveEtfMarketCap('US', i % 2 ? 'SHARED.AM' : 'SHARED', 100 + i)));
    assert.equal(calls, 1); caps.forEach((cap, i) => assert.equal(cap, (100 + i) * 10e6));
  });
  await test('batch ETF enrichment honors expiry and negative TTL; budget counts unique symbols', async () => {
    rows.set('EXPIRED', { shares: 10, market_cap: 1000, fetched_at: Date.now() - 25 * 3600e3 });
    rows.set('NEGATIVE', { shares: null, market_cap: null, fetched_at: Date.now() });
    let calls = 0;
    global.fetch = async () => { calls++; return new Response('sharesOut:"20"'); };
    const items = [item('expired', 'EXPIRED'), item('negative', 'NEGATIVE')];
    const quotes = { expired: { price: 100 }, negative: { price: 100 } };
    await fillEtfMarketCaps(items, quotes); assert.equal(quotes.expired.marketCap, 2000); assert.equal(quotes.negative.marketCap, undefined); assert.equal(calls, 1);
    const duplicates = Array.from({ length: 20 }, (_, i) => item('dup' + i, i % 2 ? 'DUP.AM' : 'DUP'));
    const unique = Array.from({ length: 12 }, (_, i) => item('unique' + i, 'UNIQUE' + i));
    const all = [...duplicates, ...unique], values = Object.fromEntries(all.map(item => [item.id, { price: 100 }]));
    await fillEtfMarketCaps(all, values); assert.equal(calls, 13); assert.equal(values.dup19.marketCap, 2000); assert.equal(values.unique11.marketCap, undefined);
  });
  await test('price-only v1 and legacy quotes bypass ETF work; default full quotes remain compatible', async () => {
    const modern = require('../app/api/v1/quotes/route.ts').POST, legacy = require('../app/api/quotes/route.ts').POST;
    enrichmentCalls = 0; dbReads = 0;
    await modern(request('v1/quotes', [item('app', 'PRICEONLY')], { includeMarketCap: false }));
    await legacy(request('quotes', [item('web', 'PRICEONLY')], { includeMarketCap: false }));
    assert.equal(enrichmentCalls, 0); assert.equal(dbReads, 0);
    global.fetch = async () => new Response('sharesOut:"20"');
    const full = await modern(request('v1/quotes', [item('detail', 'FULL')]));
    assert.equal(enrichmentCalls, 1); assert.equal((await full.json()).data.quotes.detail.marketCap, 2000);
  });
  await test('v1 mini charts retain extrema and endpoints while full charts retain all points', async () => {
    const { POST } = require('../app/api/v1/charts/route.ts');
    const mini = (await (await POST(request('v1/charts', [item('mini')], { sample: true }))).json()).data.charts.mini.points;
    assert(mini.length <= 60); assert.deepEqual(mini[0], points[0]); assert.deepEqual(mini.at(-1), points.at(-1));
    assert(mini.some(x => x.price === 1200) && mini.some(x => x.price === 50));
    const full = await POST(request('v1/charts', [item('detail')]));
    assert.equal((await full.json()).data.charts.detail.points.length, 940);
  });
  await test('gzip preserves the envelope, respects q=0 and shrinks actual chart JSON', async () => {
    const { POST } = require('../app/api/v1/charts/route.ts');
    const items = Array.from({ length: 14 }, (_, i) => item(String(i)));
    const plain = await POST(request('v1/charts', items));
    const bytes = Buffer.from(await plain.arrayBuffer());
    const gzip = await POST(request('v1/charts', items, {}, 'br, gzip;q=0.8'));
    const packed = Buffer.from(await gzip.arrayBuffer());
    assert.equal(gzip.headers.get('content-encoding'), 'gzip'); assert.equal(gzip.headers.get('vary'), 'Accept-Encoding');
    assert.equal(gzip.headers.get('cache-control'), 'no-store, private'); assert.deepEqual(gunzipSync(packed), bytes); assert(packed.length < bytes.length / 4);
    const disabled = await POST(request('v1/charts', items, {}, 'gzip;q=0'));
    assert.equal(disabled.headers.get('content-encoding'), null);
    const mini = await POST(request('v1/charts', items, { sample: true }));
    const miniBytes = Buffer.from(await mini.arrayBuffer()); assert(miniBytes.length < bytes.length / 10);
    console.log(`BENCH fixture chart payload: full=${bytes.length}B mini=${miniBytes.length}B gzip=${packed.length}B`);
  });
  console.log(`PASS ${count} transfer channel suites`);
})().catch(error => { console.error(error); process.exitCode = 1; });
