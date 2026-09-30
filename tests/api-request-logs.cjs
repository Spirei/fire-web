const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = process.argv.includes('--persist-check') ? process.cwd() : fs.mkdtempSync(path.join(os.tmpdir(), 'fire-request-logs-'));
process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off';
const { parseRequestFilters, requestDay } = require(path.join(root, 'lib/apiRequestTypes.ts'));
const store = require(path.join(root, 'lib/apiRequestLog.ts'));
if (process.argv.includes('--persist-check')) {
  console.log(JSON.stringify(store.readRequestSnapshot(parseRequestFilters(new URLSearchParams())).summary));
  process.exit(0);
}
const { installRequestInstrumentation } = require(path.join(root, 'lib/apiRequestInstrumentation.ts'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
const filters = extra => parseRequestFilters(new URLSearchParams(extra));
let server;
(async () => {
  await test('route allowlist masks resource IDs and unknown paths; query strings never enter storage', () => {
    assert.equal(store.requestRoute('/api/v1/records/private-id?token=SECRET'), '/api/v1/records/[id]');
    assert.equal(store.requestRoute('/api/private-reports/private-name.pdf'), '/api/private-reports/[...path]');
    assert.equal(store.requestRoute('/api/unexpected/PRIVATE'), '/api/[unmatched]');
    assert.equal(store.requestRoute('/api/request-logs?token=SECRET'), null);
    assert.equal(store.requestRoute('/api/request-logs/events'), null);
    assert.equal(store.requestRoute('/api/health'), null);
    assert.equal(store.requestRoute('/holdings'), null);
    const actual = [];
    function walk(dir, segments) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.isDirectory()) walk(path.join(dir, entry.name), [...segments, entry.name]); else if (entry.name === 'route.ts') actual.push('/api/' + segments.join('/')); } }
    walk(path.join(root, 'app/api'), []);
    assert.deepEqual([...require(path.join(root, 'lib/apiRequestRoutes.ts')).API_REQUEST_ROUTES].sort(), actual.sort(), 'Regenerate the endpoint allowlist');
  });
  await test('filter bounds and Beijing midnight are deterministic across server timezones', () => {
    assert.equal(requestDay(Date.parse('2026-09-29T16:05:00Z')), '2026-09-30');
    const parsed = parseRequestFilters(new URLSearchParams('rPage=NaN&rAnchor=-4&rDay=2026-02-30&rStatus=DROP&rMethod=boom&rYear=100'), Date.parse('2026-09-30T04:00:00Z'));
    assert.equal(parsed.page, 1); assert.equal(parsed.anchor, 0); assert.equal(parsed.day, ''); assert.equal(parsed.status, 'all'); assert.equal(parsed.year, 2026);
    assert.equal(store.requestSource({ 'user-agent': 'Alcor/1 CFNetwork/1 Darwin/1' }), 'ios');
    assert.equal(store.requestSource({ 'user-agent': 'Mozilla/5.0' }), 'web');
    assert.equal(store.requestSource({ 'user-agent': 'Mozilla/5.0 (iPhone) Safari/1', 'sec-fetch-mode': 'cors' }), 'web');
    assert.equal(store.requestSource({ authorization: 'Bearer SECRET' }), 'app');
    assert.equal(parseRequestFilters(new URLSearchParams('rDay=2025-01-01'), Date.parse('2026-09-30T04:00:00Z')).day, '2025-01-01');
  });
  installRequestInstrumentation(); installRequestInstrumentation();
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v1/charts')) { setTimeout(() => { res.statusCode = 502; res.end('SECRET_BODY'); }, 35); return; }
    res.statusCode = req.url.startsWith('/api/v1/auth/me') ? 401 : 200;
    res.end('SECRET_BODY');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await test('real HTTP finish records final status and duration once, including 4xx/5xx', async () => {
    for (const route of ['/api/v1/records/private-id?code=SECRET_QUERY', '/api/v1/auth/me', '/api/v1/charts']) await fetch(base + route, { headers: { 'user-agent': 'Alcor/1 CFNetwork/1', authorization: 'Bearer SECRET_TOKEN', cookie: 'secret=SECRET_COOKIE' } });
    store.flushRequestLogs();
    const result = store.readRequestSnapshot(filters({}));
    assert.equal(result.summary.total, 3); assert.equal(result.summary.errors, 2); assert.equal(result.summary.serverErrors, 1);
    assert.equal(result.summary.sources.ios, 3);
    assert(result.logs.find(row => row.status === 502).duration >= 25);
    assert.equal(result.chart.reduce((n, row) => n + row.count, 0), 3);
    const Database = require('better-sqlite3'); const db = new Database(path.join(temp, 'data/request-logs.sqlite'));
    const stored = JSON.stringify(db.prepare('SELECT * FROM requests').all()); db.close();
    for (const secret of ['PRIVATE', 'SECRET_QUERY', 'SECRET_TOKEN', 'SECRET_COOKIE', 'SECRET_BODY', 'private-id']) assert(!stored.includes(secret));
  });
  await test('monitoring endpoints do not create a self-refresh feedback loop', async () => {
    for (let i = 0; i < 5; i++) await fetch(base + '/api/request-logs/events');
    store.flushRequestLogs(); assert.equal(store.readRequestSnapshot(filters({})).summary.total, 3);
  });
  await test('client interruption is recorded as 499 without a duplicate completion', async () => {
    await new Promise(resolve => {
      const req = http.get(base + '/api/v1/charts', () => {});
      req.on('error', () => resolve()); setTimeout(() => req.destroy(), 10);
    });
    await sleep(50); store.flushRequestLogs();
    assert.equal(store.readRequestSnapshot(filters({ rStatus: 'cancelled' })).summary.total, 1);
    assert.equal(store.readRequestSnapshot(filters({})).summary.total, 4);
  });
  await test('selected dimensions keep cards, chart, endpoint counts and heatmap aligned', () => {
    const result = store.readRequestSnapshot(filters({ rSource: 'ios', rStatus: '5xx', rQ: 'charts', rMethod: 'GET' }));
    assert.equal(result.summary.total, 1); assert.equal(result.logs.length, 1);
    assert.equal(result.chart.reduce((n, row) => n + row.count, 0), 1);
    assert.equal(result.endpoints[0].count, 1); assert.equal(result.heatmap[result.today], 1);
  });
  await test('frozen pagination does not move older rows when new live requests arrive', () => {
    for (let i = 0; i < 45; i++) store.recordRequest({ at: Date.now(), path: '/api/v1/records', method: 'GET', source: 'web', status: 200, duration: 10 });
    store.flushRequestLogs(); const first = store.readRequestSnapshot(filters({ rQ: '/api/v1/records' }));
    const pageFilters = filters({ rQ: '/api/v1/records', rPage: '2', rAnchor: String(first.pagination.anchor) });
    const second = store.readRequestSnapshot(pageFilters);
    store.recordRequest({ at: Date.now(), path: '/api/v1/records', method: 'GET', source: 'web', status: 200, duration: 10 });
    store.flushRequestLogs();
    assert.deepEqual(store.readRequestSnapshot(pageFilters).logs.map(row => row.id), second.logs.map(row => row.id));
    assert.equal(store.readRequestSnapshot(pageFilters).summary.total, first.summary.total + 1);
  });
  await test('request history and counters survive a fresh process', () => {
    const result = spawnSync(process.execPath, [__filename, '--persist-check'], { cwd: temp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).total, store.readRequestSnapshot(filters({})).summary.total);
  });
  await test('live observers fire after persistence and one failing observer cannot stop others', () => {
    let updates = 0;
    const offBad = store.observeRequestLogs(() => { throw new Error('disconnected'); });
    const off = store.observeRequestLogs(() => { updates++; assert(store.requestLogRevision() > 0); });
    store.recordRequest({ at: Date.now(), path: '/api/v1/overview', method: 'GET', source: 'web', status: 200, duration: 5 });
    store.flushRequestLogs(); assert.equal(updates, 1); off(); offBad();
  });
  await test('anonymous and ordinary users cannot read global request metadata or subscribe', async () => {
    global.fetch = async () => { throw new Error('External network disabled'); };
    const { createUser, createSession } = require(path.join(root, 'lib/auth.ts'));
    const admin = createUser('adminfixture', 'Valid!Request123');
    const normal = createUser('userfixture', 'Valid!Request123');
    require(path.join(root, 'lib/db.ts')).getDb().prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    const get = require(path.join(root, 'app/api/request-logs/route.ts')).GET;
    const events = require(path.join(root, 'app/api/request-logs/events/route.ts')).GET;
    for (const route of [get, events]) {
      assert.equal((await route(new Request('https://fire.example.test/api/request-logs'))).status, 401);
      assert.equal((await route(new Request('https://fire.example.test/api/request-logs', { headers: { cookie: 'fire_session=' + createSession(normal.id) } }))).status, 403);
    }
    const token = createSession(admin.id);
    const response = await get(new Request('https://fire.example.test/api/request-logs', { headers: { cookie: 'fire_session=' + token } }));
    assert.equal(response.status, 200); assert(response.headers.get('cache-control').includes('private'));
    const controller = new AbortController();
    const eventResponse = await events(new Request('https://fire.example.test/api/request-logs/events', { headers: { cookie: 'fire_session=' + token }, signal: controller.signal }));
    assert.equal(eventResponse.headers.get('content-type'), 'text/event-stream');
    const reader = eventResponse.body.getReader();
    assert(new TextDecoder().decode((await reader.read()).value).includes('event: change'));
    store.recordRequest({ at: Date.now(), path: '/api/v1/overview', method: 'GET', source: 'web', status: 200, duration: 5 }); store.flushRequestLogs();
    assert(new TextDecoder().decode((await reader.read()).value).includes('event: change'));
    controller.abort(); assert.equal((await reader.read()).done, true);
    // Cancelling/aborting streams releases all slots.
    const slots = Array.from({ length: 20 }, () => store.observeRequestLogs(() => {}));
    assert(slots.every(Boolean)); assert.equal(store.observeRequestLogs(() => {}), null); slots.forEach(off => off());
  });
  await test('detail pruning never erases historical heatmap counts or chart totals', () => {
    const old = Date.now() - 10 * 86400_000;
    store.recordRequest({ at: old, path: '/api/v1/rates', method: 'GET', source: 'web', status: 200, duration: 20 }); store.flushRequestLogs();
    const db = global.__fireRequestLog.db;
    db.prepare('DELETE FROM requests WHERE at < ?').run(Date.now() - 7 * 86400_000);
    const result = store.readRequestSnapshot(filters({ rDay: requestDay(old), rQ: '/api/v1/rates' }));
    assert.equal(result.logs.length, 0); assert.equal(result.summary.total, 1); assert.equal(result.heatmap[requestDay(old)], 1);
    assert.equal(result.chart.reduce((n, row) => n + row.count, 0), 1);
  });
  await test('unavailable storage backs off under traffic and keeps a bounded recoverable queue', () => {
    const state = global.__fireRequestLog, original = state.db;
    let attempts = 0;
    state.db = { prepare() { attempts++; throw new Error('Disk unavailable'); } };
    try {
      for (let i = 0; i < 2200; i++) store.recordRequest({ at: Date.now(), path: '/api/v1/settings', method: 'GET', source: 'web', status: 200, duration: 1 });
      assert.equal(attempts, 1, 'A failed disk must not be retried on every request');
      assert.equal(state.queue.length, 2048);
    } finally { state.db = original; state.retryAfter = 0; }
    store.flushRequestLogs();
    assert.equal(state.queue.length, 0);
    assert.equal(store.readRequestSnapshot(filters({ rQ: '/api/v1/settings' })).summary.total, 2048);
  });
  console.log(`Request log regression: ${passed} PASS`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (global.__fireRequestLog?.timer) clearInterval(global.__fireRequestLog.timer);
  global.__fireRequestLog?.db?.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
