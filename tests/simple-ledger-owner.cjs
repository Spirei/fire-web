// Account-bound first frames and delayed browser work, plus real routes in a disposable DB.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.argv[2] || path.join(root, 'public/simple-app-runtime.js'), 'utf8');
const tree = ts.createSourceFile('simple-app-runtime.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
assert.equal(tree.parseDiagnostics.length, 0);
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)).map(node => node.getText(tree)).join('\n');
const windowFunctions = tree.statements.filter(node => ts.isExpressionStatement(node) && /^window\.(remountSimpleApp|refreshSimpleApp|flushSimpleApp)\s*=/.test(node.getText(tree))).map(node => node.getText(tree)).join('\n');
const sharedKey = 'fire-simple-book-v3', cacheKey = owner => sharedKey + ':' + encodeURIComponent(owner);
const book = (name, amount = 100) => ({ cash: [{ id: name, name, cur: 'CNY', amount, date: '2026-10-01' }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function browser(owner, initial = {}) {
  const storage = new Map(Object.entries(initial)), timers = new Map(), requests = [], frames = [], readers = [], inputs = [], downloads = [];
  let nextTimer = 0, handler = async () => { throw new Error('Offline test'); };
  const element = (id = '') => {
    const classes = new Set();
    let html = '';
    return { id, dataset: {}, style: { setProperty() {}, removeProperty() {} }, scrollTop: 0, clientWidth: 680,
      classList: { add(...names) { names.forEach(n => classes.add(n)); }, remove(...names) { names.forEach(n => classes.delete(n)); }, contains(name) { return classes.has(name); }, toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      get innerHTML() { return html; }, set innerHTML(value) { html = value; if (id === 'app') frames.push(value); },
      querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {}, removeEventListener() {}, click() {}, focus() {} };
  };
  const elements = new Map(['win', 'app', 'foot', 'mask', 'skFull', 'toast'].map(id => [id, element(id)]));
  elements.get('win').dataset.simpleLedgerUser = owner;
  const context = vm.createContext({ console, URL, URLSearchParams, Response, Request, AbortSignal, FormData, Blob,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, { fn, cleared: false }); return id; },
    clearTimeout(id) { if (timers.has(id)) timers.get(id).cleared = true; },
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { pathname: '/simple-app', search: '' }, history: { replaceState() {}, pushState() {} },
    navigator: {}, window: { innerWidth: 1000, innerHeight: 900 },
    document: { getElementById(id) { return elements.get(id) || null; }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: element(), createElement(type) { const el = element(); if (type === 'input') inputs.push(el); if (type === 'a') el.click = () => downloads.push(el); return el; } },
    localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, String(value)); } },
    FileReader: class { constructor() { readers.push(this); } readAsText() {} },
    fetch(url, options = {}) { requests.push({ url, options }); return handler(url, options); }
  });
  vm.runInContext(declarations, context);
  // Keep the actual state, route functions, ledger IO and HTML renderer. Stub only window sizing/paint services.
  for (const name of ['applyWin', 'bindSimpleWindow', 'syncScroll', 'loadMarketIcons']) context[name] = () => {};
  vm.runInContext(windowFunctions, context);
  context.readUrl(); context.render({ skipUrl: true });
  const snapshot = () => JSON.parse(vm.runInContext('JSON.stringify({S,route,updateTarget,loggedIn,ledgerWriteFailed,denied:typeof ledgerAccessDenied !== "undefined" && ledgerAccessDenied})', context));
  return { context, storage, timers, requests, frames, readers, inputs, downloads, snapshot,
    handle(fn) { handler = fn; },
    remount(nextOwner) { elements.get('win').dataset.simpleLedgerUser = nextOwner; context.window.remountSimpleApp(); },
    edit(next) { context.nextBook = next; vm.runInContext('S=normalize(nextBook)', context); }
  };
}
let passed = 0, failed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
let db, temp;
(async () => {
  await test('first frames use only this authenticated owner and leave unowned legacy caches untouched', () => {
    const legacy = JSON.stringify(book('Legacy-A-private', 987654)), ownA = JSON.stringify(book('Scoped-A', 120)), ownB = JSON.stringify(book('Scoped-B', 340));
    const initial = { [sharedKey]: legacy, 'fire-simple-book-v2': legacy, [cacheKey('A')]: ownA, [cacheKey('B')]: ownB };
    const a = browser('A', initial), b = browser('B', initial), fresh = browser('C', initial), missingOwner = browser('', initial);
    assert.equal(a.snapshot().S.cash[0].name, 'Scoped-A');
    assert.equal(b.snapshot().S.cash[0].name, 'Scoped-B');
    assert.equal(fresh.snapshot().S.cash.length, 0);
    assert.equal(missingOwner.snapshot().S.cash.length, 0);
    assert(!a.frames[0].includes('987,654') && !b.frames[0].includes('987,654'));
    for (const runtime of [a, b, fresh, missingOwner]) assert.equal(runtime.storage.get(sharedKey), legacy);
  });
  await test('failed hydration never exposes another account, while same-owner offline recovery remains available', async () => {
    const aCache = JSON.stringify(book('A-private')), rt = browser('B', { [sharedKey]: aCache, [cacheKey('A')]: aCache });
    assert.equal(await rt.context.hydrate(), false);
    assert.equal(rt.snapshot().S.cash.length, 0);
    assert.equal(rt.requests[0].options.headers['x-simple-ledger-user'], 'B');
    rt.handle(async url => url === '/api/rates' ? response({ rates: { CNY: 7.1, HKD: 7.8 } }) : response({ data: book('B-server', 200) }));
    assert.equal(await rt.context.hydrate(), true);
    assert.equal(JSON.parse(rt.storage.get(cacheKey('B'))).cash[0].name, 'B-server');
    assert.equal(rt.storage.get(cacheKey('A')), aCache);
    assert.equal(rt.storage.get(sharedKey), aCache);
    const reload = browser('B', Object.fromEntries(rt.storage));
    assert.equal(reload.snapshot().S.cash[0].name, 'B-server');
    assert.equal(await reload.context.hydrate(), false);
    assert.equal(reload.snapshot().S.cash[0].name, 'B-server');
  });
  await test('owner switches clear drafts, pending timers and default cashflow array references before painting', async () => {
    const rt = browser('A');
    vm.runInContext('S.cashflow.incomeItems.push({id:"private",name:"A-private-income",amount:77}); route={name:"settings",account:"A-account",draft:{name:"A-draft"}}; updateTarget="A-account"; loggedIn=true; save()', rt.context);
    const pending = [...rt.timers.values()].find(timer => !timer.cleared);
    const aCache = rt.storage.get(cacheKey('A'));
    rt.remount('B');
    assert(pending.cleared, 'old debounce timer was cancelled');
    assert.equal(rt.snapshot().S.cashflow.incomeItems.length, 0);
    assert.equal(rt.snapshot().route.name, 'home');
    assert.equal(rt.snapshot().route.draft, undefined);
    assert.equal(rt.snapshot().updateTarget, null);
    assert.equal(rt.snapshot().loggedIn, false);
    pending.fn(); await tick();
    assert(!rt.requests.some(request => request.options.method === 'PUT'));
    assert.equal(rt.storage.get(cacheKey('A')), aCache);
    assert(!rt.frames.at(-1).includes('A-draft'));
  });
  await test('late hydration, including delayed JSON decoding, cannot cross an owner or owner epoch', async () => {
    for (const phase of ['response', 'json']) {
      const gate = deferred(), rt = browser('A', { [cacheKey('A')]: JSON.stringify(book('A-cache')) });
      let first = true;
      rt.handle(async (_url, options) => {
        if (options.headers?.['x-simple-ledger-user'] !== 'A' || !first) return response({}, 503);
        first = false;
        return phase === 'response' ? gate.promise : { ok: true, json: () => gate.promise };
      });
      const task = rt.context.hydrate(); await tick();
      rt.remount('B'); rt.remount('A');
      const before = rt.storage.get(cacheKey('A'));
      gate.resolve(phase === 'response' ? response({ data: book('late-A-private') }) : { data: book('late-A-private') });
      assert.equal(await task, false);
      await tick();
      assert.equal(rt.snapshot().S.cash[0].name, 'A-cache');
      assert.equal(rt.storage.get(cacheKey('A')), before);
      assert.equal(rt.storage.has(cacheKey('B')), false);
    }
  });
  await test('late rates cannot mutate or save the next account, even after an A/B/A cycle', async () => {
    const gate = deferred(), rt = browser('A', { [cacheKey('A')]: JSON.stringify(book('A-cache')) });
    rt.handle(async url => url === '/api/rates' ? gate.promise : response({}, 503));
    const task = rt.context.pullRates();
    rt.remount('B'); rt.remount('A');
    gate.resolve(response({ rates: { CNY: 999, HKD: 1 } }));
    await task;
    assert.notEqual(rt.snapshot().S.fx.USD, 999);
    assert.equal(rt.storage.has(cacheKey('B')), false);
  });
  await test('queued and inflight writes retain their captured owner and never write or alter the new account', async () => {
    const rt = browser('A', { [cacheKey('A')]: JSON.stringify(book('A-private')), [cacheKey('B')]: JSON.stringify(book('B-private')) });
    const queued = deferred(); rt.context.queueGate = queued.promise;
    vm.runInContext('pendingLedgerWrite=queueGate', rt.context);
    const oldQueued = rt.context.pushRemote();
    rt.remount('B'); queued.resolve(true);
    assert.equal(await oldQueued, false);
    assert(!rt.requests.some(request => request.options.method === 'PUT'));
    const inflight = deferred();
    rt.remount('A');
    rt.handle(async (_url, options) => options.method === 'PUT' ? inflight.promise : response({}, 503));
    const oldInflight = rt.context.pushRemote(); await tick();
    const sent = rt.requests.find(request => request.options.method === 'PUT');
    assert.equal(sent.options.headers['x-simple-ledger-user'], 'A');
    assert.equal(JSON.parse(sent.options.body).cash[0].name, 'A-private');
    rt.remount('B'); inflight.resolve(response({}));
    assert.equal(await oldInflight, false);
    assert.equal(rt.snapshot().loggedIn, false);
    assert.equal(rt.snapshot().ledgerWriteFailed, false);
    rt.handle(async (_url, options) => options.method === 'PUT' ? response({}) : response({}, 503));
    assert.equal(await rt.context.pushRemote(), true);
    const latest = rt.requests.filter(request => request.options.method === 'PUT').at(-1);
    assert.equal(latest.options.headers['x-simple-ledger-user'], 'B');
    assert.equal(JSON.parse(latest.options.body).cash[0].name, 'B-private');
  });
  await test('delayed Excel exports cannot download a previous account after an owner or epoch switch', async () => {
    for (const phase of ['response', 'blob']) {
      const gate = deferred(), rt = browser('A');
      rt.handle(async (url) => url === '/api/simple-app/tool/export'
        ? (phase === 'response' ? gate.promise : { ok: true, blob: () => gate.promise }) : response({}, 503));
      const task = rt.context.exportXlsx([{ name: 'A-private-export', amount: 100 }]); await tick();
      rt.remount('B'); rt.remount('A');
      gate.resolve(phase === 'response' ? new Response('private workbook') : new Blob(['private workbook']));
      await task; assert.equal(rt.downloads.length, 0);
    }
    const rt = browser('A'); rt.handle(async () => new Response('valid workbook'));
    await rt.context.exportXlsx([{ name: 'A-account', amount: 100 }]);
    assert.equal(rt.downloads.length, 1); assert(rt.downloads[0].download.endsWith('.xlsx'));
    URL.revokeObjectURL(rt.downloads[0].href);
  });
  await test('explicit account/session denial hides old data without overwriting its cache or reopening it on remount', async () => {
    for (const method of ['GET', 'PUT']) for (const status of [401, 403, 409]) {
      const original = JSON.stringify(book('A-private')), rt = browser('A', { [cacheKey('A')]: original });
      rt.handle(async () => response({}, status));
      assert.equal(await (method === 'GET' ? rt.context.hydrate() : rt.context.pushRemote()), false);
      assert.equal(rt.snapshot().S.cash.length, 0);
      assert.equal(rt.snapshot().denied, true);
      assert.equal(rt.storage.get(cacheKey('A')), original);
      const before = rt.requests.length;
      rt.context.save(); assert.equal(await rt.context.pushRemote(), false);
      assert.equal(rt.requests.length, before);
      rt.handle(async () => { throw new Error('Offline'); }); rt.remount('A'); await tick();
      assert.equal(rt.snapshot().S.cash.length, 0);
      assert.equal(rt.storage.get(cacheKey('A')), original);
      rt.handle(async url => url === '/api/rates' ? response({}) : response({ data: book('A-authenticated-again') }));
      assert.equal(await rt.context.hydrate(), true);
      assert.equal(rt.snapshot().S.cash[0].name, 'A-authenticated-again');
      assert.equal(rt.snapshot().denied, false);
    }
  });
  await test('late JSON FileReader and spreadsheet import results cannot populate a newly mounted owner', async () => {
    const rt = browser('A'); rt.context.importBook();
    const input = rt.inputs.at(-1); input.files = [{ name: 'A-private.json' }]; input.onchange();
    const reader = rt.readers.at(-1); rt.remount('B');
    reader.result = JSON.stringify(book('A-private-import')); reader.onload();
    assert.equal(rt.snapshot().S.cash.length, 0);
    rt.remount('A'); const gate = deferred();
    rt.handle(async url => url === '/api/simple-app/tool/import' ? gate.promise : response({}, 503));
    rt.context.importLedger(); const excel = rt.inputs.at(-1); excel.files = [{ name: 'A-private.xlsx' }];
    const task = excel.onchange(); rt.remount('B');
    gate.resolve(response({ ok: true, invest: [{ name: 'A-private-invest', amount: 10 }] })); await task;
    assert.equal(rt.snapshot().S.invest.length, 0);
    assert.equal(rt.storage.has(cacheKey('B')), false);
  });

  const resolve = Module._resolveFilename;
  Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
  const routePath = path.join(root, 'app/api/v1/simple-ledger/route.ts');
  require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename === routePath && process.argv[3] ? process.argv[3] : filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-simple-ledger-owner-')); process.chdir(temp);
  process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://ledger.example.test';
  global.fetch = async () => { throw new Error('Network disabled in isolated route tests'); };
  const load = name => require(path.join(root, name));
  const auth = load('lib/auth.ts'), store = load('lib/simpleStore.ts'), native = load('lib/appAuth.ts');
  db = load('lib/db.ts').getDb();
  const v1 = load('app/api/v1/simple-ledger/route.ts'), v2 = load('app/api/v2/simple-ledger/route.ts');
  const a = auth.createUser('ledger_owner_a', 'Audit-owner-123'), b = auth.createUser('ledger_owner_b', 'Audit-owner-123');
  const aToken = auth.createSession(a.id), bToken = auth.createSession(b.id);
  store.setSimpleLedger(a.id, store.normalizeSimple(book('A-private'))); store.setSimpleLedger(b.id, store.normalizeSimple(book('B-private')));
  const request = (version, method, credential, owner) => new Request(process.env.FIRE_APP_ORIGIN + '/api/' + version + '/simple-ledger', { method, headers: { 'content-type': 'application/json', origin: process.env.FIRE_APP_ORIGIN, ...credential, ...(owner === undefined ? {} : { 'x-simple-ledger-user': owner }) }, ...(method === 'PUT' ? { body: JSON.stringify(book('A-stale-write')) } : {}) });
  await test('real ledger routes reject stale-tab owner/Cookie mismatch before any data read or write', async () => {
    const beforeA = store.getSimpleLedger(a.id), beforeB = store.getSimpleLedger(b.id);
    for (const method of ['GET', 'PUT']) for (const owner of [a.id, '']) {
      const res = await v1[method](request('v1', method, { cookie: auth.SESSION_COOKIE + '=' + bToken }, owner));
      assert.equal(res.status, 409);
      const body = await res.json(); assert.equal(body.code, 40902); assert.equal(body.data, undefined);
      assert(!JSON.stringify(body).includes('B-private'));
      assert.deepEqual(store.getSimpleLedger(a.id), beforeA); assert.deepEqual(store.getSimpleLedger(b.id), beforeB);
    }
    assert.equal((await v1.GET(request('v1', 'GET', { cookie: auth.SESSION_COOKIE + '=' + aToken }, a.id))).status, 200);
  });
  await test('optional owner headers preserve existing Web and v1/v2 App ledger clients', async () => {
    const grant = db.transaction(() => native.createNativeAppGrant(b.id, 'portfolio.read portfolio.write', 'isolated ledger test')).immediate();
    for (const [version, route, credential] of [['v1', v1, { cookie: auth.SESSION_COOKIE + '=' + bToken }], ['v1', v1, { authorization: 'Bearer ' + grant.access_token }], ['v2', v2, { authorization: 'Bearer ' + grant.access_token }]]) {
      assert.equal((await route.GET(request(version, 'GET', credential))).status, 200);
      assert.equal((await route.PUT(request(version, 'PUT', credential))).status, 200);
      assert.equal((await route.GET(request(version, 'GET', credential, b.id))).status, 200);
      assert.equal((await route.PUT(request(version, 'PUT', credential, a.id))).status, 409);
    }
  });
  console.log(`${passed} ledger owner isolation regressions passed${failed ? `, ${failed} failed` : ''}.`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { db?.close(); if (temp) fs.rmSync(temp, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
