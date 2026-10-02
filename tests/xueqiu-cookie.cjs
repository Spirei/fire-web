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
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-cookie-regression-'));
process.chdir(temp); // No real settings, credentials or sessions are modified.
process.env.STOCKLOG_FUTU = 'off';
process.env.STOCKLOG_PROXY = 'off';
global.fetch = async () => { throw Error('Network disabled in isolated cookie regression'); };
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const ext of ['.ts', '.tsx']) require.extensions[ext] = (m, file) => m._compile(compile(file), file);
const auth = require(path.join(root, 'lib/auth.ts'));
const db = require(path.join(root, 'lib/db.ts')).getDb();
const settings = require(path.join(root, 'lib/settings.ts'));
const route = require(path.join(root, 'app/api/settings/xueqiu-cookie/route.ts'));
const settingsRoute = require(path.join(root, 'app/api/settings/route.ts'));
const client = require(path.join(root, 'lib/xueqiuCookieClient.ts'));
const admin = auth.createUser('cookie_admin', 'Temporary-Only-8931', true);
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
const user = auth.createUser('cookie_reader', 'Temporary-Only-8931', true);
const tokens = { admin: auth.createSession(admin.id), user: auth.createSession(user.id) };
function request(role = 'admin', body, method = 'POST', extra = {}) {
  return new Request('http://alcor.test/api/settings/xueqiu-cookie', { method, headers: { 'Content-Type': 'application/json', ...(tokens[role] ? { Cookie: `${auth.SESSION_COOKIE}=${tokens[role]}` } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const elements = tree => Array.isArray(tree) ? tree.flatMap(elements) : tree?.props ? [tree, ...elements(tree.props.children)] : [];
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(options = {}) {
  const slots = [], effects = [], listeners = new Map(), copies = [];
  let cursor = 0, dirty = false, pending = [], calls = 0;
  let props = { configured: true, editing: false, disabled: false, draft: { value: '', dirty: false } };
  const hooks = { ...React,
    useId() { return `cookie-${cursor++}`; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { const value = typeof next === 'function' ? next(slots[i]) : next; if (!Object.is(value, slots[i])) { slots[i] = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; return slots[i] || (slots[i] = { current: initial }); },
    useEffect(fn, deps) { const i = cursor++; if (!effects[i] || deps.some((value, n) => !Object.is(value, effects[i].deps[n]))) pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() }; }); }
  };
  const mocks = { react: hooks,
    '@/lib/xueqiuCookieClient': { readXueqiuCookie: signal => { calls++; return options.read ? options.read(signal) : Promise.resolve('xq_a_token=ISOLATED_ONLY; u=123'); } },
    '@/lib/clipboard': { copyText: async text => { copies.push(text); return options.copy !== false; } }, '@/lib/toast': { showToast() {} }
  };
  const exports = {};
  const window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  const document = { hidden: false, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  vm.runInNewContext(compile(path.join(root, 'components/XueqiuCookieInput.tsx')), { exports, require: id => mocks[id] || require(id), window, document, AbortController, DOMException,
    setTimeout: (fn, ms) => setTimeout(fn, options.timeout ? 5 : ms), clearTimeout });
  props.onChange = draft => { props = { ...props, draft }; };
  function render(patch = {}) {
    props = { ...props, ...patch };
    let tree;
    for (let n = 0; n < 10; n++) { cursor = 0; pending = []; dirty = false; tree = exports.default(props); pending.forEach(fn => fn()); if (!dirty) return tree; }
    throw Error('Unstable cookie render');
  }
  const find = (label, patch) => elements(render(patch)).find(el => el.props['aria-label'] === label);
  return { render, input: patch => find('雪球 Cookie', patch), button: label => find(label), props: () => props, copies, calls: () => calls,
    blur: () => listeners.get('blur')?.(), unmount: () => effects.forEach(effect => effect?.cleanup?.()) };
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const watchdog = setTimeout(() => { console.error('Cookie regression timed out'); process.exit(1); }, 15000);
(async () => {
  await test('administrator explicit read is isolated from normal settings responses and encrypted storage', async () => {
    settings.updateSiteSettings({ xueqiuCookie: 'xq_a_token=ISOLATED_ONLY; u=123', smtpPassword: 'OTHER_SECRET' });
    const stored = db.prepare("SELECT value FROM site_settings WHERE key='xueqiuCookie'").get().value;
    assert(!stored.includes('ISOLATED_ONLY'));
    const res = await route.POST(request()); assert.equal(res.status, 200); assert(res.headers.get('cache-control').includes('no-store'));
    assert.equal((await res.json()).cookie, 'xq_a_token=ISOLATED_ONLY; u=123');
    assert.equal(route.GET, undefined);
    for (const role of ['admin', 'user']) {
      const res = await settingsRoute.GET(request(role, undefined, 'GET'));
      assert(!JSON.stringify(await res.json()).includes('ISOLATED_ONLY'));
    }
  });
  await test('anonymous, ordinary users, cross-site and non-JSON reads cannot reveal the credential', async () => {
    for (const [role, extra, expected] of [['none', {}, 401], ['user', {}, 403], ['admin', { Origin: 'https://evil.test' }, 401], ['admin', { 'sec-fetch-site': 'cross-site' }, 401], ['admin', { 'Content-Type': 'text/plain' }, 415]]) {
      const res = await route.POST(request(role, undefined, 'POST', extra)); assert.equal(res.status, expected); assert(res.headers.get('cache-control').includes('no-store')); assert(!JSON.stringify(await res.json()).includes('ISOLATED_ONLY'));
    }
    db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(user.id);
    assert.equal((await route.POST(request('user'))).status, 401);
  });
  await test('read budget is enforced by user identity', async () => {
    db.prepare('DELETE FROM rate_limit WHERE key=?').run(`xueqiu-cookie-read:${admin.id}`);
    for (let n = 0; n < 20; n++) assert.equal((await route.POST(request())).status, 200);
    const res = await route.POST(request()); assert.equal(res.status, 429); assert.equal(res.headers.get('retry-after'), '60');
    db.prepare('DELETE FROM rate_limit WHERE key=?').run(`xueqiu-cookie-read:${admin.id}`);
  });
  await test('another worker replacing or clearing a cookie invalidates read and configured state', async () => {
    const external = new Database(db.name);
    const { encryptSecret } = require(path.join(root, 'lib/secretStorage.ts'));
    try {
      settings.getSiteSettings();
      external.prepare("UPDATE site_settings SET value=? WHERE key='xueqiuCookie'").run(encryptSecret('xq_a_token=OTHER_WORKER'));
      assert.equal((await (await route.POST(request())).json()).cookie, 'xq_a_token=OTHER_WORKER');
      external.prepare("UPDATE site_settings SET value='' WHERE key='xueqiuCookie'").run();
      assert.equal((await route.POST(request())).status, 404);
      assert.equal((await (await settingsRoute.GET(request('admin', undefined, 'GET'))).json()).settings.xueqiuCookieConfigured, false);
    } finally { external.close(); settings.updateSiteSettings({ xueqiuCookie: 'xq_a_token=ISOLATED_ONLY; u=123' }); }
  });
  await test('blank untouched saves preserve credentials; explicit clear is atomic and reversible before saving', async () => {
    assert.deepEqual(client.xueqiuCookiePatch({ value: '', dirty: false }), {});
    assert.deepEqual(client.xueqiuCookiePatch({ value: '  xq_a_token=new ', dirty: true }), { xueqiuCookie: 'xq_a_token=new' });
    assert.deepEqual(client.xueqiuCookiePatch({ value: '', dirty: true }), { clearXueqiuCookie: true });
    assert.equal((await settingsRoute.PUT(request('admin', { xueqiuCookie: '' }, 'PUT'))).status, 200);
    assert.equal(settings.getSiteSettings().xueqiuCookie, 'xq_a_token=ISOLATED_ONLY; u=123');
    const before = settings.getSiteSettings().tradingSquareDuanRefreshMinutes;
    db.exec("CREATE TRIGGER deny_cookie_clear BEFORE UPDATE ON site_settings WHEN NEW.key='xueqiuCookie' AND NEW.value='' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.equal((await settingsRoute.PUT(request('admin', { clearXueqiuCookie: true, tradingSquareDuanRefreshMinutes: 60 }, 'PUT'))).status, 500);
    assert.equal(settings.getSiteSettings().tradingSquareDuanRefreshMinutes, before);
    assert.equal(settings.getSiteSettings().xueqiuCookie, 'xq_a_token=ISOLATED_ONLY; u=123');
    db.exec('DROP TRIGGER deny_cookie_clear');
    assert.equal((await settingsRoute.PUT(request('admin', { clearXueqiuCookie: true }, 'PUT'))).status, 200);
    assert.equal(settings.getSiteSettings().xueqiuCookie, ''); assert.equal(settings.getSiteSettings().smtpPassword, 'OTHER_SECRET');
    assert.equal((await route.POST(request())).status, 404);
  });
  await test('invalid cookie bodies cannot change any settings', async () => {
    for (const body of [{ xueqiuCookie: 'a=1\r\nb=2' }, { xueqiuCookie: 'a'.repeat(16385) }, { xueqiuCookie: {} }, { clearXueqiuCookie: 'true' }, { clearXueqiuCookie: true, xueqiuCookie: 'a=1' }]) assert.equal((await settingsRoute.PUT(request('admin', body, 'PUT'))).status, 400);
    assert.equal(settings.getSiteSettings().xueqiuCookie, '');
  });
  await test('read client uses no-store POST and never echoes server error bodies', async () => {
    let init;
    global.fetch = async (url, options) => { assert.equal(url, '/api/settings/xueqiu-cookie'); init = options; return Response.json({ cookie: 'ISOLATED_ONLY' }); };
    assert.equal(await client.readXueqiuCookie(new AbortController().signal), 'ISOLATED_ONLY'); assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error');
    global.fetch = async () => Response.json({ error: 'ISOLATED_ONLY' }, { status: 500 });
    await assert.rejects(client.readXueqiuCookie(new AbortController().signal), error => !error.message.includes('ISOLATED_ONLY'));
    global.fetch = async () => Response.json({ cookie: { value: 'ISOLATED_ONLY' } });
    await assert.rejects(client.readXueqiuCookie(new AbortController().signal));
  });
  await test('saved cookie starts blank, reveals in read-only mode and is discarded when hidden', async () => {
    const h = harness(); assert.equal(h.input().props.value, ''); assert.equal(h.calls(), 0);
    h.button('显示雪球 Cookie').props.onClick(); await settle(); assert.equal(h.input().props.type, 'text'); assert(h.input().props.value.includes('ISOLATED_ONLY')); assert.equal(h.input().props.readOnly, true);
    h.button('隐藏雪球 Cookie').props.onClick(); assert.equal(h.input().props.value, ''); assert.equal(h.input().props.type, 'password');
    h.button('显示雪球 Cookie').props.onClick(); await settle(); assert.equal(h.calls(), 2); h.unmount();
  });
  await test('deleting a draft stays empty; clear and undo never fetch or auto-save', async () => {
    const h = harness(); h.render({ editing: true });
    h.input().props.onChange({ target: { value: 'xq_a_token=NEW_DRAFT' } }); assert.equal(h.input().props.value, 'xq_a_token=NEW_DRAFT');
    h.input().props.onChange({ target: { value: '' } }); assert.equal(h.input().props.value, ''); assert.equal(h.button('显示雪球 Cookie').props.disabled, true); assert.equal(h.button('复制雪球 Cookie').props.disabled, true);
    assert(!h.input().props.onBlur); h.button('撤销清除雪球 Cookie').props.onClick(); assert.equal(h.props().draft.dirty, false); assert.equal(h.calls(), 0);
    h.button('清空雪球 Cookie').props.onClick(); assert.equal(h.props().draft.dirty, true); assert.equal(h.input().props.value, ''); h.unmount();
  });
  await test('copy hidden saved content without revealing; local drafts override saved content', async () => {
    const h = harness(); h.button('复制雪球 Cookie').props.onClick(); await settle(); assert.equal(h.copies[0], 'xq_a_token=ISOLATED_ONLY; u=123'); assert.equal(h.input().props.value, '');
    h.render({ editing: true, draft: { value: 'LOCAL_DRAFT', dirty: true } }); h.button('复制雪球 Cookie').props.onClick(); await settle(); assert.equal(h.copies[1], 'LOCAL_DRAFT'); assert.equal(h.calls(), 1); h.unmount();
    const failed = harness({ copy: false }); failed.button('复制雪球 Cookie').props.onClick(); await settle(); assert(elements(failed.render()).some(el => el.props.role === 'alert')); failed.unmount();
  });
  await test('clipboard focus changes can finish an explicit copy without exposing saved content', async () => {
    let complete, signal;
    const h = harness({ read: current => { signal = current; return new Promise(resolve => { complete = resolve; }); } });
    h.button('复制雪球 Cookie').props.onClick(); h.blur(); assert(!signal.aborted); complete('ISOLATED_ONLY'); await settle(); assert.equal(h.copies[0], 'ISOLATED_ONLY'); assert.equal(h.input().props.value, ''); h.unmount();
  });
  await test('failed reads are safe and retryable; duplicate clicks, blur, mode changes and unmount discard late results', async () => {
    let complete, signal;
    const h = harness({ read: current => { signal = current; return new Promise(resolve => { complete = resolve; }); } });
    h.button('显示雪球 Cookie').props.onClick(); h.button('显示雪球 Cookie').props.onClick(); assert.equal(h.calls(), 1); h.blur(); assert(signal.aborted); complete('ISOLATED_ONLY'); await settle(); assert.equal(h.input().props.value, '');
    h.button('显示雪球 Cookie').props.onClick(); h.render({ editing: true }); assert(signal.aborted); complete('ISOLATED_ONLY'); await settle(); assert.equal(h.input().props.value, '');
    h.button('复制雪球 Cookie').props.onClick(); h.unmount(); assert(signal.aborted); complete('ISOLATED_ONLY'); await settle(); assert.equal(h.copies.length, 0);
    let fail = true;
    const retry = harness({ read: async () => { if (fail) throw Error('ISOLATED_ONLY'); return 'RECOVERED'; } }); retry.button('显示雪球 Cookie').props.onClick(); await settle(); assert(!JSON.stringify(retry.render()).includes('ISOLATED_ONLY')); fail = false; retry.button('显示雪球 Cookie').props.onClick(); await settle(); assert.equal(retry.input().props.value, 'RECOVERED'); retry.unmount();
  });
  await test('timeout releases controls and communicates failure', async () => {
    const h = harness({ timeout: true, read: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })) });
    h.button('显示雪球 Cookie').props.onClick(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(h.button('显示雪球 Cookie').props.disabled, false); assert(elements(h.render()).some(el => el.props.role === 'alert')); h.unmount();
  });
  await test('fallback copying clears temporary text even after browser rejection', async () => {
    const exports = {}; let removed = false, refocused = false;
    class HTMLElement { constructor() { this.isConnected = true; } focus() { refocused = true; } }
    const textarea = { value: '', setAttribute() {}, style: {}, select() {}, setSelectionRange() {}, remove() { removed = true; } };
    vm.runInNewContext(compile(path.join(root, 'lib/clipboard.ts')), { exports, navigator: {}, window: { isSecureContext: false }, HTMLElement, document: { activeElement: new HTMLElement(), createElement: () => textarea, body: { appendChild() {} }, execCommand() { throw Error('Browser denied copy'); } } });
    assert.equal(await exports.copyText('ISOLATED_ONLY'), false); assert(removed); assert(refocused); assert.equal(textarea.value, '');
  });
  await test('all visibility controls use a valid complete closed SVG outline', () => {
    const Icon = require(path.join(root, 'components/VisibilityIcon.tsx')).default;
    const paths = elements(Icon({})).filter(el => el.type === 'path');
    const arities = { M: 2, C: 6, S: 4, c: 6, s: 4, Z: 0 };
    const outline = paths[0].props.d; assert(outline.endsWith('Z'));
    for (const segment of outline.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
      const count = (segment[2].match(/-?\d+(?:\.\d+)?/g) || []).length;
      assert(segment[1] in arities); if (arities[segment[1]]) assert.equal(count % arities[segment[1]], 0); else assert.equal(count, 0);
    }
    for (const file of ['PasswordInput.tsx', 'LoginForm.tsx', 'WatchGroupSheet.tsx', 'LibraryAttachmentsView.tsx', 'StockKline.tsx', 'AssetAnalysisDashboard.tsx', 'showcase/ModelImporter.tsx']) assert(fs.readFileSync(path.join(root, 'components', file), 'utf8').includes('VisibilityIcon'));
  });
  console.log(`${passed} cookie and visibility regressions passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(watchdog); db.close(); process.chdir(cwd); fs.rmSync(temp, { recursive: true, force: true }); });
