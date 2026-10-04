// Real HTTP routes, App grants and SQLite; never write fixture data into a real instance.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), ts = require('typescript'), root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename, originalLoad = Module._load;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/quotes.ts')) {
    if (id === './net') return { proxyFetch: async () => { throw Error('Network disabled in isolated tests'); } };
    if (id === './futuQuotes') return { fetchFutuQuotes: async () => new Map(), searchFutu: async () => [] };
    if (id === './usExtendedQuote') return { fetchUsExtendedQuote: async () => null, fetchUsRegularQuote: async () => null };
    if (id === './assetQuotes') return { getCryptoQuote: async () => null };
  }
  return originalLoad.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-app-quote-subscriptions-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://account.test.example:18520';
global.fetch = async () => { throw Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file)), auth = load('lib/auth.ts'), native = load('lib/appAuth.ts');
const dbModule = load('lib/db.ts'), db = dbModule.getDb(), quotes = load('lib/quotes.ts');
const requests = load('lib/quoteSubscriptionRequests.ts'), bodies = load('lib/requestBody.ts');
const route = load('app/api/v2/quote-subscriptions/route.ts');
const q1 = load('app/api/v1/quotes/route.ts'), q2 = load('app/api/v2/quotes/route.ts'), legacy = load('app/api/quotes/route.ts');
const origin = process.env.FIRE_APP_ORIGIN, items = [{ market: 'HK', code: '00700' }], full = 'portfolio.read portfolio.write';
const raw = { name: 'Synthetic', price: 100, change: 1, changePct: 1, open: 99, high: 101, low: 98,
  prevClose: 99, source: 'tencent', session: 'REGULAR', time: '2026/10/02 16:08:10', cached: true, marketCap: 1000 };
