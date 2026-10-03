// Actual market pool/adapters with gated upstreams; no account DB or real network.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), originalLoad = Module._load;
const RealDate = Date;
// Session tests remain stable on any CI day; TTL/deadlines still use the real clock.
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-03T16:00:00Z'])); } };
let settings = { quoteSource: 'auto', quoteApiUrl: 'https://quote.test/', futuHost: 'localhost', futuPort: '11111' };
let futuLoad = async () => new Map(), yahooLoad = async () => { throw Error('No synthetic Yahoo fixture'); };
const yahooCalls = [];
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
    if (id === './settings') return { getSiteSettings: () => settings };
    if (id === './futuQuotes') return { fetchFutuQuotes: (...args) => futuLoad(...args), searchFutu: async () => [] };
    if (id === './assetQuotes') return { getCryptoQuote: async () => null };
    if (id === './net') return { proxyFetch: async () => { throw Error('Unexpected chart lookup'); } };
  }
  if (parent?.filename === path.join(root, 'lib/usExtendedQuote.ts') && id === './net') return {
    proxyFetch: (...args) => { yahooCalls.push(String(args[0])); return yahooLoad(...args); }
  };
  return originalLoad.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const { fetchQuotes, fetchOverviewQuotes, fetchBatch } = require('../lib/quotes.ts');
const { fetchUsRegularQuote, fetchUsExtendedQuote } = require('../lib/usExtendedQuote.ts');
const { MarketDataPool } = require('../lib/marketDataPool.ts');
const item = (id, code, market = 'US') => ({ id, code, market });
const quote = { name: 'Fixture', price: 100, change: 1, changePct: 1, open: 99, high: 101, low: 98,
  time: '2026-10-01 23:36:54.780', prevClose: 99, session: 'OVERNIGHT', volume: 1 };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = () => new Promise(resolve => setImmediate(resolve));
