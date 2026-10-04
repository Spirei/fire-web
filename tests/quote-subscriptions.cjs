// Durable private leases + real public scheduler; all databases are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), ts = require('typescript');
const Database = require('better-sqlite3');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, file);
const { installQuoteSubscriptions } = require('../lib/quoteSubscriptionsSchema.ts');
const { QuoteSubscriptionsStore, QuoteSubscriptionLimitError } = require('../lib/quoteSubscriptionsStore.ts');
const { QuoteSubscriptionService } = require('../lib/quoteSubscriptionService.ts');
const { ActiveQuotePool } = require('../lib/activeQuotePool.ts');
const DAY = 86_400_000, item = (code = 'AAPL', market = 'US') => ({ market, code, id: 'private-record-id' });
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
function clock() {
  let now = 1_000_000; const timers = new Set();
  return { now: () => now, size: () => timers.size,
    setTimer: (run, delay) => { const timer = { at: now + delay, run, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
    async advance(ms) {
      const end = now + ms; await flush();
      for (let n = 0; ; n++) {
        assert(n < 10000, 'scheduler must not spin');
        const timer = [...timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        now = timer.at; timers.delete(timer); timer.run(); await flush();
      }
      now = end; await flush();
    }
  };
}
const resources = [];
function harness(options = {}) {
  const time = options.time || clock(), calls = [], changes = [];
  const db = new Database(options.file || ':memory:'); db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY)');
  db.exec("INSERT OR IGNORE INTO users VALUES('alice'),('bob'),('carol')"); installQuoteSubscriptions(db);
  const store = new QuoteSubscriptionsStore(db, { now: time.now, userLimit: options.userLimit });
  let namespace = 'source-a';
  const pool = new ActiveQuotePool({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    capacity: options.capacity, currentNamespace: () => namespace,
    policy: () => ({ intervalMs: 5000, phase: namespace }),
    refresh: async rows => { calls.push(rows); if (options.refresh) return options.refresh(rows);
      return Object.fromEntries(rows.map(row => [row.id, { price: 100 }])); }
  });
  const service = new QuoteSubscriptionService({ store: () => store, namespace: () => namespace,
    sync: (rows, replace) => { changes.push(rows); pool.reconcileSubscriptions(rows, namespace, replace); }
  }, time);
  const h = { time, db, store, pool, service, calls, changes, namespace: value => { namespace = value; },
    close() { service.dispose(); pool.dispose(); if (db.open) db.close(); } };
  resources.push(h); return h;
}
let count = 0;
async function test(name, run) {
  try { await run(); count++; console.log('PASS ' + name); }
  finally { for (const h of resources.splice(0)) h.close(); }
}
(async () => {
  await test('two users share one normalized public security; ownership and account fields never enter jobs', async () => {
    const h = harness();
    h.service.observe('alice', [item('700', 'HK'), { ...item('00700', 'HK'), quantity: 90, cash: 999 }]);
    assert.equal(h.store.list('alice').length, 1); assert.equal(h.pool.stats().active, 0);
    h.service.observe('bob', [item('00700', 'HK')]); await h.time.advance(0);
    assert.equal(h.pool.stats().markets.HK, 1); assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], [{ market: 'HK', code: '00700', id: '["HK","00700"]' }]);
    const text = JSON.stringify([...h.changes, ...h.calls]);
    for (const secret of ['alice', 'bob', 'quantity', 'cash', 'private-record']) assert(!text.includes(secret));
  });
  await test('cancellation removes only the owner, preserves another user, and releases the last shared lease', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]); await h.time.advance(1000);
    h.service.subscribe('bob', [item()]); h.service.remove('bob', [item()]);
    assert.equal(h.store.list('bob').length, 0); assert.equal(h.store.list('alice').length, 1);
    assert.equal(h.pool.stats().active, 1); assert.equal(h.store.aggregate()[0].requestedAt, 1_000_000);
    h.service.remove('alice'); await h.time.advance(0);
    assert.equal(h.pool.stats().active, 0); assert.equal(h.pool.stats().candidates, 0); assert.equal(h.time.size(), 0);
  });
  await test('anonymous demand survives user cancellation and its expiry cannot renew a remaining user', async () => {
    const h = harness(); h.pool.observe([item()], 'source-a'); h.pool.observe([item()], 'source-a');
    h.service.subscribe('alice', [item()]); h.service.remove('alice'); assert.equal(h.pool.stats().active, 1);
    await h.time.advance(DAY); h.service.observe('bob', [item()]);
    await h.time.advance(6 * DAY);
    assert.equal(h.pool.stats().active, 0); assert.equal(h.pool.stats().candidates, 1);
    assert.equal(h.store.list('bob').length, 1);
    await h.time.advance(DAY); assert.equal(h.pool.stats().candidates, 0); assert.equal(h.time.size(), 0);
  });
  await test('durable leases recover hot and dormant state after a real database close and reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-quotes-restore-'));
    try {
      const file = path.join(dir, 'quotes.db'), h = harness({ file });
      h.service.subscribe('alice', [item()]); await h.time.advance(90_000);
      h.service.subscribe('bob', [item('00700', 'HK')]); h.close();
      const restored = harness({ file, time: h.time }); restored.service.list('alice'); await restored.time.advance(0);
      assert.equal(restored.pool.stats().active, 2); assert.equal(restored.pool.stats().hot, 1);
      assert.equal(restored.pool.stats().dormant, 1); assert.equal(restored.calls.length, 1);
      assert.equal(restored.calls[0][0].market, 'HK');
      await restored.time.advance(7 * DAY); assert.equal(restored.store.aggregate().length, 0);
      assert.equal(restored.pool.stats().active, 0); assert.equal(restored.time.size(), 0); restored.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('seven-day cleanup is per user and runs with no new request; the later user remains subscribed', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]); await h.time.advance(2 * DAY);
    h.service.subscribe('bob', [item()]); await h.time.advance(5 * DAY);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM quote_subscriptions WHERE user_id=?').get('alice').n, 0);
    assert.equal(h.store.list('bob').length, 1); assert.equal(h.pool.stats().dormant, 1);
    await h.time.advance(2 * DAY); assert.equal(h.db.prepare('SELECT COUNT(*) n FROM quote_subscriptions').get().n, 0);
    assert.equal(h.time.size(), 0);
  });
  await test('background prices and subscription listing never extend user retention or read counts', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]);
    const before = h.db.prepare('SELECT * FROM quote_subscriptions').all();
    await h.time.advance(90_000); const n = h.calls.length;
    assert(n > 1); assert.equal(h.service.list('alice')[0].state, 'dormant');
    assert.deepEqual(h.db.prepare('SELECT * FROM quote_subscriptions').all(), before);
    await h.time.advance(3 * DAY); assert.equal(h.calls.length, n);
    h.service.observe('alice', [item()]); await h.time.advance(0); assert.equal(h.calls.length, n + 1);
  });
  await test('market capacity is independent and a full US pool cannot starve HK or CN', async () => {
    const h = harness({ capacity: 1 });
    h.service.subscribe('alice', [item(), item('MSFT'), item('00700', 'HK'), item('600000', 'CN')]);
    await h.time.advance(0); assert.deepEqual(h.pool.stats().markets, { US: 1, HK: 1, CN: 1 });
    assert.equal(h.pool.stats().candidates, 1); assert.equal(h.calls.length, 3);
    await h.time.advance(90_000); h.service.observe('alice', [item('MSFT')]); await h.time.advance(0);
    assert.equal(h.pool.stats().markets.US, 1); assert.equal(h.calls.at(-1)[0].code, 'MSFT');
  });
  await test('implicit user quota evicts only their oldest demand; explicit quota overflow rolls back atomically', async () => {
    const h = harness({ userLimit: 2 }); h.service.subscribe('alice', [item(), item('MSFT')]);
    h.service.subscribe('bob', [item()]); await h.time.advance(1000);
    const before = h.db.prepare('SELECT * FROM quote_subscriptions ORDER BY user_id,code').all();
    assert.throws(() => h.service.subscribe('alice', [item('GOOG')]), QuoteSubscriptionLimitError);
    assert.deepEqual(h.db.prepare('SELECT * FROM quote_subscriptions ORDER BY user_id,code').all(), before);
    h.service.observe('alice', [item('GOOG')]); assert.deepEqual(h.store.list('alice').map(r => r.code), ['GOOG', 'MSFT']);
    assert.equal(h.store.list('bob')[0].code, 'AAPL'); assert.equal(h.pool.stats().active, 2);
  });
  await test('late in-flight completion cannot recreate an unsubscribed security or mutate a new lease', async () => {
    let release; const wait = new Promise(resolve => { release = resolve; });
    const h = harness({ refresh: async rows => { await wait; return Object.fromEntries(rows.map(r => [r.id, { price: 1 }])); } });
    h.service.subscribe('alice', [item()]); await h.time.advance(0); h.service.remove('alice');
    assert.equal(h.pool.stats().active, 0); release(); await flush(); assert.equal(h.time.size(), 0);
    assert.equal(h.pool.stats().active, 0); assert.equal(h.store.list('alice').length, 0);
  });
  await test('source changes reload durable demand, while background refresh does not poll the database', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]);
    let aggregates = 0; const aggregate = h.store.aggregate.bind(h.store);
    h.store.aggregate = (...args) => { aggregates++; return aggregate(...args); };
    await h.time.advance(20_000); assert.equal(aggregates, 0);
    h.namespace('source-b'); await h.time.advance(5000); assert.equal(h.pool.stats().active, 0);
    h.service.list('alice'); await h.time.advance(0); assert.equal(h.pool.stats().active, 1); assert.equal(aggregates, 2);
  });
  await test('expired subscriptions reset promotion and large affected-key cleanup is bounded and complete', async () => {
    const h = harness(); const rows = Array.from({ length: 220 }, (_, i) => item('S' + i));
    h.service.subscribe('alice', rows); await h.time.advance(7 * DAY);
    assert.equal(h.store.list('alice').length, 0); assert.equal(h.pool.stats().active, 0);
    assert.equal(h.changes.at(-1).length, 220); assert(h.changes.at(-1).every(row => row.requestedAt === undefined));
    h.service.observe('alice', [item('S0')]); assert.equal(h.pool.stats().active, 0);
    assert.equal(h.pool.stats().candidates, 1);
  });
  await test('failed cleanup backs off without a timer storm and eventually releases expired leases', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]); const prune = h.store.prune.bind(h.store);
    let fail = true, calls = 0; h.store.prune = () => { calls++; if (fail) throw new Error('disk busy'); return prune(); };
    await h.time.advance(7 * DAY); assert.equal(calls, 1); assert.equal(h.time.size(), 1);
    await h.time.advance(59_999); assert.equal(calls, 1); fail = false;
    await h.time.advance(1); assert.equal(calls, 2); assert.equal(h.time.size(), 0);
    assert.equal(h.store.list('alice').length, 0);
  });
  await test('a competing SQLite writer cannot add seconds to demand bookkeeping or change business write timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-quotes-lock-'));
    let blocker;
    try {
      const file = path.join(dir, 'quotes.db'), h = harness({ file }); h.db.pragma('journal_mode=WAL');
      h.db.pragma('busy_timeout=5000'); blocker = new Database(file); blocker.exec('BEGIN IMMEDIATE');
      const started = performance.now();
      assert.throws(() => h.store.touch('alice', [item()]), error => error.code === 'SQLITE_BUSY');
      assert(performance.now() - started < 500, 'metadata writes must fail promptly when locked');
      assert.equal(h.db.pragma('busy_timeout', { simple: true }), 5000);
      assert.equal(h.store.list('alice').length, 0);
      blocker.exec('ROLLBACK'); h.service.subscribe('alice', [item()]); assert.equal(h.store.list('alice').length, 1);
      h.close();
    } finally { if (blocker?.open) blocker.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await test('deleting a user cascades only that user\'s private subscriptions', async () => {
    const h = harness(); h.service.subscribe('alice', [item()]); h.service.subscribe('bob', [item()]);
    h.db.prepare('DELETE FROM users WHERE id=?').run('alice');
    assert.equal(h.store.list('alice').length, 0); assert.equal(h.store.list('bob').length, 1);
    h.service.observe('bob', [item()]); assert.equal(h.pool.stats().active, 1);
    assert.equal(h.store.aggregate()[0].reads, 2);
  });
  console.log(`Quote subscription lifecycle review: ${count} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for (const h of resources) h.close(); });
