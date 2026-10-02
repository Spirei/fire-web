// Disposable service-worker cache and bounded-stream regression; no server or account data.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const body = require(path.join(root, 'lib/requestBody.ts'));
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
function worker() {
  const listeners = new Map(), stores = new Map(), intercepted = [], puts = [];
  const caches = {
    keys: async () => [...stores.keys()], delete: async key => stores.delete(key),
    open: async key => {
      if (!stores.has(key)) stores.set(key, new Map());
      return { put: async (req, res) => { puts.push(req.url); stores.get(key).set(req.url, res); }, match: async req => stores.get(key).get(req.url)?.clone() };
    }
  };
  let online = true, response = () => new Response('public content'), claims = 0;
  const self = { location: { origin: 'https://offline.test.example' }, addEventListener: (type, fn) => listeners.set(type, fn), skipWaiting() {}, clients: { claim: async () => { claims++; } } };
  const context = vm.createContext({ self, caches, URL, Response, fetch: async req => { intercepted.push(req.url); if (!online) throw new Error('offline'); return response(); } });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8'), context);
  async function get(url, mode = 'cors') {
    let result;
    listeners.get('fetch')({ request: { url: new URL(url, self.location.origin).href, method: 'GET', mode }, respondWith: promise => { result = promise; } });
    if (!result) return null;
    const value = await result; await new Promise(resolve => setImmediate(resolve)); return value;
  }
  return { stores, puts, intercepted, get, setOnline: value => { online = value; }, setResponse: fn => { response = fn; },
    activate: async () => { let done; listeners.get('activate')({ waitUntil: promise => { done = promise; } }); await done; assert.equal(claims, 1); } };
}
function streamed(chunks, headers = {}) {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { for (const bytes of chunks) controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  return { response: new Response(stream, { headers }), stream, cancelled: () => cancelled };
}
(async () => {
  await test('worker activation removes earlier account-bearing caches and claims clients', async () => {
    const w = worker(); w.stores.set('fire-pwa-v4', new Map()); w.stores.set('unrelated-cache', new Map());
    await w.activate(); assert(!w.stores.has('fire-pwa-v4')); assert(w.stores.has('unrelated-cache'));
  });
  await test('account navigation is never retained or replayed after offline account switch', async () => {
    const w = worker(); w.setResponse(() => new Response('account A financial details'));
    assert.equal(await (await w.get('/holdings', 'navigate')).text(), 'account A financial details'); assert.equal(w.puts.length, 0);
    w.stores.set('unrelated-cache', new Map([['https://offline.test.example/holdings', new Response('account A')]]));
    w.setOnline(false); const offline = await w.get('/holdings', 'navigate');
    assert.equal(offline.status, 503); assert.equal(offline.headers.get('cache-control'), 'no-store'); assert(!(await offline.text()).includes('account A'));
  });
  await test('private uploads, draft files, APIs and encoded report paths are not intercepted', async () => {
    const w = worker();
    for (const url of ['/uploads/reports/a.pdf', '/uploads/reports%2Fa.pdf', '/uploads/REPORTS/a.pdf', '/uploads/reports%5Ca.pdf', '/uploads/asset/.draft-secret.png', '/uploads/asset%2F.draft-secret.png', '/api/simple-app', 'https://other.test.example/_next/static/a.js']) assert.equal(await w.get(url), null, url);
    assert.equal(w.intercepted.length, 0);
  });
  await test('cache honors private/no-store responses while public resources still work offline', async () => {
    const w = worker();
    for (const policy of ['private, max-age=300', 'public, no-store', 'PRIVATE', 'max-age=0, no-store']) {
      w.setResponse(() => new Response('sensitive', { headers: { 'cache-control': policy } })); await w.get('/uploads/asset/private.png');
    }
    assert.equal(w.puts.length, 0);
    w.setResponse(() => new Response('public icon', { headers: { 'cache-control': 'public, max-age=60' } }));
    await w.get('/uploads/asset/icon.png'); assert.equal(w.puts.length, 1);
    w.setOnline(false); assert.equal(await (await w.get('/uploads/asset/icon.png')).text(), 'public icon');
  });
  await test('offline static fallback cannot read a different cache namespace', async () => {
    const w = worker(); w.stores.set('fire-pwa-v4', new Map([['https://offline.test.example/_next/static/private.js', new Response('old secret')]]));
    w.setOnline(false); assert.equal((await w.get('/_next/static/private.js')).status, 503);
  });
  await test('oversized declared upstream responses cancel streams before rejecting', async () => {
    for (const read of [body.readLimitedResponseBytes, body.readLimitedResponseJson]) {
      const fixture = streamed([], { 'content-length': '101' });
      await assert.rejects(() => read(fixture.response, 100), body.RequestBodyTooLargeError); assert(fixture.cancelled());
    }
  });
  await test('chunked upstream responses enforce actual bytes and retain valid JSON behavior', async () => {
    for (const read of [body.readLimitedResponseBytes, body.readLimitedResponseJson]) {
      const fixture = streamed([new Uint8Array(60), new Uint8Array(60)]);
      await assert.rejects(() => read(fixture.response, 100), body.RequestBodyTooLargeError); assert(fixture.cancelled());
    }
    assert.deepEqual(await body.readLimitedResponseJson(new Response('{"ok":true}'), 100), { ok: true });
    assert.equal(await body.readLimitedResponseJson(new Response('{invalid'), 100), null);
    assert.equal(await body.readLimitedResponseJson(new Response(null), 100), null);
  });
  await test('ledger import caps chunked multipart body before parsing and reports malformed input', async () => {
    const load = Module._load;
    Module._load = function(id, parent, ...rest) {
      if (parent?.filename === path.join(root, 'app/api/simple-app/tool/import/route.ts') && id === '@/lib/auth') return { getAuthUser: () => ({ id: 1 }) };
      if (parent?.filename === path.join(root, 'app/api/simple-app/tool/import/route.ts') && id === '@/lib/simpleLedgerXlsx') return { parseYouzhiyouxing: async () => { throw new Error('Unexpected parser invocation'); } };
      return load.call(this, id, parent, ...rest);
    };
    const route = require(path.join(root, 'app/api/simple-app/tool/import/route.ts')); Module._load = load;
    const fixture = streamed([new Uint8Array(6 * 1024 * 1024), new Uint8Array(6 * 1024 * 1024)]);
    const request = new Request('https://offline.test.example/api/simple-app/tool/import', { method: 'POST', body: fixture.stream, duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=test' } });
    assert.equal((await route.POST(request)).status, 413); assert(fixture.cancelled());
    assert.equal((await route.POST(new Request(request.url, { method: 'POST', body: 'invalid', headers: { 'content-type': 'multipart/form-data; boundary=test' } }))).status, 400);
  });
  console.log(`${passed} browser/cache/body security suites passed (isolated caches and streams)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
