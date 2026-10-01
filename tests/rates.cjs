const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const originalCwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-rates-'));
process.chdir(temp); // All cache/session writes go to an isolated database.
process.env.STOCKLOG_FUTU = 'off';
process.env.STOCKLOG_PROXY = 'off';
global.fetch = async () => { throw Error('Network disabled in rate regressions'); };
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }
}).outputText, filename);
const { extractRateMap, toUsdBase } = require(path.join(root, 'lib/currencyRefresh.ts'));
const { convertAmount, parseFxAmount, sanitizeFxInput } = require(path.join(root, 'lib/fxConvert.ts'));
const { FxRatesError, parseFxRatesSnapshot, readFxRates } = require(path.join(root, 'lib/fxRatesClient.ts'));
const rates = require(path.join(root, 'lib/rates.ts'));
const db = require(path.join(root, 'lib/db.ts')).getDb();
let external;
let passed = 0;
const watchdog = setTimeout(() => { console.error('Rate regression did not complete'); process.exit(1); }, 15_000);
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
function writeCache(connection, value) {
  connection.prepare("INSERT INTO site_settings(key,value) VALUES('rates_cache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
}
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !tree.props) return [];
  return [tree, ...elements(tree.props.children)];
}
function converterHarness(read) {
  const states = [], refs = [], effects = [], listeners = new Map();
  let cursor = 0;
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return refs[i] || (refs[i] = { current: initial }); },
    useCallback: fn => fn,
    useEffect: fn => effects.push(fn), useLayoutEffect: fn => effects.push(fn)
  };
  const window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), dispatchEvent: event => listeners.get(event.type)?.() };
  const mocks = {
    react: hooks,
    '@/lib/workspacePanel': { useWorkspaceSearchParams: () => new URLSearchParams('section=convert&from=USD&amount=100'), useWorkspaceLocationGuard: () => () => false },
    '@/lib/currencyPrefs': { useDisplayCurrency: () => ({ currency: 'USD' }) },
    '@/lib/usePersistedState': { usePersistedState: (_key, initial) => hooks.useState(initial) },
    '@/lib/fxRatesClient': { FxRatesError, readFxRates: async (force, signal) => {
      const response = await read(force, signal);
      if (!response.ok) throw new FxRatesError('汇率加载失败，请重试');
      return parseFxRatesSnapshot(await response.json());
    } }, '@/lib/toast': { showToast() {} }
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'components/FxConverter.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, { exports, window, Event, URLSearchParams, AbortController, setTimeout, clearTimeout, require: id => mocks[id] || require(id.startsWith('@/') ? path.join(root, id.slice(2)) : id) });
  return {
    render() { cursor = 0; effects.length = 0; return elements(exports.default()); },
    mount() { return effects.map(fn => fn()).filter(fn => typeof fn === 'function'); },
    update() { listeners.get('fire:rates-updated')?.(); }
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  await test('long amounts keep integer digits and invalid inputs or conversion overflow cannot become money', () => {
    const large = '123456789012345.67';
    assert.equal(sanitizeFxInput(large), large);
    assert.equal(parseFxAmount(sanitizeFxInput(large)), parseFxAmount(large));
    assert.equal(sanitizeFxInput('1000000000000000'), '1000000000000000');
    assert.equal(parseFxAmount('1000000000000000'), 1e15);
    assert.equal(parseFxAmount(sanitizeFxInput('10000000000000000')), null);
    for (const value of ['1e3', '0x10', '1,2', 'Infinity', '-1', '1 000', '1..2']) assert.equal(parseFxAmount(value), null, value);
    for (const value of ['1e3', '0x10', '1,2', '-100']) assert.equal(parseFxAmount(sanitizeFxInput(value)), null, 'input must not silently change ' + value);
    assert.equal(sanitizeFxInput('$1,234.50'), '1234.50');
    assert.equal(parseFxAmount('1,234.50'), 1234.5);
    assert.equal(parseFxAmount('.25'), 0.25);
    assert.equal(convertAmount(100, 'USD', 'EUR', { EUR: Infinity }), null);
    assert.equal(convertAmount(100, 'EUR', 'USD', { EUR: Infinity }), null);
    assert.equal(convertAmount(1e15, 'EUR', 'JPY', { EUR: 1e-300, JPY: 1e300 }), null);
  });
  await test('client trusts only USD snapshots and quoted finite prices, keeping MOP estimates explicit', () => {
    const snapshot = parseFxRatesSnapshot({ base: 'USD', rates: { USD: 1, EUR: 0.9, GBP: 0.8, HKD: 7.8, JPY: 'Infinity', CNY: true }, quoted: ['USD', 'EUR', 'HKD', 'JPY', 'CNY'], updatedAt: 1000 });
    assert.equal(snapshot.rates.EUR, 0.9);
    assert.equal(snapshot.rates.GBP, undefined, 'unquoted valuation fallback cannot enter conversion');
    assert(!snapshot.quoted.has('JPY') && !snapshot.quoted.has('CNY'));
    assert.equal(snapshot.rates.MOP, 7.8 * 1.03);
    assert.equal(snapshot.estimatedMop, true);
    assert.equal(parseFxRatesSnapshot({ base: 'USD', rates: { USD: 1, HKD: 7.8, MOP: 8 }, quoted: ['HKD', 'MOP'] }).estimatedMop, false);
    for (const value of [null, [], { base: 'EUR', rates: { USD: 1 }, quoted: [] }, { base: 'USD', rates: { USD: 2 }, quoted: [] }]) assert.throws(() => parseFxRatesSnapshot(value), FxRatesError);
  });
  await test('client timeouts include body reads; cancellation is distinct and a subsequent retry works', async () => {
    for (const bodyStall of [false, true]) {
      global.fetch = async (_url, { signal }) => {
        const blocked = () => new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return bodyStall ? { ok: true, status: 200, json: blocked } : blocked();
      };
      await assert.rejects(readFxRates(false, undefined, 10), error => error instanceof FxRatesError && /超时/.test(error.message));
    }
    const controller = new AbortController();
    const cancelled = readFxRates(false, controller.signal, 1000);
    controller.abort();
    await assert.rejects(cancelled, error => error.name === 'AbortError' && !(error instanceof FxRatesError));
    let calledUrl;
    global.fetch = async (url, init) => { calledUrl = url; assert.equal(init.cache, 'no-store'); return Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.9 }, quoted: ['USD', 'EUR'], updatedAt: 1000 }); };
    assert.equal((await readFxRates()).rates.EUR, 0.9);
    assert.equal(calledUrl, '/api/rates', 'normal retry must not consume an upstream refresh');
    await readFxRates(true);
    assert.equal(calledUrl, '/api/rates?refresh=1');
    global.fetch = async () => Response.json({ error: 'internal diagnostic must never appear' }, { status: 401 });
    await assert.rejects(readFxRates(), /登录状态已失效/);
    global.fetch = async () => { throw Error('ordinary reads must never fetch'); };
  });
  await test('Raycast quotes retain EUR and exclude invalid prices', () => {
    const map = extractRateMap({ success: true, source: 'USD', quotes: { USDEUR: 0.9, USDCNY: '7.2', USDHKD: Infinity, USDJPY: 0, USDSGD: 'bad' } });
    assert.deepEqual(map, { USD: 1, EUR: 0.9, CNY: 7.2 });
    assert.equal(convertAmount(100, 'USD', 'EUR', toUsdBase(map)), 90);
    assert.equal(extractRateMap({ success: false, source: 'USD', quotes: { USDEUR: 99 } }), null);
  });
  await test('omitted EUR base is restored and converted using the USD bridge', () => {
    for (const payload of [
      { base: 'EUR', rates: { USD: 1.25, CNY: 7.5 } },
      { data: { base_code: 'eur', conversion_rates: { USD: '1.25', CNY: 7.5 } } },
      { source: 'EUR', quotes: { EURUSD: 1.25, EURCNY: 7.5 } }
    ]) {
      const normalized = toUsdBase(extractRateMap(payload));
      assert.equal(normalized.EUR, 0.8);
      assert.equal(normalized.CNY, 6);
      assert.equal(convertAmount(100, 'EUR', 'USD', normalized), 125);
    }
    assert.equal(extractRateMap({ base: 'EUR', rates: { CNY: 7.5 } }), null, 'missing USD bridge must not produce a wrong USD conversion');
    assert.deepEqual(extractRateMap({ rates: { CNY: 7.2 } }), { CNY: 7.2 }, 'legacy USD tables remain compatible');
  });
  await test('existing readers observe another database connection adding EUR without upstream requests', async () => {
    await rates.getRates(); // Prime the process before another worker refreshes.
    external = new Database(path.join(temp, 'data/fire.db'));
    writeCache(external, { at: 1000, rates: { USD: 1, CNY: 7.2 }, quoted: ['USD', 'CNY'] });
    assert(!rates.quotedCurrencies().includes('EUR'), 'fallback EUR must not pretend to be live');
    writeCache(external, { at: 2000, rates: { USD: 1, EUR: 0.9, CNY: 7.2 }, quoted: ['USD', 'EUR', 'CNY'] });
    const snapshot = await rates.getRatesSnapshot();
    assert.equal(snapshot.rates.EUR, 0.9);
    assert(snapshot.quoted.includes('EUR'));
    assert.equal(rates.ratesUpdatedAt(), 2000);
    assert.equal((await rates.getRates()).EUR, 0.9);
  });
  await test('pending API snapshots keep rates, quoted currencies and time together', async () => {
    const pending = rates.getRatesSnapshot();
    writeCache(external, { at: 3000, rates: { USD: 1, CNY: 7.3 }, quoted: ['USD', 'CNY'] });
    const old = await pending;
    assert.equal(old.updatedAt, 2000);
    assert.equal(old.rates.EUR, 0.9);
    assert(old.quoted.includes('EUR'));
    const next = await rates.getRatesSnapshot();
    assert.equal(next.updatedAt, 3000);
    assert(!next.quoted.includes('EUR'));
    assert.notEqual(next.rates.EUR, undefined, 'valuation fallback is retained separately');
  });
  await test('refresh deduplicates calls and failed HTTP, parsing or persistence preserves the old snapshot', async () => {
    let calls = 0, finish;
    global.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    const a = rates.refreshRates(), b = rates.getRatesSnapshot(true);
    assert.equal(calls, 1);
    finish(Response.json({ base: 'EUR', rates: { USD: 1.25, CNY: 7.5 } }));
    const [values, snapshot] = await Promise.all([a, b]);
    assert.equal(values.EUR, 0.8);
    assert(snapshot.quoted.includes('EUR'));
    const saved = await rates.getRatesSnapshot();
    for (const response of [Response.json({}, { status: 429 }), Response.json({ base: 'EUR', rates: { CNY: 99 } }), Response.json({ base: 'USD', rates: { USD: 1 } })]) {
      global.fetch = async () => response;
      await assert.rejects(rates.refreshRates());
      assert.deepEqual(await rates.getRatesSnapshot(), saved);
    }
    db.exec("CREATE TRIGGER reject_rate_update BEFORE UPDATE ON site_settings WHEN NEW.key='rates_cache' BEGIN SELECT RAISE(ABORT,'test storage failure'); END");
    global.fetch = async () => Response.json({ source: 'USD', quotes: { USDEUR: 0.91 } });
    await assert.rejects(rates.refreshRates(), /test storage failure/);
    assert.deepEqual(await rates.getRatesSnapshot(), saved);
    db.exec('DROP TRIGGER reject_rate_update');
    assert.equal((await rates.refreshRates()).EUR, 0.91);
    global.fetch = async () => { throw Error('ordinary reads must never fetch'); };
  });
  await test('Web and App v1/v2 responses share EUR availability with no-store headers', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const user = auth.createUser('fx-regression', 'Fx-regression-password-1!', true);
    const token = auth.createSession(user.id);
    const web = require(path.join(root, 'app/api/rates/route.ts'));
    const unauthenticated = await web.GET(new Request('http://localhost:3000/api/rates'));
    assert.equal(unauthenticated.status, 401);
    const expected = await rates.getRatesSnapshot();
    for (const [file, url, headers, envelope] of [
      ['app/api/rates/route.ts', '/api/rates', { authorization: `Bearer ${token}` }, false],
      ['app/api/v1/rates/route.ts', '/api/v1/rates', {}, true],
      ['app/api/v2/rates/route.ts', '/api/v2/rates', {}, true]
    ]) {
      const response = await require(path.join(root, file)).GET(new Request(`http://localhost:3000${url}`, { headers }));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /no-store/);
      const body = await response.json();
      assert.deepEqual(envelope ? body.data : body, expected);
    }
  });
  await test('converter shows loading until EUR arrives and keeps EUR after refresh failure', async () => {
    let finish;
    const view = converterHarness(() => new Promise(resolve => { finish = resolve; }));
    const euro = tree => tree.find(node => node.type === 'input' && node.props['aria-label'] === '欧元金额');
    assert.equal(euro(view.render()).props.placeholder, '加载中…');
    const cleanups = view.mount();
    finish(Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.9 }, quoted: ['USD', 'EUR'], updatedAt: 2000 }));
    await settle();
    assert.equal(euro(view.render()).props.value, '90.00');
    view.update();
    finish(Response.json({}, { status: 502 }));
    await settle();
    assert.equal(euro(view.render()).props.value, '90.00');
    for (const cleanup of cleanups) cleanup();
  });
  await test('converter distinguishes initial failure from a successful response genuinely missing EUR', async () => {
    for (const [response, label] of [
      [Response.json({}, { status: 502 }), '加载失败'],
      [Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.9 }, updatedAt: 1000 }), '加载失败'],
      [Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.9 }, quoted: ['USD'], updatedAt: 1000 }), '暂无汇率']
    ]) {
      const view = converterHarness(async () => response);
      view.render();
      const cleanups = view.mount();
      await settle();
      const input = view.render().find(node => node.type === 'input' && node.props['aria-label'] === '欧元金额');
      assert.equal(input.props.placeholder, label);
      for (const cleanup of cleanups) cleanup();
    }
  });
  await test('force refresh cancels an older read, deduplicates rapid clicks and ignores late old prices', async () => {
    const requests = [];
    const view = converterHarness((force, signal) => new Promise(resolve => { requests.push({ force, signal, resolve }); }));
    const refresh = view.render().find(node => node.type === 'button' && node.props['aria-label'] === '刷新汇率');
    const cleanups = view.mount();
    refresh.props.onClick();
    refresh.props.onClick();
    assert.equal(requests.length, 2, 'one normal read plus one explicit refresh');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(requests[1].force, true);
    assert.equal(view.render().find(node => node.type === 'button' && node.props['aria-label'] === '正在刷新汇率').props.disabled, true);
    requests[1].resolve(Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.91 }, quoted: ['USD', 'EUR'], updatedAt: 3000 }));
    await settle();
    requests[0].resolve(Response.json({ base: 'USD', rates: { USD: 1, EUR: 0.01 }, quoted: ['USD', 'EUR'], updatedAt: 1000 }));
    await settle();
    const tree = view.render();
    assert.equal(tree.find(node => node.type === 'input' && node.props['aria-label'] === '欧元金额').props.value, '91.00');
    assert.equal(tree.find(node => node.type === 'button' && node.props['aria-label'] === '汇率已刷新').props.disabled, false);
    for (const cleanup of cleanups) cleanup();
  });
  await test('failed initial read retries without upstream refresh and unmount cancels pending work', async () => {
    const requests = [];
    const view = converterHarness((force, signal) => new Promise(resolve => { requests.push({ force, signal, resolve }); }));
    view.render();
    const cleanups = view.mount();
    requests[0].resolve(Response.json({}, { status: 502 }));
    await settle();
    const retry = view.render().find(node => node.type === 'button' && node.props['aria-label'] === '重试读取汇率');
    retry.props.onClick();
    assert.equal(requests[1].force, false);
    for (const cleanup of cleanups) cleanup();
    assert.equal(requests[1].signal.aborted, true);
  });
  console.log(`Rate regressions: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog);
  external?.close(); db.close(); process.chdir(originalCwd); fs.rmSync(temp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
});