const quoteCalls = []; let source = async rows => Object.fromEntries(rows.map(row => [row.id, { ...raw }]));
quotes.fetchQuotes = async (rows, demand) => { quoteCalls.push({ rows, demand }); return source(rows); };
load('lib/rates.ts').getRates = async () => ({ USD: 1, HKD: 7 });
load('lib/kline.ts').fetchDailyKline = async () => [];
let seq = 0, count = 0;
function fixture() {
  const user = auth.createUser('quote_user_' + (++seq), 'Quote-tests-123'), browser = auth.createSession(user.id);
  function connect(scope = full) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const values = { client_id: native.APP_CLIENT_ID, redirect_uri: native.APP_REDIRECT_URI, response_type: 'code',
      code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      state: crypto.randomBytes(32).toString('base64url'), scope };
    const code = native.issueAppCode(native.parseAppAuthorization(values), user.id, browser);
    return native.exchangeAppCode({ ...values, code, code_verifier: verifier });
  }
  return { user, browser, grant: connect(), connect };
}
function request(pathname = 'quote-subscriptions', method = 'GET', body, token, headers = {}) {
  return new Request(origin + '/api/v2/' + pathname, { method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function data(response) { const res = await response; return { status: res.status, headers: res.headers, body: await res.json() }; }
const list = async f => (await data(route.GET(request('quote-subscriptions', 'GET', undefined, f.grant.access_token)))).body.data.subscriptions;
const rows = id => db.prepare('SELECT * FROM quote_subscriptions WHERE user_id=? ORDER BY market,code').all(id);
const quoteBody = (code = '00700', market = 'HK') => ({ items: [{ id: 'private-position-id', market, code }], includeMarketCap: false });
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); count++; console.log('PASS ' + name); }
(async () => {
  await test('discovery exposes fixed v2 contract without expanding scopes or changing the v1 base', async () => {
    const one = (await data(load('app/api/v1/auth/config/route.ts').GET(new Request(origin + '/api/v1/auth/config')))).body.data;
    const two = (await data(load('app/api/v2/auth/config/route.ts').GET(request('auth/config')))).body.data;
    assert.deepEqual(one.quote_subscriptions_contract, two.quote_subscriptions_contract);
    assert.equal(two.quote_subscriptions_contract.path, '/api/v2/quote-subscriptions');
    assert.equal(two.quote_subscriptions_contract.idle_expires_in, 604800);
    assert.equal(two.quote_subscriptions_contract.max_subscriptions, 256);
    assert.equal(two.quote_subscriptions_contract.cancellation_changes_portfolio, false);
    assert.equal(one.token_path, '/api/v1/auth/token'); assert.equal(one.scope, native.APP_SCOPE);
  });
  await test('private read and write reject anonymous, Cookie and Web tokens; readonly App grants cannot mutate', async () => {
    const f = fixture(), readonly = f.connect('portfolio.read');
    for (const method of ['GET', 'POST', 'DELETE']) for (const headers of [{}, { cookie: 'fire_session=' + f.browser },
      { authorization: 'Bearer ' + f.browser }]) {
      const reply = await data(route[method](request('quote-subscriptions', method, method === 'GET' ? undefined : { items }, undefined, headers)));
      assert.equal(reply.status, 401);
    }
    assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items }, readonly.access_token)))).status, 403);
    assert.equal((await data(route.DELETE(request('quote-subscriptions', 'DELETE', { all: true }, readonly.access_token)))).status, 403);
    assert.equal((await data(route.GET(request('quote-subscriptions', 'GET', undefined, readonly.access_token)))).status, 200);
    assert.equal(rows(f.user.id).length, 0); assert(auth.getAuthUser(request('quote-subscriptions', 'GET', undefined, readonly.access_token)));
  });
  await test('normalized subscriptions are private, idempotent by security, and returned with expiry plus private cache headers', async () => {
    const a = fixture(), b = fixture();
    const response = await data(route.POST(request('quote-subscriptions', 'POST', { items: [{ market: 'HK', code: '700' }, ...items] }, a.grant.access_token)));
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store.*private/);
    assert.equal(response.headers.get('x-alcor-api-version'), '2');
    const subscription = response.body.data.subscriptions[0]; assert.equal(subscription.code, '00700');
    assert.equal(subscription.state, 'hot'); assert.equal(subscription.expiresAt - subscription.lastRequestedAt, 604800000);
    assert.equal(rows(a.user.id).length, 1); assert.equal(rows(a.user.id)[0].reads, 2); assert.deepEqual(await list(b), []);
    const before = rows(a.user.id); await list(a); assert.deepEqual(rows(a.user.id), before);
    await route.DELETE(request('quote-subscriptions', 'DELETE', { items }, b.grant.access_token));
    assert.equal(rows(a.user.id).length, 1);
    assert.equal((await data(route.GET(request('quote-subscriptions?market=US', 'GET', undefined, a.grant.access_token)))).body.data.subscriptions.length, 0);
  });
  await test('all input is validated atomically; owner injection, unsupported markets, invalid codes and oversized bodies cannot write', async () => {
    const f = fixture();
    for (const body of [{}, { all: true }, { items, userId: 'victim' }, { items: [] }, { items: [{ ...items[0], user_id: 'victim' }] },
      { items: [...items, { market: 'SG', code: 'D05' }] }, { items: [{ market: 'US', code: 'AAPL?token=secret' }] },
      { items: Array.from({ length: 101 }, () => items[0]) }]) {
      assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', body, f.grant.access_token)))).status, 400);
    }
    assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items }, f.grant.access_token, { 'content-length': '65537' })))).status, 413);
    for (const suffix of ['?userId=other', '?market=SG', '?market=US&market=HK'])
      assert.equal((await data(route.GET(request('quote-subscriptions' + suffix, 'GET', undefined, f.grant.access_token)))).status, 400);
    assert.equal(rows(f.user.id).length, 0);
  });
  await test('Web v1/legacy and App v2 quote reads automatically renew the same owner without a separate API call', async () => {
    const f = fixture(), readonly = f.connect('portfolio.read');
    const webRequest = pathname => new Request(origin + pathname, { method: 'POST', headers: { cookie: 'fire_session=' + f.browser,
      origin, 'content-type': 'application/json' }, body: JSON.stringify(quoteBody('700')) });
    assert.equal((await data(q1.POST(webRequest('/api/v1/quotes')))).status, 200);
    assert.equal(rows(f.user.id)[0].reads, 1);
    assert.equal((await data(q2.POST(request('quotes', 'POST', quoteBody(), readonly.access_token)))).status, 200);
    assert.equal(rows(f.user.id).length, 1); assert.equal(rows(f.user.id)[0].reads, 2);
    assert.equal((await data(legacy.POST(webRequest('/api/quotes')))).status, 200);
    assert.equal(quoteCalls.at(-1).demand.tracked, true); assert.equal(rows(f.user.id).length, 1);
  });
  await test('anonymous and foreign-site public reads do not create private subscriptions or accept a client owner', async () => {
    const f = fixture(), before = db.prepare('SELECT COUNT(*) n FROM quote_subscriptions').get().n;
    assert.equal((await data(q2.POST(request('quotes', 'POST', quoteBody())))).status, 200);
    const cross = new Request(origin + '/api/v1/quotes', { method: 'POST', headers: { cookie: 'fire_session=' + f.browser,
      origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({ ...quoteBody(), userId: f.user.id }) });
    assert.equal((await data(q1.POST(cross))).status, 200);
    assert.equal(rows(f.user.id).length, 0); assert.equal(quoteCalls.at(-1).demand.tracked, false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM quote_subscriptions').get().n, before);
    assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items }, f.grant.access_token,
      { origin: 'https://foreign.example' })))).status, 403);
  });
  await test('history-only details do not subscribe; complete details retain genuine time, source and cached state', async () => {
    const f = fixture(), detail = load('app/api/v2/stock-detail/route.ts');
    assert.equal((await data(detail.GET(request('stock-detail?market=HK&code=700&view=history', 'GET', undefined, f.grant.access_token)))).status, 200);
    assert.equal(rows(f.user.id).length, 0);
    const response = await data(detail.GET(request('stock-detail?market=HK&code=700&includeKline=0', 'GET', undefined, f.grant.access_token)));
    assert.equal(response.status, 200); assert.equal(response.body.data.quote.source, raw.source);
    assert.equal(response.body.data.quote.time, raw.time); assert.equal(response.body.data.quote.cached, true);
    assert.equal(rows(f.user.id)[0].code, '00700');
  });
  await test('revocation while reading the body cannot write or inherit a valid Cookie', async () => {
    const f = fixture(), read = bodies.readJsonBody;
    bodies.readJsonBody = async (...args) => { const body = await read(...args); native.revokeAppGrant(f.grant.grant_id); return body; };
    try {
      assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items }, f.grant.access_token,
        { cookie: 'fire_session=' + f.browser })))).status, 401);
    } finally { bodies.readJsonBody = read; }
    assert.equal(rows(f.user.id).length, 0); assert(auth.getUserByToken(f.browser));
  });
  await test('an in-flight quote result cannot re-enroll an owner who cancelled after starting the read', async () => {
    const f = fixture(); let started, release;
    const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
    const old = source; source = async rows => { started(); await wait; return old(rows); };
    try {
      const response = q2.POST(request('quotes', 'POST', quoteBody(), f.grant.access_token)); await ready;
      assert.equal(rows(f.user.id).length, 1);
      assert.equal((await data(route.DELETE(request('quote-subscriptions', 'DELETE', { all: true }, f.grant.access_token)))).status, 200);
      release(); assert.equal((await data(response)).status, 200); assert.equal(rows(f.user.id).length, 0);
    } finally { source = old; release(); }
  });
  await test('subscription quota failure leaves the previous set intact, and cancellations never modify holdings or cash', async () => {
    const f = fixture(), recordStore = load('lib/store.ts');
    recordStore.createRecord(f.user.id, { name: 'Fixture', code: '00700', market: 'HK', qty: 2, price: 100, cost: 50 });
    const business = () => Object.fromEntries(['records', 'trade_orders', 'fund_transactions', 'user_settings'].map(table =>
      [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
    const before = business();
    const securities = Array.from({ length: 256 }, (_, i) => ({ market: 'US', code: 'S' + i }));
    for (let n = 0; n < securities.length; n += 100)
      assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items: securities.slice(n, n + 100) }, f.grant.access_token)))).status, 200);
    const subscriptions = rows(f.user.id);
    assert.equal((await data(route.POST(request('quote-subscriptions', 'POST', { items }, f.grant.access_token)))).status, 409);
    assert.deepEqual(rows(f.user.id), subscriptions);
    assert.equal((await data(route.DELETE(request('quote-subscriptions', 'DELETE', {}, f.grant.access_token)))).status, 400);
    assert.equal((await data(route.DELETE(request('quote-subscriptions', 'DELETE', { all: true }, f.grant.access_token)))).status, 200);
    assert.deepEqual(business(), before); assert.equal(rows(f.user.id).length, 0);
  });
  await test('private bookkeeping failure preserves availability of public quotes', async () => {
    const f = fixture(), getDb = dbModule.getDb;
    // Avoid breaking authentication; fail only the isolated subscription store.
    const service = await requests.quoteSubscriptionService(), observe = service.observe;
    service.observe = () => { throw Error('disk busy'); };
    try {
      assert.equal((await data(q2.POST(request('quotes', 'POST', quoteBody(), f.grant.access_token)))).status, 200);
      assert.equal(quoteCalls.at(-1).demand.tracked, false); assert.equal(rows(f.user.id).length, 0);
    } finally { service.observe = observe; dbModule.getDb = getDb; }
  });
  await test('account deletion immediately removes only that owner\'s durable demand', async () => {
    const a = fixture(), b = fixture();
    await route.POST(request('quote-subscriptions', 'POST', { items }, a.grant.access_token));
    await route.POST(request('quote-subscriptions', 'POST', { items }, b.grant.access_token));
    assert(auth.deleteUserById(a.user.id)); assert.equal(rows(a.user.id).length, 0); assert.equal(rows(b.user.id).length, 1);
    assert.equal((await list(b))[0].code, '00700');
  });
  console.log(`App quote subscription review: ${count} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  globalThis.__alcorQuoteSubscriptionsV1?.dispose(); globalThis.__alcorQuoteRuntimeV2?.active?.dispose();
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});