const tencent = url => {
  const symbol = String(url).split('/').pop(), fields = Array(70).fill('0');
  Object.assign(fields, { 1: 'Fixture', 3: '400', 4: '398', 5: '398', 30: '20261002160000', 31: '2', 32: '.5', 33: '401', 34: '397', 36: '1000' });
  return new Response(`v_${symbol}="${fields.join('~')}";`);
};
global.fetch = async url => tencent(url);
let count = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); count++; }
(async () => {
  await test('published HK symbols release joined readers before mixed US batch finishes', async () => {
    const slow = gate(); let mixedFinished = false;
    futuLoad = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, quote])); };
    const mixed = fetchQuotes([item('us', 'SLOW_US'), item('hk', '09999', 'HK')]).then(q => { mixedFinished = true; return q; });
    for (let n = 0; n < 4; n++) await flush();
    const hk = await Promise.race([fetchQuotes([item('joined-hk', '09999', 'HK')]), sleep(100).then(() => { throw Error('HK blocked by US'); })]);
    assert.equal(hk['joined-hk'].price, 400); assert.equal(mixedFinished, false);
    slow.release(); assert.equal((await mixed).us.session, 'OVERNIGHT');
  });
  await test('six blocked HK symbols do not occupy A-share workers', async () => {
    const slow = gate(); let batchDone = false;
    global.fetch = async url => { if (String(url).includes('hk')) await slow.promise; return tencent(url); };
    const hk = Array.from({length:6},(_,n)=>item('hk-'+n,String(2000+n).padStart(5,'0'),'HK'));
    const mixed = fetchQuotes([...hk,item('cn','002602','CN')]).then(q=>{batchDone=true;return q;});
    for(let n=0;n<4;n++) await flush();
    const cn = await Promise.race([fetchQuotes([item('joined-cn','002602','CN')]),sleep(100).then(()=>{throw Error('A shares blocked by HK');})]);
    assert.equal(cn['joined-cn'].price,400); assert.equal(batchDone,false);
    slow.release(); await mixed; global.fetch=async url=>tencent(url);
  });
  await test('a slow first Tencent symbol does not hold the next wave of the same market', async () => {
    const slow=gate(), seen=[];
    global.fetch=async url=>{seen.push(String(url));if(String(url).endsWith('hk03000'))await slow.promise;return tencent(url);};
    const read=fetchBatch(Array.from({length:7},(_,n)=>'hk'+String(3000+n).padStart(5,'0')));
    for(let n=0;n<4;n++)await flush();
    assert(seen.some(url=>url.endsWith('hk03006'))); slow.release(); assert.equal((await read).size,7);
    global.fetch=async url=>tencent(url);
  });
  await test('overview cold wait is bounded and a late quote warms the next response', async () => {
    const slow = gate(); let calls = 0;
    futuLoad = async rows => { calls++; await slow.promise; return new Map(rows.map(row => [row.id, quote])); };
    const started = performance.now(), snapshot = await fetchOverviewQuotes([item('cold', 'COLD')], 30);
    assert(performance.now() - started < 150); assert.equal(snapshot.pending, true); assert.deepEqual(Object.keys(snapshot.quotes), []);
    slow.release(); await fetchQuotes([item('wait', 'COLD')]);
    const next = await fetchOverviewQuotes([item('other-user-record-id', 'COLD')], 30);
    assert.equal(next.pending, false); assert.equal(next.quotes['other-user-record-id'].time, quote.time); assert.equal(calls, 1);
    assert.deepEqual(Object.keys(next.quotes), ['other-user-record-id']);
  });
  await test('production overview budget returns in 1.5s while the upstream stays unresolved', async () => {
    const slow=gate(); futuLoad=async rows=>{await slow.promise;return new Map(rows.map(row=>[row.id,quote]));};
    const started=performance.now(), snapshot=await fetchOverviewQuotes([item('default-budget','DEFAULT_BUDGET')]);
    const elapsed=performance.now()-started;
    assert(elapsed>=1450&&elapsed<1900); assert.equal(snapshot.pending,true); assert.equal(snapshot.quotes['default-budget'],undefined);
    console.log(`TIMING overview quote wait ${elapsed.toFixed(0)}ms (unresolved upstream)`);
    slow.release(); await fetchQuotes([item('completed','DEFAULT_BUDGET')]);
  });
  await test('overview timeout retains completed fast market while missing market is pending', async () => {
    const slow = gate(); futuLoad = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, quote])); };
    const snapshot = await fetchOverviewQuotes([item('us', 'PARTIAL'), item('hk', '08888', 'HK')], 30);
    assert.equal(snapshot.pending, true); assert.equal(snapshot.quotes.hk.price, 400); assert.equal(snapshot.quotes.us, undefined);
    assert.deepEqual(snapshot.cached, []);
    slow.release(); await fetchQuotes([item('done', 'PARTIAL')]);
  });
  await test('recent cache returns immediately, keeps original timestamp, expires and follows source changes', async () => {
    futuLoad = async rows => new Map(rows.map(row => [row.id, quote]));
    await fetchQuotes([item('initial', 'CACHED')]);
    const realNow = Date.now; let offset = 3000; Date.now = () => realNow() + offset;
    try {
      const slow = gate(); futuLoad = async rows => { await slow.promise; return new Map(rows.map(row => [row.id, { ...quote, price: 101 }])); };
      const started = performance.now(), cached = await fetchOverviewQuotes([item('cached', 'CACHED')], 100);
      assert(performance.now() - started < 50); assert.equal(cached.pending, true); assert.deepEqual(cached.cached, ['cached']);
      assert.equal(cached.quotes.cached.price, 100); assert.equal(cached.quotes.cached.time, quote.time);
      cached.quotes.cached.price = -1;
      offset = 61_000;
      const expired = await fetchOverviewQuotes([item('expired', 'CACHED')], 20);
      assert.equal(expired.quotes.expired, undefined);
      offset = 3000; settings = { ...settings, quoteApiUrl: 'https://changed.test/' };
      const changed = await fetchOverviewQuotes([item('changed', 'CACHED')], 20);
      assert.equal(changed.quotes.changed, undefined);
      slow.release(); await fetchQuotes([item('finish', 'CACHED')]);
    } finally { Date.now = realNow; }
  });
  await test('valid Futu PRE/AFTER/OVERNIGHT quotes skip redundant Yahoo and retain source/time', async () => {
    const before = yahooCalls.length;
    for (const session of ['PRE', 'AFTER', 'OVERNIGHT']) {
      futuLoad = async rows => new Map(rows.map(row => [row.id, { ...quote, session, volume: 0, amount: 0, change: 0, changePct: 0 }]));
      const q = (await fetchQuotes([item('held', 'FUTU_' + session)])).held;
      assert.equal(q.session, session); assert.equal(q.source, 'futu'); assert.equal(q.time, quote.time);
    }
    assert.equal(yahooCalls.length, before);
  });
  await test('Yahoo slow primary is hedged, body reads are bounded and two consumers share one chart', async () => {
    const before = yahooCalls.length; let aborted = 0;
    const timestamp = Date.parse('2026-10-02T23:00:00Z') / 1000;
    yahooLoad = async (url, init) => {
      if (String(url).includes('query1.')) {
        init.signal.addEventListener('abort', () => aborted++, { once: true });
        return { ok: true, json: () => new Promise(() => {}) };
      }
      return Response.json({ chart: { result: [{ timestamp: [timestamp], indicators: { quote: [{ close: [102] }] },
        meta: { regularMarketPrice: 100, regularMarketTime: timestamp - 10800, previousClose: 90 } }] } });
    };
    const started = performance.now();
    const [regular, extended] = await Promise.all([fetchUsRegularQuote('YAHOO_HEDGE'), fetchUsExtendedQuote('YAHOO_HEDGE')]);
    assert(performance.now() - started < 650); assert.equal(regular.price, 100); assert.equal(extended.price, 102);
    assert.equal(yahooCalls.length - before, 2); assert.equal(aborted, 1);
    await fetchUsRegularQuote('YAHOO_HEDGE'); assert.equal(yahooCalls.length - before, 2);
  });
  await test('fast Yahoo primary does not open a duplicate secondary request', async () => {
    const before = yahooCalls.length;
    yahooLoad = async () => Response.json({ chart: { result: [{ meta: { regularMarketPrice: 100, previousClose: 90 } }] } });
    assert.equal((await fetchUsRegularQuote('YAHOO_FAST')).price, 100);
    await sleep(220); assert.equal(yahooCalls.length - before, 1);
  });
  await test('quote batches finish within five seconds even when upstream ignores cancellation', async () => {
    global.fetch = () => new Promise(() => {});
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const started = performance.now(), result = await fetchQuotes([item('blocked', '07777', 'HK')]);
      const elapsed=performance.now()-started;
      assert(elapsed < 5500); assert.deepEqual(Object.keys(result), []);
      console.log(`TIMING total quote wait ${elapsed.toFixed(0)}ms (unresolved upstream)`);
    } finally { clearInterval(keepAlive); global.fetch = async url => tencent(url); }
  });
  await test('late failed batch cannot overwrite a newer published symbol or poison joined reads', async () => {
    const pool = new MarketDataPool(10), slow = gate(); let publish;
    const mixed = pool.fetch([item('a', 'A'), item('b', 'B')], 'source', async (rows, emit) => { publish = () => emit(rows[0], quote); await slow.promise; throw Error('B failed'); }).catch(() => {});
    await flush(); publish(); await sleep(15);
    const fresh = await pool.fetch([item('new', 'A')], 'source', async rows => ({ [rows[0].id]: { ...quote, price: 200 } }));
    assert.equal(fresh.new.price, 200); slow.release(); await mixed;
    assert.equal(pool.peek([item('latest', 'A')], 'source', 60_000).latest.price, 200);
  });
  console.log(`PASS ${count} quote latency suites (isolated upstreams only)`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.Date = RealDate; });
