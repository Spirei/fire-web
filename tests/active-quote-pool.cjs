// Real demand scheduler with a controlled clock: no network, account or database writes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { ActiveQuotePool } = require('../lib/activeQuotePool.ts');
const DAY = 86_400_000;
const item = (code = 'AAPL', market = 'US', id = 'private-record') => ({ id, code, market });
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const result = rows => Object.fromEntries(rows.map(row => [row.id, { price: 100 }]));
function clock(initial = 0) {
  let now = initial, unrefs = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer: (run, delay) => { const timer = { at: now + delay, run, unref: () => unrefs++ }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    size: () => timers.size, unrefs: () => unrefs,
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (let n = 0; ; n++) {
        assert(n < 10000, 'scheduler must not spin');
        const next = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; timers.delete(next); next.run(); await flush();
      }
      now = end; await flush();
    }
  };
}
function harness(options = {}) {
  const time = clock(), calls = [];
  let namespace = 'source', phase = 'REGULAR', interval = 5000;
  const pool = new ActiveQuotePool({
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    currentNamespace: () => namespace,
    policy: () => ({ intervalMs: interval, phase }),
    refresh: async (rows, source) => { calls.push({ at: time.now(), rows, source }); return result(rows); },
    ...options
  });
  return { pool, time, calls, observe: rows => pool.observe(rows, namespace),
    activate: rows => { pool.observe(rows, namespace); pool.observe(rows, namespace); },
    namespace: next => { namespace = next; }, phase: next => { phase = next; }, interval: next => { interval = next; } };
}
let count = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); count++; }
(async () => {
  await test('duplicate rows within one request do not activate; only public market/code enter jobs', async () => {
    const h = harness();
    h.observe([{ ...item(), quantity: 999, account: 'secret' }, item('AAPL', 'US', 'other-owner')]);
    assert.equal(h.pool.stats().active, 0); assert.equal(h.pool.stats().candidates, 1);
    h.observe([item('AAPL', 'US', 'different-user')]); await h.time.advance(0);
    assert.deepEqual(h.calls[0].rows, [{ market: 'US', code: 'AAPL', id: '["US","AAPL"]' }]);
    assert(h.time.unrefs() > 0); h.pool.dispose();
  });
  await test('morning, afternoon and third-day reads resume a retained security', async () => {
    const h = harness(); h.observe([item()]); await h.time.advance(6 * 60 * 60 * 1000);
    assert.equal(h.pool.stats().candidates, 1);
    h.observe([item()]); await h.time.advance(0); assert.equal(h.calls.length, 1);
    await h.time.advance(90_000); assert.equal(h.pool.stats().dormant, 1); const asleepCalls = h.calls.length;
    assert.equal(h.pool.cacheAge(item(), 'source'), undefined);
    await h.time.advance(2 * DAY); assert.equal(h.calls.length, asleepCalls);
    h.observe([item()]); await h.time.advance(0);
    assert.equal(h.pool.stats().hot, 1); assert.equal(h.calls.length, asleepCalls + 1);
    h.pool.dispose();
  });
  await test('background refresh never renews seven-day retention; final entry releases its timer', async () => {
    const h = harness(); h.activate([item()]); await h.time.advance(90_000);
    const calls = h.calls.length; assert.equal(calls, 18); assert.equal(h.pool.stats().dormant, 1);
    await h.time.advance(7 * DAY - 90_001); assert.equal(h.pool.stats().active, 1);
    await h.time.advance(1); assert.equal(h.pool.stats().active, 0);
    assert.equal(h.calls.length, calls); assert.equal(h.time.size(), 0); assert.equal(h.pool.stats().timerArmed, false);
  });
  await test('external requests renew only their security; expiry needs no new request', async () => {
    const h = harness(); h.activate([item('AAPL'), item('MSFT')]);
    await h.time.advance(6 * DAY); h.observe([item('AAPL')]); await h.time.advance(DAY);
    assert.equal(h.pool.stats().active, 1);
    await h.time.advance(6 * DAY); assert.equal(h.pool.stats().active, 0); assert.equal(h.time.size(), 0);
  });
  await test('unused first-request candidates expire after seven days without any source polling', async () => {
    const h = harness(); h.observe([item()]); await h.time.advance(7 * DAY);
    assert.equal(h.pool.stats().candidates, 0); assert.equal(h.calls.length, 0); assert.equal(h.time.size(), 0);
  });
  await test('closed-market cadence is slower and continuous readers keep demand active', async () => {
    const h = harness(); h.interval(60_000); h.activate([item()]); await h.time.advance(60_000);
    assert.deepEqual(h.calls.map(c => c.at), [0, 60_000]);
    h.observe([item()]); await h.time.advance(60_000); assert.equal(h.pool.stats().hot, 1);
    assert.deepEqual(h.calls.map(c => c.at), [0, 60_000, 120_000]); h.pool.dispose();
    const asset = harness(); asset.interval(10_000); asset.activate([item('BTC', 'ASSET')]); await asset.time.advance(90_000);
    assert.equal(asset.calls.length, 9); assert.equal(asset.pool.stats().dormant, 1); asset.pool.dispose();
  });
  await test('market jobs run independently and do not overlap within one market', async () => {
    const us = gate(), seen = [];
    const h = harness({ refresh: async rows => { seen.push(rows[0].market); if (rows[0].market === 'US') await us.promise; return result(rows); } });
    h.activate([item(), item('00700', 'HK'), item('002602', 'CN')]); await h.time.advance(15_000);
    assert.equal(seen.filter(m => m === 'US').length, 1);
    assert.equal(seen.filter(m => m === 'HK').length, 4); assert.equal(seen.filter(m => m === 'CN').length, 4);
    us.release(); await flush(); h.pool.dispose(); assert.equal(h.time.size(), 0);
  });
  await test('late results cannot recreate expired securities or alter a new lease', async () => {
    const slow = gate(); let calls = 0;
    const h = harness({ idleMs: 100, hotMs: 50, refresh: async rows => { calls++; await slow.promise; return result(rows); } });
    h.activate([item()]); await h.time.advance(100); assert.equal(h.pool.stats().active, 0);
    h.activate([item()]); slow.release(); await flush(); await h.time.advance(0);
    assert.equal(calls, 2); assert.equal(h.pool.stats().active, 1);
    await h.time.advance(100); assert.equal(h.pool.stats().active, 0); assert.equal(h.time.size(), 0);
  });
  await test('failure backoff avoids retry storms and successful reads restore the interval', async () => {
    let failed = true; const seen = [];
    const h = harness({ refresh: async rows => { seen.push(h.time.now()); if (failed) throw Error('upstream'); return result(rows); } });
    h.activate([item()]); await h.time.advance(30_000); assert.deepEqual(seen, [0, 10_000, 30_000]);
    failed = false; await h.time.advance(45_000); assert.deepEqual(seen, [0, 10_000, 30_000, 70_000, 75_000]);
    h.pool.dispose();
  });
  await test('changed sessions reject prior hot cache and late prior-session completion', async () => {
    const slow = gate(); let calls = 0;
    const h = harness({ refresh: async rows => { if (++calls === 1) await slow.promise; return result(rows); } });
    h.activate([item()]); await h.time.advance(0); h.phase('AFTER');
    assert.equal(h.pool.cacheAge(item(), 'source'), undefined);
    slow.release(); await flush(); assert.equal(h.pool.cacheAge(item(), 'source'), undefined);
    await h.time.advance(0); assert.equal(calls, 2); assert.equal(h.pool.cacheAge(item(), 'source'), 10_000);
    h.pool.dispose();
  });
  await test('session changes between first and repeated request require a new refresh', async () => {
    const h = harness(); h.observe([item()]); h.phase('AFTER'); h.observe([item()]);
    assert.equal(h.pool.cacheAge(item(), 'source'), undefined);
    await h.time.advance(0); assert.equal(h.pool.cacheAge(item(), 'source'), 10_000);
    h.interval(60_000); assert.equal(h.pool.cacheAge(item(), 'source'), 60_000); h.pool.dispose();
  });
  await test('source reset discards demand and old completions cannot remove the new market job', async () => {
    const old = gate(), current = gate();
    const h = harness({ refresh: async (rows, source) => { await (source === 'source' ? old : current).promise; return result(rows); } });
    h.activate([item()]); await h.time.advance(0);
    h.namespace('changed'); h.activate([item()]); await h.time.advance(0);
    assert.equal(h.pool.cacheAge(item(), 'source'), undefined);
    old.release(); await flush(); assert.equal(h.pool.stats().refreshing, 1);
    current.release(); await flush(); assert.equal(h.pool.stats().refreshing, 0); h.pool.dispose();
  });
  await test('timer detects source changes without foreground reads; broken settings stop scheduling', async () => {
    const h = harness(); h.activate([item()]); await h.time.advance(0); h.namespace('changed');
    await h.time.advance(5000); assert.equal(h.pool.stats().active, 0); assert.equal(h.time.size(), 0);
    const broken = harness({ currentNamespace: () => { throw Error('settings unavailable'); } });
    broken.activate([item()]); await broken.time.advance(0); assert.equal(broken.pool.stats().active, 0); assert.equal(broken.time.size(), 0);
  });
  await test('capacity is bounded and current readers displace the oldest dormant security', async () => {
    const h = harness({ capacity: 2, candidateCapacity: 3 });
    h.activate([item('AAPL'), item('MSFT')]); await h.time.advance(90_000);
    h.activate([item('NVDA')]); await h.time.advance(0);
    assert.equal(h.pool.stats().active, 2); h.observe([item('AAPL')]); assert.equal(h.pool.stats().candidates, 1);
    h.observe(['X1', 'X2', 'X3', 'X4'].map(code => item(code))); assert.equal(h.pool.stats().candidates, 3);
    h.pool.dispose(); h.activate([item()]); assert.equal(h.pool.stats().active, 0); assert.equal(h.time.size(), 0);
  });
  await test('per-market batches are bounded and all due securities receive a fair turn', async () => {
    const h = harness(); h.activate(Array.from({ length: 45 }, (_, n) => item('CODE' + n))); await h.time.advance(0);
    assert.deepEqual(h.calls.map(c => c.rows.length), [20, 20, 5]);
    assert.equal(new Set(h.calls.flatMap(c => c.rows.map(row => row.code))).size, 45);
    h.pool.dispose();
  });
  console.log(`Active quote demand review: ${count} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
