const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
require.extensions['.tsx'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-regression-'));
process.chdir(temp); // Real route/store integration tests, isolated from the user's database and uploads.
process.env.STOCKLOG_FUTU = 'off';
global.fetch = async () => { throw new Error('Network disabled in isolated regression'); };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
(async () => {
  await test('full kline requests coalesce and period cache preserves the requested count', async () => {
    const { fetchDailyKline, fetchPeriodKline } = require(path.join(root, 'lib/kline.ts'));
    const original = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return Response.json({ data: { hk09999: { qfqday: ['01', '02', '03', '04'].map(month => [`2026-${month}-15`, '10', '11', '12', '9', '100']) } } });
    };
    try {
      const [a, b] = await Promise.all([fetchDailyKline('HK', '09999', 4), fetchDailyKline('HK', '09999', 4)]);
      assert.deepEqual(a, b);
      assert.equal(calls, 1);
      await fetchDailyKline('HK', '09999', 4, true);
      assert.equal(calls, 2, 'index flag must be part of cache identity');
      const first = await fetchPeriodKline('HK', '09999', 'MONTH', 2);
      const cached = await fetchPeriodKline('HK', '09999', 'MONTH', 2);
      assert.equal(first.length, 2);
      assert.deepEqual(cached, first);
      assert.equal(calls, 3);
      assert.equal((await fetchPeriodKline('HK', '09999', 'MONTH', 2, 'qfq', true)).length, 2);
      assert.equal(calls, 4, 'period requests must preserve index identity');
    } finally { global.fetch = original; }
  });
  await test('preference cookies fit after URI encoding and retain small Chinese preferences', () => {
    const { prefsCookieString, parsePrefsCookie } = require(path.join(root, 'lib/prefsCookie.ts'));
    const cookie = prefsCookieString({ 'fire:small': '简体', 'fire:large': '汉字'.repeat(800), 'fire:columns': Array.from({ length: 80 }, (_, i) => `列${i}`) });
    assert(Buffer.byteLength(cookie) < 4096);
    const value = decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
    const restored = parsePrefsCookie(value);
    assert.equal(restored['fire:small'], '简体');
    assert.equal(restored['fire:large'], undefined);
  });
  await test('attachment pagination rejects non-finite and unsafe offsets', () => {
    const { queryLibraryAssets } = require(path.join(root, 'lib/attachments.ts'));
    for (const page of [Infinity, -Infinity, NaN, 1.5, Number.MAX_VALUE]) {
      assert.equal(queryLibraryAssets({ page }).page, 1);
    }
    assert.equal(queryLibraryAssets({ page: 2 }).page, 2);
  });
  await test('FIRE blank years never imply that retirement has been reached', () => {
    const source = fs.readFileSync(path.join(root, 'components/views/FireView.tsx'), 'utf8');
    const expression = source.match(/\{(!yearsInput\.trim\(\).*?)\}<\/div>/)[1];
    const label = new Function('yearsInput', `return (${expression})`);
    assert.equal(label(''), '—');
    assert.equal(label('NaN'), '—');
    assert.equal(label('0'), '已达成');
    assert.equal(label('8'), '8 年');
    assert(source.includes('tableYearsToFire == null ? "" : String(tableYearsToFire)'));
  });
  await test('rate caches reject malformed values and always preserve the USD base', () => {
    const { normalizeCachedRates } = require(path.join(root, 'lib/ratesCache.ts'));
    assert.equal(normalizeCachedRates([]), null);
    assert.equal(normalizeCachedRates({ BAD: -1 }), null);
    const rates = normalizeCachedRates({ USD: 50, CNY: 7.2, HKD: Infinity, EUR: '1.2', longCode: 5 });
    assert.equal(rates.USD, 1);
    assert.equal(rates.CNY, 7.2);
    assert(Number.isFinite(rates.HKD));
    assert.equal(typeof rates.EUR, 'number');
    assert.equal(rates.longCode, undefined);
  });
  await test('concurrent reads share transport but keep independent bodies and allow fresh retry', async () => {
    const { sharedRead } = require(path.join(root, 'lib/sharedRead.ts'));
    const original = global.fetch;
    let calls = 0;
    let finish;
    global.fetch = (url) => {
      if (url !== '/api/rates') return Promise.reject(new Error('Network disabled in isolated regression'));
      calls++; return new Promise(resolve => { finish = resolve; });
    };
    try {
      const a = sharedRead('/api/rates');
      const b = sharedRead('/api/rates');
      assert.equal(calls, 1);
      finish(Response.json({ rates: { USD: 1 } }));
      const results = await Promise.all([a, b]);
      assert.deepEqual(await results[0].json(), await results[1].json());
      const next = sharedRead('/api/rates');
      assert.equal(calls, 2);
      finish(new Response('unavailable', { status: 503 }));
      assert.equal((await next).status, 503);
      global.fetch = async (url) => { if (url === '/api/rates') calls++; throw new Error('offline'); };
      await assert.rejects(sharedRead('/api/rates'), /offline/);
      await assert.rejects(sharedRead('/api/rates'), /offline/);
      assert.equal(calls, 4);
    } finally { global.fetch = original; }
  });
  await test('kline route coalesces upstream requests and caches successful closes', async () => {
    const { GET } = require(path.join(root, 'app/api/kline/route.ts'));
    const original = global.fetch;
    let calls = 0;
    let finish;
    global.fetch = (url) => {
      if (!String(url).includes('US_MinKService.getDailyK')) return Promise.reject(new Error('Network disabled in isolated regression'));
      calls++; return new Promise(resolve => { finish = resolve; });
    };
    const request = () => new Request('http://localhost/api/kline?market=US&code=REGRESSION');
    try {
      const a = GET(request());
      const b = GET(request());
      assert.equal(calls, 1);
      finish(new Response('callback([{"d":"2026-01-30","c":"10"},{"d":"2026-02-27","c":"12"}])'));
      assert.deepEqual(await (await a).json(), { closes: [10, 12] });
      assert.deepEqual(await (await b).json(), { closes: [10, 12] });
      assert.deepEqual(await (await GET(request())).json(), { closes: [10, 12] });
      assert.equal(calls, 1);
      assert.equal((await GET(new Request('http://localhost/api/kline?market=US&code=' + 'A'.repeat(33)))).status, 400);
      assert.equal(calls, 1);
    } finally { global.fetch = original; }
  });
  await test('mini kline cache isolates markets, expires and rejects invalid data', () => {
    const { readMiniKline, writeMiniKline, miniKlineKey } = require(path.join(root, 'lib/miniKlineCache.ts'));
    const originalStorage = global.localStorage;
    const originalNow = Date.now;
    const values = new Map();
    let now = 1000000;
    global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
    Date.now = () => now;
    try {
      writeMiniKline('US', 'ABC', [10, 11]);
      writeMiniKline('CN', 'ABC', [20, 21]);
      assert.deepEqual(readMiniKline('us', 'abc'), [10, 11]);
      assert.deepEqual(readMiniKline('CN', 'ABC'), [20, 21]);
      now += 600000;
      assert.equal(readMiniKline('US', 'ABC'), null);
      values.set(miniKlineKey('US', 'BAD'), JSON.stringify({ at: now, closes: [1, '2'] }));
      assert.equal(readMiniKline('US', 'BAD'), null);
      writeMiniKline('US', 'BAD', [1, Infinity]);
      assert.equal(readMiniKline('US', 'BAD'), null);
    } finally { global.localStorage = originalStorage; Date.now = originalNow; }
  });
  await test('card wander shuffles deterministically and preserves the reference wall angle', () => {
    const { selectWanderCards } = require(path.join(root, 'lib/cardWander.ts'));
    const cards = Array.from({ length: 140 }, (_, index) => ({ key: `card-${index}` }));
    const first = selectWanderCards(cards, '70fry32r', 98);
    assert.equal(first.length, 98);
    assert.equal(new Set(first.map((card) => card.key)).size, 98);
    assert.deepEqual(selectWanderCards([...cards].reverse(), '70fry32r', 98), first);
    assert.notDeepEqual(selectWanderCards(cards, 'another1', 98), first);
    const wander = fs.readFileSync(path.join(root, 'components/CardWander.tsx'), 'utf8');
    const library = fs.readFileSync(path.join(root, 'components/views/CardLibraryView.tsx'), 'utf8');
    assert(wander.includes('rotateX(15deg) rotateZ(-6deg)'), 'the card wall keeps the reference page tilt');
    assert(wander.includes('requestAnimationFrame(animate)') && wander.includes('DRIFT_SPEED_PER_SECOND'), 'card wall must wander automatically');
    assert(wander.includes('洗牌') && wander.includes('查看详情'));
    assert(['光泽', '幻彩', '金属', '流星', '萤火虫'].every((label) => wander.includes(`label: "${label}"`)), 'all five card effects stay selectable');
    assert(wander.includes('"展示"') && wander.includes('"钱包"') && wander.includes('"原尺寸"'), 'all three card presentation modes stay available');
    const wanderStyles = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    assert(wander.includes('card-wander-actual') && wanderStyles.includes('.card-wander-actual-card img { display: block; width: auto; height: auto; max-width: none;'), 'actual-size presentation uses the image intrinsic dimensions');
    assert(wander.includes('getZoomSourceRect') && wander.includes('zoomImageRef.current?.animate'), 'the full-size view animates from the selected presentation');
    assert(wander.includes('setZoomEffect(previewEffect)') && !wander.includes('zoomEffectBagRef') && wander.includes('openZoom();') && wander.includes('className="card-wander-zoom-card" data-effect={zoomEffect}') && ['gloss', 'holo', 'metal', 'meteor', 'fireflies'].every((effect) => wanderStyles.includes(`.card-wander-zoom-card[data-effect="${effect}"] .card-wander-effect-sheen`)), 'enlarged cards preserve the selected preview effect across all five effects');
    assert(wander.includes('tileObserverRef.current = new IntersectionObserver') && wander.includes('rootMargin: "360px"') && wander.includes('observeTile={observeTile}'), 'wander tiles share one nearby-image observer and do not preload the distant wall');
    assert(wander.includes('queueHoveredTile(event.clientX, event.clientY, target)') && wander.includes('hoverFrameRef.current = window.requestAnimationFrame'), 'rapid pointer events coalesce into one hover hit test per frame');
    assert(wanderStyles.includes('.card-wander-effects { grid-template-columns: repeat(5, 1fr); }') && wanderStyles.includes('@keyframes card-wander-fragment-fall') && wanderStyles.includes('@keyframes card-wander-effect-fireflies'), 'the five-way selector and two restrained effects remain available');
    assert(wanderStyles.includes('.card-wander-zoom-card[data-effect="metal"]::after') && wanderStyles.includes('.card-wander-zoom-backdrop::before'), 'metal has a visible specular sweep while the zoom background fades separately from the opaque card');
    assert(wander.includes('flyCard(from, to, selectedCard.image') && wander.includes('sourceTileRef.current'), 'the card flies between the wall and preview in both directions');
    assert(wander.includes('dataset.revealed = "true"') && wander.includes('dataset.landed = "true"') && wander.includes('dataset.closing = "true"'), 'preview entry and exit have separate choreography states');
    assert(wander.includes('animation.finished.then(() => {') && !wander.includes('landTimer') && !wanderStyles.includes('transform: scale(.96);') && wanderStyles.includes('.card-wander-preview-stage { opacity: 0; }'), 'preview image starts only after the flight lands without resizing its panel');
    assert(!wander.includes('scale(1.025)') && !wanderStyles.includes('card-wander-effect-idle') && wanderStyles.includes('.card-wander-effect[data-pointer-active] .card-wander-effect-tilt { transition-duration: .09s; }'), 'preview hover follows the pointer without a zoom pulse or idle transform takeover');
    assert(wander.includes('effectFrameRef.current = window.requestAnimationFrame') && wander.includes('effectGlareRef.current.style.transform = reflection') && wander.includes('effectSpecRef.current.style.transform = reflection'), 'pointer highlights update at most once per animation frame via layer transforms');
    assert(wanderStyles.includes('@keyframes card-wander-effect-sweep { from { transform: translate3d(') && wanderStyles.includes('@keyframes card-wander-effect-rainbow { from { transform: translate3d(') && !wanderStyles.includes('from { background-position: 100% 50%; }'), 'gloss, holographic, and metal sweeps move composited layers instead of repainting gradients');
    assert(wanderStyles.includes('.card-wander-effect-glare { width: 85%; aspect-ratio: 1; background: radial-gradient(circle at center') && wanderStyles.includes('.card-wander-effect-spec { width: 35%; height: 80%; background: radial-gradient(ellipse at center') && wanderStyles.includes('transparent 60%') && !/\.card-wander-effect-(?:glare|spec) \{[^}]*mix-blend-mode/.test(wanderStyles), 'pointer highlights fade before their layer edges without blend-mode compositor seams at card corners');
    assert(wander.includes('new DOMMatrixReadOnly(getComputedStyle(tile).transform)') && wander.includes('(sourceY - wallOriginY) * Math.sin(15 * Math.PI / 180)') && wander.includes('rotateX(15deg) rotateZ(-6deg) scale(${scale})') && wanderStyles.includes('.card-wander-modal[data-landed]:not([data-closing]) .card-wander-preview-stage'), 'flight derives its 3D origin and hover lift from each wall position until the full-resolution preview lands');
    assert(wanderStyles.includes('.card-wander-modal[data-closing] .card-wander-preview-stage') && wanderStyles.includes('.card-wander-modal-actions { transition-delay: .12s; }'), 'closing hides content before the card flies back and entry actions appear last');
    assert(wander.includes('document.startViewTransition') && wanderStyles.includes('::view-transition-group(card-wander-card)'), 'presentation mode changes morph the card');
    assert(wander.includes('setWalletPayment((open) => !open)') && wander.includes('aria-pressed={walletPayment}'), 'wallet tap toggles the payment demonstration');
    assert(wanderStyles.includes('.card-wander-wallet[data-payment="true"] .card-wander-wallet-card') && wanderStyles.includes('card-wander-reader-pulse'), 'wallet card, stack, and reader animate during payment');
    assert(wander.includes('const COLUMNS = 12') && wanderStyles.includes('grid-template-columns: repeat(12, var(--wander-card-width))'), 'all card wall columns fit on one grid row');
    assert(wander.includes('columnIndex % 2') && wanderStyles.includes('var(--wander-row-step) * .5 * var(--wander-column-stagger)'), 'alternating columns offset by exactly half a card row');
    assert(wander.includes('async function shuffleWall()') && wanderStyles.includes('card-wander-wall-in'), 'shuffle crossfades the wall instead of randomly staggering cards');
    const tileStyle = wanderStyles.match(/\.card-wander-tile \{([^}]+)\}/)?.[1] ?? '';
    const tileHoverStyle = wanderStyles.match(/\.card-wander-tile:hover,\s*\.card-wander-tile:focus-visible \{([^}]+)\}/)?.[1] ?? '';
    assert(tileStyle.includes('border: 0;') && !tileHoverStyle.includes('border-color'), 'hover lift must not draw a white border around cards');
    assert(wanderStyles.includes('card-wander-unfold 1.2s') && wander.includes('dataset.dragging = "true"') && wanderStyles.includes('.card-wander-viewport[data-dragging] .card-wander-tile:hover'), 'wall unfolds on entry and drag suppresses hover lift');
    assert(wander.includes('findTileAtPoint(event.clientX, event.clientY)') && wander.includes('data-wander-key={card.key}') && wanderStyles.includes('.card-wander-tile[data-hovered]'), 'cards behind the 3D wall hit plane remain clickable and hoverable with a pointer');
    assert(wander.includes('selectedCard.image') && wander.includes('card.image'), 'preview and wall both use the original card asset URL');
    assert(!wander.includes('className="card-wander-brand"'), 'no extra title belongs on the card wall');
    assert(!wander.includes('拖动浏览 · 点按查看'), 'the removed top-right hint must not return');
    assert(library.includes('setWanderUrl(seed, "replace")'), 'shuffle retains a shareable URL');
  });
  const { parseStockFile } = require(path.join(root, 'lib/importFile.ts'));
  const { importIdentity } = require(path.join(root, 'lib/importIdentity.ts'));
  await test('ticker/prefix, CSV quotes, TSV blanks, JSON, oversized imports', () => {
    for (const symbol of ['SHOP', 'USO', 'SHAK', 'SHEL', 'HKD', 'US', 'SGMO']) assert.equal(parseStockFile(symbol)[0].code, symbol);
    assert.deepEqual(parseStockFile('HK.700 Tencent')[0], { code: '00700', market: 'HK', name: 'Tencent' });
    assert.equal(parseStockFile('AAPL,"Apple, Inc.",US')[0].name, 'Apple, Inc.');
    assert.equal(parseStockFile('AAPL,"Apple ""Inc""",US')[0].name, 'Apple "Inc"');
    assert.equal(parseStockFile('7203\t\tJP')[0].market, 'JP');
    assert.equal(parseStockFile('AAPL Apple Computer Inc US')[0].name, 'Apple Computer Inc');
    assert.equal(parseStockFile('[{"symbol":"SHOP","market":"US"}]')[0].code, 'SHOP');
    assert.throws(() => parseStockFile('AAPL\n'.repeat(2001)), /2000/);
    assert.throws(() => importIdentity('HK.700', 'US'), /不一致/);
  });
  const { getDb } = require(path.join(root, 'lib/db.ts'));
  const db = getDb();
  const { createUser, createSession } = require(path.join(root, 'lib/auth.ts'));
  const user = createUser('review_user', 'Review-test-123');
  const other = createUser('review_other', 'Review-test-123');
  const tokens = { user: createSession(user.id), other: createSession(other.id), admin: createSession('demo-user') };
  await test('browser sessions renew both expiries without reviving revoked or expired sessions', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const route = require(path.join(root, 'app/api/auth/me/route.ts'));
    const digest = token => require('node:crypto').createHash('sha256').update(token).digest('hex');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const request = (token, headers = {}) => new Request('http://localhost/api/auth/me', { method:'POST', headers:{ cookie:`fire_session=${token}`, origin:'http://localhost', ...headers } });
    const expires = token => db.prepare('SELECT expires_at FROM sessions WHERE token=?').get(digest(token))?.expires_at;
    try {
      const token = auth.createSession(user.id);
      const originalExpiry = expires(token);
      assert.equal(auth.sessionCookieMaxAge(), 7*86400);
      assert.equal((await route.POST(request(token))).headers.get('set-cookie'), null, 'fresh session needs no write');
      now += 2*86400000;
      const forbidden = await route.POST(request(token, {origin:'https://other.example','sec-fetch-site':'cross-site'}));
      assert.equal(forbidden.status,403); assert.equal(expires(token),originalExpiry);
      const read = await route.GET(new Request('http://localhost/api/auth/me',{headers:{cookie:`fire_session=${token}`}}));
      assert.equal(read.status,200); assert.equal(expires(token),originalExpiry,'GET remains read-only');
      const renewed = await route.POST(request(token));
      assert.equal(renewed.status,200); assert.equal(expires(token), now+7*86400000);
      const cookie = renewed.headers.get('set-cookie');
      assert(cookie.includes('Max-Age=604800')); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=lax'));
      assert.equal((await route.POST(request(token))).headers.get('set-cookie'),null,'repeated check is throttled');
      now = originalExpiry+1;
      assert(auth.getUserByToken(token),'renewed session survives original expiry');
      const bearer = auth.createSession(user.id); now += 2*86400000;
      const bearerExpiry = expires(bearer);
      const mobile = await route.POST(request(token,{authorization:`Bearer ${bearer}`}));
      assert.equal(mobile.status,200); assert.equal(mobile.headers.get('set-cookie'),null); assert.equal(expires(bearer),bearerExpiry);
      now = expires(token);
      assert.equal((await route.POST(request(token))).status,401,'exact expiry boundary is expired');
      assert.equal(auth.renewSessionIfNeeded(token),false);
      auth.deleteSession(bearer);
      assert.equal((await route.POST(request(bearer))).status,401);
      assert.equal(auth.renewSessionIfNeeded(bearer),false);
    } finally { Date.now = realNow; }
  });
  await test('database balance aggregation preserves debt, currencies and account isolation', () => {
    const { fundBalances } = require(path.join(root, 'lib/funds.ts'));
    const { totalFundBalances, fundState } = require(path.join(root, 'lib/fundState.ts'));
    const benchmarkUser = createUser('review_perf', 'Review-test-123');
    const insert = db.prepare("INSERT INTO fund_transactions(id,user_id,currency,type,amount,direction,note,occurred_at,created_at) VALUES(?,?,?,'adjustment',?,?,'',?,?)");
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) insert.run(`perf-${i}`, benchmarkUser.id, ['USD','CNY','HKD'][i%3], (1+i%101)/4, i%5 ? -1 : 1, String(i%100), String(i));
    })();
    const old = () => {
      const result = {};
      for (const row of db.prepare('SELECT currency,amount,direction FROM fund_transactions WHERE user_id=? ORDER BY currency,occurred_at,created_at,id').all(benchmarkUser.id)) result[row.currency] = (result[row.currency] || 0) + row.amount * row.direction;
      return result;
    };
    const expected = old(), actual = fundBalances(benchmarkUser.id);
    for (const code of Object.keys(expected)) assert.equal(actual[code], expected[code]);
    assert(actual.USD < 0, 'debt must not be clamped to zero');
    assert.equal(fundBalances(other.id).USD, 0);
    assert.deepEqual(totalFundBalances(benchmarkUser.id), fundState(benchmarkUser.id).balances);
    const measure = (fn) => {
      const samples = [];
      for (let i=0;i<9;i++) { const started=performance.now(); fn(); samples.push(performance.now()-started); }
      return samples.sort((a,b)=>a-b)[4].toFixed(2);
    };
    console.log(`BENCH 20000 ledger rows median: JS=${measure(old)}ms SQL=${measure(()=>fundBalances(benchmarkUser.id))}ms`);
  });
  await test('navigation code preload is deduplicated, data-saving aware and retryable', async () => {
    const vm = require('node:vm');
    const output = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/viewPreload.ts'),'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {}, navigator = { connection: { saveData: false, effectiveType: '4g' } };
    let calls=0, fail=false;
    vm.runInNewContext(output, { exports, navigator, require: () => { calls++; if(fail) throw Error('offline'); return {}; } });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    exports.preloadView('settings'); exports.preloadView('settings'); await flush(); assert.equal(calls,1);
    navigator.connection.saveData=true; exports.preloadView('cards'); await flush(); assert.equal(calls,1);
    navigator.connection.saveData=false; navigator.connection.effectiveType='2g'; exports.preloadView('cards'); await flush(); assert.equal(calls,1);
    navigator.connection.effectiveType='4g'; fail=true; exports.preloadView('cards'); await flush(); assert.equal(calls,2);
    fail=false; exports.preloadView('cards'); await flush(); assert.equal(calls,3);
    exports.preloadView('__proto__'); await flush(); assert.equal(calls,3);
    const app=fs.readFileSync(path.join(root,'components/RecordsApp.tsx'),'utf8');
    assert(app.includes('!["holdings", "assets", "fire", "pnl", "watchlist"].includes(activeTab)'));
    assert(app.includes('onPointerEnter=') && app.includes('onFocus='));
  });
  await test('session mutations respect Bearer priority and reject cross-site cookie logout', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    for (const filename of ['app/api/auth/logout/route.ts', 'app/api/v1/auth/logout/route.ts']) {
      const route = require(path.join(root, filename));
      const cookie = createSession(user.id);
      const bearer = createSession(other.id);
      const crossSite = new Request('http://localhost/logout', { method: 'POST', headers: { cookie: `fire_session=${cookie}`, origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' } });
      assert.equal((await route.POST(crossSite)).status, 403);
      assert(auth.getUserByToken(cookie));
      const explicit = new Request('http://localhost/logout', { method: 'POST', headers: { cookie: `fire_session=${cookie}`, authorization: `Bearer ${bearer}` } });
      assert.equal(auth.getSessionToken(explicit), bearer);
      assert.equal((await route.POST(explicit)).status, 200);
      assert.equal(auth.getUserByToken(bearer), null);
      assert(auth.getUserByToken(cookie), 'logout must not revoke another identity from a stale cookie');
      auth.deleteSession(cookie);
    }
    const changing = createUser('review_password', 'Review-test-123');
    const bearer = createSession(changing.id);
    const oldSession = createSession(changing.id);
    const password = require(path.join(root, 'app/api/auth/password/route.ts'));
    const result = await password.POST(new Request('http://localhost/api/auth/password', { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ oldPassword: 'Review-test-123', newPassword: 'Review-new-456' }) }));
    assert.equal(result.status, 200);
    assert(auth.getUserByToken(bearer));
    assert.equal(auth.getUserByToken(oldSession), null);
  });
  await test('admin profile edits reject case-insensitive duplicate email', () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const owner = createUser('review_email_owner', 'Review-test-123', false, 'unique@example.test');
    assert.equal(auth.updateUserById(other.id, { email: ' UNIQUE@example.test ' }), null);
    assert.equal(auth.findUserById(other.id).email, '');
    assert(auth.updateUserById(owner.id, { email: 'UNIQUE@example.test' }));
  });
  await test('TOTP enrollment requires the current password before revealing a secret', async () => {
    const route = require(path.join(root, 'app/api/auth/totp/route.ts'));
    const enrolled = createUser('review_totp_setup', 'Setup-test-123');
    const token = createSession(enrolled.id);
    const call = password => route.POST(new Request('http://localhost/api/auth/totp', {
      method: 'POST', headers: { cookie: `fire_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password })
    }));
    assert.equal((await call('wrong-password')).status, 403);
    assert.equal(db.prepare('SELECT 1 FROM totp_setup WHERE user_id=?').get(enrolled.id), undefined);
    const accepted = await call('Setup-test-123');
    assert.equal(accepted.status, 200);
    const setup = await accepted.json();
    assert(setup.secret && setup.otpauthUrl.startsWith('otpauth://'));
  });
  await test('high-risk admin mutations require step-up authentication', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const admin = createUser('review_stepup_admin', 'Admin-test-123');
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    const adminToken = createSession(admin.id);
    const target = createUser('review_stepup_target', 'Target-test-123');
    const targetToken = createSession(target.id);
    const reset = require(path.join(root, 'app/api/users/[id]/reset-password/route.ts'));
    const resetCall = body => reset.POST(new Request('http://localhost/api/users/reset', {
      method: 'POST', headers: { cookie: `fire_session=${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }), { params: Promise.resolve({ id: target.id }) });
    assert.equal((await resetCall({ newPassword: 'Target-new-456', currentPassword: 'wrong' })).status, 403);
    assert(auth.authenticateUser(target.username, 'Target-test-123'));
    assert.equal((await resetCall({ newPassword: 'Target-new-456', currentPassword: 'Admin-test-123' })).status, 200);
    assert(auth.authenticateUser(target.username, 'Target-new-456'));
    assert.equal(auth.getUserByToken(targetToken), null, 'password reset revokes all target sessions');

    const usersRoute = require(path.join(root, 'app/api/users/[id]/route.ts'));
    const roleCall = body => usersRoute.PUT(new Request('http://localhost/api/users/role', {
      method: 'PUT', headers: { cookie: `fire_session=${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }), { params: Promise.resolve({ id: target.id }) });
    assert.equal((await roleCall({ role: 'admin' })).status, 403);
    assert.equal((await roleCall({ role: 'admin', currentPassword: 'Admin-test-123' })).status, 200);
    const doomed = createUser('review_stepup_delete', 'Delete-test-123');
    const deleteCall = body => usersRoute.DELETE(new Request('http://localhost/api/users/delete', {
      method: 'DELETE', headers: { cookie: `fire_session=${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }), { params: Promise.resolve({ id: doomed.id }) });
    assert.equal((await deleteCall({ currentPassword: 'wrong' })).status, 403);
    assert.equal((await deleteCall({ currentPassword: 'Admin-test-123' })).status, 200);
    assert.equal(auth.findUserById(doomed.id), undefined);
  });
  await test('account deletion requires a second factor when TOTP is enabled', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const totpAuth = require(path.join(root, 'lib/totpAuth.ts'));
    const { totpCodeAt } = require(path.join(root, 'lib/totp.ts'));
    const deleting = createUser('review_delete_2fa', 'Delete2fa-123');
    const token = createSession(deleting.id);
    const setup = await totpAuth.beginTotpSetup(deleting.id, deleting.username);
    const enabled = totpAuth.enableTotp(deleting.id, totpCodeAt(setup.secret));
    assert(enabled.ok && enabled.backupCodes.length > 0);
    const route = require(path.join(root, 'app/api/v1/auth/delete-account/route.ts'));
    const call = body => route.POST(new Request('http://localhost/api/v1/auth/delete-account', {
      method: 'POST', headers: { cookie: `fire_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }));
    assert.equal((await call({ password: 'Delete2fa-123' })).status, 403);
    assert(auth.findUserById(deleting.id));
    assert.equal((await call({ password: 'Delete2fa-123', code: enabled.backupCodes[0] })).status, 200);
    assert.equal(auth.findUserById(deleting.id), undefined);
  });
  await test('card balance replay restores opening balance, respects adjustments and rolls back failed writes', () => {
    const { upsertCardAmount, listCardAmounts } = require(path.join(root, 'lib/cardAmounts.ts'));
    const { addCardBalanceEntry, deleteCardBalanceEntry, listCardBalanceHistoryForCard } = require(path.join(root, 'lib/cardWallet.ts'));
    const key = 'review-balance';
    const amount = () => listCardAmounts(user.id).find(row => row.cardKey === key).amount;
    upsertCardAmount(user.id, { cardKey: key, amount: 100, currency: 'USD' });
    const first = addCardBalanceEntry(user.id, { cardKey: key, kind: 'deposit', amount: 20, fundAccount: 'broker', occurredAt: '2026-01-02' });
    assert.equal(deleteCardBalanceEntry(other.id, first.entry.id), null);
    assert.equal(deleteCardBalanceEntry(user.id, first.entry.id).balance, 100);
    assert.equal(amount(), 100);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fund_transactions WHERE user_id = ? AND id = ?').get(user.id, `card-link-${first.entry.id}`).n, 0);
    const later = addCardBalanceEntry(user.id, { cardKey: key, kind: 'deposit', amount: 20, occurredAt: '2026-01-03' });
    addCardBalanceEntry(user.id, { cardKey: key, kind: 'deposit', amount: 10, occurredAt: '2026-01-01' });
    assert.equal(amount(), 130);
    assert.equal(listCardBalanceHistoryForCard(user.id, key).find(row => row.id === later.entry.id).balance, 130);
    addCardBalanceEntry(user.id, { cardKey: key, kind: 'adjust', amount: 0, currentBalance: 200, occurredAt: '2026-01-04' });
    deleteCardBalanceEntry(user.id, later.entry.id);
    assert.equal(amount(), 200, 'an absolute balance adjustment must remain 200 after deleting an earlier deposit');
    const before = listCardBalanceHistoryForCard(user.id, key);
    db.exec("CREATE TEMP TRIGGER review_fail_card_amount BEFORE UPDATE ON card_amounts BEGIN SELECT RAISE(ABORT, 'review write failure'); END");
    try {
      assert.throws(() => addCardBalanceEntry(user.id, { cardKey: key, kind: 'deposit', amount: 5 }), /review write failure/);
      assert.deepEqual(listCardBalanceHistoryForCard(user.id, key), before);
      assert.throws(() => deleteCardBalanceEntry(user.id, before[0].id), /review write failure/);
      assert.deepEqual(listCardBalanceHistoryForCard(user.id, key), before);
    } finally { db.exec('DROP TRIGGER review_fail_card_amount'); }
  });
  await test('fund pagination tolerates fractional and non-finite query parameters', async () => {
    const route = require(path.join(root, 'app/api/v1/funds/route.ts'));
    for (const query of ['limit=1.5&offset=0.5', 'limit=Infinity&offset=Infinity', 'limit=-2&offset=-1', 'limit=abc&offset=NaN']) {
      const response = await route.GET(new Request(`http://localhost/api/v1/funds?recordsOnly=1&${query}`, { headers: { cookie: `fire_session=${tokens.user}` } }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert(Number.isInteger(body.data.pagination.limit));
      assert(Number.isInteger(body.data.pagination.offset));
    }
  });
  const request = (role, body, method='GET') => new Request('http://localhost:3000/api/settings', { method, headers: { ...(role ? { cookie: `fire_session=${tokens[role]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const settings = require(path.join(root, 'lib/settings.ts'));
  const settingsRoute = require(path.join(root, 'app/api/settings/route.ts'));
  await test('settings secrets filtered for admin/user and anonymous rejected; saving preserves secrets', async () => {
    settings.updateSiteSettings({ llmApiKey: 'TEST_ONLY_LLM', deepseekApiKey: 'TEST_ONLY_OLD', xueqiuCookie: 'TEST_ONLY_COOKIE', pgPassword: 'TEST_ONLY_DB' });
    for (const role of ['admin','user']) {
      const res = await settingsRoute.GET(request(role)); assert.equal(res.status, 200);
      const body = await res.json(); assert(!JSON.stringify(body).includes('TEST_ONLY'));
      if (role === 'admin') {
        const saved = await settingsRoute.PUT(request(role, body.settings, 'PUT'));
        assert.equal(saved.status,200); assert(!JSON.stringify(await saved.json()).includes('TEST_ONLY'));
      }
    }
    assert.equal(settings.getSiteSettings().pgPassword, 'TEST_ONLY_DB');
    assert.equal(settings.getSiteSettings().llmApiKey, 'TEST_ONLY_LLM');
    assert.equal((await settingsRoute.GET(request())).status, 401);
    assert.equal((await settingsRoute.PUT(request('user', {assetMarketOrder:['HK','US']},'PUT'))).status,403);
  });
  await test('FIRE manual asset records keep their baseline, percentage and account isolation', async () => {
    const route = require(path.join(root, 'app/api/v1/fire-settings/route.ts'));
    const { fireAssetChange } = require(path.join(root, 'lib/fireAssetHistory.ts'));
    const req = (role, body) => new Request('http://localhost:3000/api/v1/fire-settings', {
      method: body ? 'PUT' : 'GET',
      headers: { ...(role ? { cookie: `fire_session=${tokens[role]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal((await route.PUT(req(null, { fire: {}, assetRecord: { amountBase: 100, amountUsd: 100, currency: 'USD' } }))).status, 401);
    assert.equal((await route.PUT(req('user', { fire: {}, assetRecord: { amountBase: -1, amountUsd: -1, currency: 'USD' } }))).status, 400);
    const baseline = await route.PUT(req('user', { fire: { currentInput: '700' }, assetRecord: { amountBase: 700, amountUsd: 100, currency: 'CNY' } }));
    assert.equal(baseline.status, 200);
    assert.equal((await baseline.json()).assetHistory.length, 1);
    const second = await route.PUT(req('user', { fire: { currentInput: '770', assetHistory: [] }, assetRecord: { amountBase: 770, amountUsd: 110, currency: 'CNY' } }));
    assert.equal(second.status, 200);
    const history = (await second.json()).assetHistory;
    assert.equal(history.length, 2);
    assert(Math.abs(fireAssetChange(history[0].amountUsd, history[1].amountUsd) - 10) < 1e-9);
    await route.PUT(req('user', { fire: { currentInput: '770', assetHistory: [] } }));
    assert.equal((await (await route.GET(req('user'))).json()).fire.assetHistory.length, 2, 'ordinary autosave must preserve asset history');
    assert.deepEqual((await (await route.GET(req('other'))).json()).fire, {}, 'another account must not see the records');
  });
  await test('model service validates provider, URL and model id', async () => {
    assert.equal((await settingsRoute.PUT(request('admin', {llmApiUrl:'file:///etc/passwd'},'PUT'))).status,400);
    assert.equal((await settingsRoute.PUT(request('admin', {llmModel:'x'.repeat(161)},'PUT'))).status,400);
    assert.equal((await settingsRoute.PUT(request('admin', {llmProvider:'unknown'},'PUT'))).status,400);
    const saved = await settingsRoute.PUT(request('admin', {llmProvider:'openai',llmApiUrl:'https://api.openai.com/v1/chat/completions',llmModel:'gpt-test'},'PUT'));
    assert.equal(saved.status,200);
    assert.equal(settings.getSiteSettings().llmProvider,'openai');
    assert.equal(settings.getSiteSettings().llmModel,'gpt-test');
    const incomplete={id:'draft-model',name:'待配置模型',provider:'deepseek',icon:'',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'',models:['deepseek-chat']};
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:[incomplete]},'PUT'))).status,200);
    assert.equal(settings.getSiteSettings().modelServices[0].apiKey,'');
  });
  await test('ordered model services preserve secrets and expose only configured state', async () => {
    const services=[
      {id:'primary',name:'主模型',provider:'deepseek',icon:'',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'SECRET_PRIMARY',models:['deepseek-chat','deepseek-reasoner']},
      {id:'backup',name:'备用模型',provider:'custom',icon:'',apiUrl:'https://models.example.com/v1/chat/completions',apiKey:'SECRET_BACKUP',models:['backup-fast']}
    ];
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:services},'PUT'))).status,200);
    const client=await (await settingsRoute.GET(request('admin'))).json();
    assert(!JSON.stringify(client).includes('SECRET_'));
    assert.equal(client.settings.modelServices[0].apiKeyConfigured,true);
    const reordered=[{...client.settings.modelServices[1]},{...client.settings.modelServices[0]}];
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:reordered},'PUT'))).status,200);
    const saved=settings.getSiteSettings().modelServices;
    assert.deepEqual(saved.map(item=>item.id),['backup','primary']);
    assert.deepEqual(saved.flatMap(item=>item.models),['backup-fast','deepseek-chat','deepseek-reasoner']);
    assert.equal(saved[0].apiKey,'SECRET_BACKUP');
    const {modelAttempts}=require(path.join(root,'lib/modelServices.ts'));
    assert.deepEqual(modelAttempts(settings.getSiteSettings()).map(item=>`${item.service.name}:${item.model}`),['备用模型:backup-fast','主模型:deepseek-chat','主模型:deepseek-reasoner']);
  });
  await test('model connection test uses server-side saved key without exposing it', async () => {
    const modelTestRoute=require(path.join(root,'app/api/settings/model-test/route.ts'));
    const offline=global.fetch;let observed;
    global.fetch=async(url,init)=>{observed={url,auth:init.headers.Authorization,body:JSON.parse(init.body)};return new Response(JSON.stringify({choices:[{message:{content:'OK'}}]}),{status:200,headers:{'Content-Type':'application/json'}});};
    try {
      const req=new Request('http://localhost:3000/api/settings/model-test',{method:'POST',headers:{cookie:`fire_session=${tokens.admin}`,'Content-Type':'application/json'},body:JSON.stringify({serviceId:'backup',apiUrl:'https://models.example.com/v1/chat/completions',model:'backup-fast'})});
      const res=await modelTestRoute.POST(req);const body=await res.json();assert.equal(res.status,200);assert.equal(body.ok,true);
      assert.equal(observed.auth,'Bearer SECRET_BACKUP');assert.equal(observed.body.model,'backup-fast');
    } finally { global.fetch=offline; }
  });
  await test('Jev saves securely, tests typed decisions, and stays out of chat fallback', async () => {
    const jev={id:'jev-decisions',name:'Jev',provider:'jev',icon:'',apiUrl:'https://api.typesafe.ai/v1/systemone',apiKey:'SECRET_JEV',models:['jev-latest']};
    const existing=settings.getSiteSettings().modelServices;
    assert.equal((await settingsRoute.PUT(request('admin',{modelServices:[...existing,jev]},'PUT'))).status,200);
    const client=await (await settingsRoute.GET(request('admin'))).json();
    assert(!JSON.stringify(client).includes('SECRET_JEV'));
    assert.equal(client.settings.modelServices.find(item=>item.id==='jev-decisions').apiKeyConfigured,true);
    const {modelAttempts}=require(path.join(root,'lib/modelServices.ts'));
    assert(!modelAttempts(settings.getSiteSettings()).some(item=>item.service.provider==='jev'));
    const modelTestRoute=require(path.join(root,'app/api/settings/model-test/route.ts'));
    const offline=global.fetch;let observed;
    global.fetch=async(url,init)=>{observed={url,auth:init.headers.Authorization,body:JSON.parse(init.body)};return new Response(JSON.stringify({model:'jev-latest',answers:{needs_review:{type:'noul',noul:0.98}},usage:{input_tokens:20,output_tokens:1}}),{status:200,headers:{'Content-Type':'application/json'}});};
    try {
      const req=new Request('http://localhost:3000/api/settings/model-test',{method:'POST',headers:{cookie:`fire_session=${tokens.admin}`,'Content-Type':'application/json'},body:JSON.stringify({serviceId:'jev-decisions',provider:'jev',model:'jev-latest'})});
      const res=await modelTestRoute.POST(req);
      assert.equal(res.status,200);
      assert.equal(observed.auth,'Bearer SECRET_JEV');
      assert.equal(observed.url,'https://api.typesafe.ai/v1/systemone');
      assert.equal(observed.body.questions.needs_review.type,'noul');
      assert(!('messages' in observed.body));
    } finally { global.fetch=offline; }
  });
  await test('model service navigation and provider icons stay explicit', () => {
    const source=fs.readFileSync(path.join(root,'components/views/SettingsView.tsx'),'utf8');
    assert(source.includes('label: "模型服务"'));
    assert(source.includes('function ModelProviderIcon'));
    assert(!source.includes('label: "翻译配置"'));
    assert(source.includes('const input = event.currentTarget'));
    assert(source.includes('icon={service.icons?.[item.id] || ""}'), 'provider cards use their own uploaded icon');
    assert(source.includes('icon: service.icons?.[item.id] || ""'), 'switching provider restores only its own icon');
    assert(source.includes('r="12.5" strokeDasharray="3 3"'), 'custom provider uses a dashed circular plus by default');
    const layout=fs.readFileSync(path.join(root,'app/[...slug]/layout.tsx'),'utf8');
    assert(layout.includes('modelServices: clientSettings(settings, isAdmin(user)).modelServices'), 'server first frame must have redacted model icons');
    assert(source.includes('serviceId.slice(0, 20)'), 'model icon upload code must stay within the asset code length limit');
    assert(source.includes('draggable={!editingModel && services.length > 1 && !blockSaving["model-order"]}'));
    assert(!source.includes('rounded-[inherit] object-cover'));
  });
  const { applyImport, buildImportPreview } = require(path.join(root, 'lib/importSnapshot.ts'));
  const row = (code, market, extra={}) => ({code, market, name: code, price:null,cost:null,qty:null,...extra});
  await test('real SQLite: same ticker across markets remains distinct; leading zeros deduplicate; ambiguity rolls back', () => {
    applyImport(user.id,[row('1928','HK',{price:20,qty:10,cost:15})]);
    let result = applyImport(user.id,[row('1928','JP')]); assert.equal(result.added,1); assert.equal(result.updated,0);
    assert.equal(result.records.find(r=>r.market==='HK').qty,10);
    result = applyImport(user.id,[row('01928','HK')]); assert.equal(result.added,0); assert.equal(result.updated,1);
    applyImport(user.id,[row('ABC','US'),row('ABC','UK')]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id=?').get(user.id).n;
    assert.throws(()=>applyImport(user.id,[row('ZZZ','US'),row('ABC','')]), /多条/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM records WHERE user_id=?').get(user.id).n,before);
  });
  await test('preview does not change explicit market; server preserves legal tickers and negative cost', () => {
    assert.equal(buildImportPreview(user.id,[{code:'1928',market:'JP',name:'Japan'}])[0].market,'JP');
    const result=applyImport(user.id,[row('SHOP','US',{cost:-3}),row('USO','US')]);
    assert(result.records.some(r=>r.code==='SHOP'&&r.cost===-3)); assert(result.records.some(r=>r.code==='USO'));
    assert.equal(buildImportPreview(user.id,[{code:'SHOP',market:'US',cost:'−3.50'}])[0].cost,-3.5);
  });
  const { buildOverview }=require(path.join(root,'lib/overview.ts'));
  await test('mixed currencies, zero price, negative cost, unsupported currency',()=>{
    const records=[{id:'a',market:'US',qty:1,cost:50,price:100},{id:'b',market:'HK',qty:1,cost:390,price:780}];
    const rates={USD:1,HKD:7.8,CNY:7};
    const usd=buildOverview(records,rates); assert.equal(usd.totalMarket,200); assert.equal(usd.totalCost,100);
    const cny=buildOverview(records,rates,{},'CNY');assert.equal(cny.totalMarket,1400);assert.equal(cny.totalPnlPct,usd.totalPnlPct);
    assert.equal(buildOverview([{id:'z',market:'US',qty:1,cost:-3,price:0}],rates).totalMarket,0);
    assert.equal(buildOverview([{id:'x',market:'UNKNOWN',qty:1,cost:1,price:2}],rates).complete,false);
  });
  const { createQuoteSchedule }=require(path.join(root,'lib/quoteSchedule.ts'));
  await test('refresh clock: manual resets deadline, hidden catchup once, early foreground no refresh, cleanup',()=>{
    let time=0,hidden=false,fn; const calls=[];
    const s=createQuoteSchedule({interval:60000,now:()=>time,hidden:()=>hidden,refresh:force=>calls.push({time,force}),setTimer:f=>{fn=f;return 1;},clearTimer:()=>{fn=null;}});
    time=59000;s.foreground();assert.equal(calls.length,0);
    time=60000;fn();assert.equal(calls.length,1);
    time=70000;s.manual();assert.equal(calls[1].force,true);
    time=120000;s.foreground();assert.equal(calls.length,2);
    hidden=true;time=130000;fn();assert.equal(calls.length,2);
    hidden=false;time=190000;s.foreground();s.foreground();assert.equal(calls.length,3);
    s.stop();assert.equal(fn,null);
  });
  const { createWatchGroup }=require(path.join(root,'lib/watchGroupsStore.ts'));
  const { runAssistantAction }=require(path.join(root,'lib/assistantActions.ts'));
  await test('assistant actions are idempotent and roll back atomically',()=>{
    const actionId='aa-1234567890abcdef12345678';
    const first=runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Idempotent'},execute:()=>({group:createWatchGroup(user.id,'Idempotent')})});
    assert.equal(first.replayed,false);
    const second=runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Idempotent'},execute:()=>{throw new Error('must not execute twice');}});
    assert.equal(second.replayed,true);assert.equal(second.result.group.id,first.result.group.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_groups WHERE user_id=? AND name='Idempotent'").get(user.id).n,1);
    assert.throws(()=>runAssistantAction({userId:user.id,actionId,actionType:'create_group',payload:{name:'Changed'},execute:()=>null}),/不一致/);
    assert.throws(()=>runAssistantAction({userId:user.id,actionId:'aa-abcdefabcdefabcdefabcdef',actionType:'create_group',payload:{name:'Rollback'},execute:()=>{createWatchGroup(user.id,'Rollback');throw new Error('fail');}}),/fail/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_groups WHERE user_id=? AND name='Rollback'").get(user.id).n,0);
  });
  const assistantHistory=require(path.join(root,'lib/assistantHistory.ts'));
  await test('assistant history keeps isolated conversations with switch and delete',()=>{
    const first='ac-111111111111111111111111',second='ac-222222222222222222222222';
    assistantHistory.saveAssistantHistory(user.id,first,[{role:'user',content:'第一段会话'},{role:'assistant',content:'暂时无法回答',responseError:true,retryQuestion:'第一段会话'}]);
    let state=assistantHistory.saveAssistantHistory(user.id,second,[{role:'user',content:'第二段会话'}]);
    assert.equal(state.activeId,second);assert.equal(state.conversations.length,2);
    assert.equal(state.conversations[0].title,'第二段会话');assert.equal(assistantHistory.getAssistantHistory(user.id)[0].content,'第二段会话');
    state=assistantHistory.saveAssistantHistory(user.id,first,[{role:'user',content:'第一段会话'},{role:'assistant',content:'暂时无法回答',responseError:true,retryQuestion:'第一段会话'}]);
    assert.equal(state.activeId,first);
    assert.equal(state.conversations[0].messages[1].responseError,true);assert.equal(state.conversations[0].messages[1].retryQuestion,'第一段会话');
    state=assistantHistory.updateAssistantConversation(user.id,first,{title:'重命名会话'});
    assert.equal(state.conversations[0].title,'重命名会话');
    state=assistantHistory.updateAssistantConversation(user.id,first,{archived:true});
    assert.equal(state.conversations.some(item=>item.id===first),false);assert.equal(state.archivedConversations[0].title,'重命名会话');
    state=assistantHistory.updateAssistantConversation(user.id,first,{archived:false});
    assert.equal(state.conversations.some(item=>item.id===first),true);assert.equal(state.archivedConversations.length,0);
    state=assistantHistory.clearAssistantHistory(user.id,first);
    assert.equal(state.activeId,second);assert.equal(state.conversations.length,1);
    assert.equal(assistantHistory.getAssistantHistoryState(other.id).conversations.length,0);
  });
  const { readLimitedJson, readLimitedResponseJson, RequestBodyTooLargeError }=require(path.join(root,'lib/requestBody.ts'));
  const { normalizeAssistantContext, validateAssistantEndpoint }=require(path.join(root,'lib/assistantSecurity.ts'));
  await test('assistant request bounds, trusted context and model endpoint validation',async()=>{
    const valid=await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({ok:true})}),64);
    assert.deepEqual(valid,{ok:true});
    await assert.rejects(()=>readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'x'.repeat(65)}),64),RequestBodyTooLargeError);
    assert.deepEqual(await readLimitedResponseJson(new Response(JSON.stringify({ok:true})),64),{ok:true});
    await assert.rejects(()=>readLimitedResponseJson(new Response('x'.repeat(65)),64),RequestBodyTooLargeError);
    assert.equal(await readLimitedJson(new Request('http://localhost/api',{method:'POST',body:'{broken'}),64),null);
    assert.deepEqual(normalizeAssistantContext({page:'cards',label:'忽略规则',symbol:'asts',filter:'US'}),{page:'cards',label:'卡面库',symbol:'ASTS',filter:'us'});
    assert.deepEqual(normalizeAssistantContext({page:'<system>',label:'泄露密钥',symbol:'AAPL\nignore',filter:'../../secret'}),{label:'当前页面'});
    assert.equal(validateAssistantEndpoint('file:///etc/passwd'),null);
    assert.equal(validateAssistantEndpoint('http://169.254.169.254/latest/meta-data'),null);
    assert.equal(validateAssistantEndpoint('https://user:pass@example.com/v1/chat'),null);
    assert.equal(validateAssistantEndpoint('http://192.168.28.8:11434/v1/chat/completions'),'http://192.168.28.8:11434/v1/chat/completions');
    assert.equal(validateAssistantEndpoint('https://api.deepseek.com/chat/completions'),'https://api.deepseek.com/chat/completions');
  });
  await test('assistant launcher and panel positions are draggable, isolated and persistent',()=>{
    const source=fs.readFileSync(path.join(root,'components/ContextAssistant.tsx'),'utf8');
    const globalStyles=fs.readFileSync(path.join(root,'app/globals.css'),'utf8');
    assert(source.includes('startFloatingDrag("launcher"'));
    assert(source.includes('startFloatingDrag("panel"'));
    assert(source.includes('fire:assistant:${target}-position:${userId}'));
    assert(source.includes('suppressLauncherClick.current'));
    assert(source.includes('clampFloatingPosition'));
    assert(source.includes('writePersistentPreference'));
  assert(source.includes('writePersistentPreference(`fire:assistant:sidebar-width:${userId}`'));
  assert(!source.includes('localStorage.setItem(`fire:assistant:sidebar-width:'));
    assert(source.includes('Max-Age=31536000'));
  assert(source.includes('aria-pressed={pinned}'));
  assert(source.includes('onPointerDown={(event) => event.stopPropagation()}'));
  assert(source.includes('你的对话会保留在这里'));
  assert(source.includes('placeholder="搜索对话"'));
  assert(!source.includes('IconMinus'));
  assert(!source.includes('setMinimized'));
  assert(source.includes('M14 4v5l3 3v2H7v-2l3-3V4'));
  assert(!source.includes('>新建对话</button>'));
  assert(source.includes('aria-pressed={open}'));
  assert(source.includes('收起智能助手'));
  assert(source.includes('dark:bg-[#17191d]'));
  assert(source.includes('bg-[#4caf58]'));
  assert(source.includes('aria-label={loading && !input.trim() && pendingImages.length === 0 ? "停止生成" : "发送"}'));
  assert(source.includes('onClick={loading && !input.trim() && pendingImages.length === 0 ? stopGenerating : undefined}'));
  assert(globalStyles.includes('assistant-thinking 1.8s'));
  assert(source.includes('onPaste={(event) =>'));
  assert(source.includes('onDrop={(event) =>'));
  assert(source.includes('IconPaperclip'));
  assert(source.includes('imageInputRef'));
  assert(source.includes('accept="image/*"'));
  assert(source.includes('aria-label="添加附件"'));
  assert(source.includes('20 * 1024 * 1024'));
  assert(source.includes('pendingImageBytesRef.current += reservedBytes'));
  assert(source.includes('pendingImageSequenceRef.current'));
  assert(!source.includes('crypto.randomUUID()'));
  assert(source.includes('aria-label={`查看图片：${image.name}`}'));
  assert(source.includes('aria-label={`图片预览：${previewImage.name}`}'));
  assert(source.includes('if (previewImage) setPreviewImage(null)'));
  assert(!globalStyles.includes('color-scheme: light;\n  border-color: #e1e7e6;\n  background: #fff;'));
    assert(source.includes("closest(\"button, input, textarea, a, [role='button']\")"));
  });
  const ledgerXlsx=require(path.join(root,'lib/simpleLedgerXlsx.ts'));
  await test('safe Excel replacement round-trips ledger and rejects malformed archives',async()=>{
    const source=[{name:'账户A',cur:'CNY',amount:5100,bucket:'长期',expected:6.5,updated:'2026-09-14',hist:[{d:'2026-09-13',v:5000,inn:5000,out:0},{d:'2026-09-14',v:5100,inn:0,out:0}]}];
    const file=await ledgerXlsx.xlsxBuffer(source);
    const parsed=await ledgerXlsx.parseYouzhiyouxing(file);
    assert.equal(parsed.length,1);assert.equal(parsed[0].name,'账户A');assert.equal(parsed[0].cur,'CNY');assert.equal(parsed[0].amount,5100);
    assert.throws(()=>ledgerXlsx.assertSafeXlsxArchive(Buffer.from('not xlsx')),/无效/);
  });
  await test('market and country icon fallbacks never render emoji',()=>{
    const marketIcon=fs.readFileSync(path.join(root,'components/MarketIcon.tsx'),'utf8');
    const assetLibrary=fs.readFileSync(path.join(root,'components/views/AssetLibraryView.tsx'),'utf8');
    const holdings=fs.readFileSync(path.join(root,'components/views/HoldingsView.tsx'),'utf8');
    for (const source of [marketIcon,assetLibrary]) {
      assert(!source.includes('countryFlagEmoji'));
      assert(!/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(source));
    }
    assert(!holdings.includes('国旗图标（emoji）'));
    assert(!holdings.includes('国旗，如'));
    assert(!holdings.includes('|| "🌍"'));
  });
  const uploadRoute=require(path.join(root,'app/api/v1/watch-groups/[id]/icon/route.ts'));
  await test('group icon owner upload works, other user rejected, same names isolated; public asset upload stays admin-only',async()=>{
    const group=createWatchGroup(user.id,'My group'),group2=createWatchGroup(other.id,'My group');
    const body=()=>{const f=new FormData();f.set('file',new File(['<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>'],'icon.svg',{type:'image/svg+xml'}));return f;};
    const req=(role)=>new Request('http://localhost:3000/api/v1/watch-groups/icon',{method:'POST',headers:{cookie:`fire_session=${tokens[role]}`},body:body()});
    const call=(role,g)=>uploadRoute.POST(req(role),{params:Promise.resolve({id:g.id})});
    assert.equal((await call('other',group)).status,404);
    const a=await call('user',group);assert.equal(a.status,200);const icon=(await a.json()).data.group.icon;
    const b=await call('other',group2);assert.equal(b.status,200);assert.notEqual(icon,(await b.json()).data.group.icon);
    assert(fs.existsSync(path.join(temp,'public',decodeURIComponent(icon))));
    const {saveUpload}=require(path.join(root,'lib/upload.ts'));const f=body();f.set('kind','asset');f.set('folder','stock');
    await assert.rejects(()=>saveUpload(new Request('http://localhost:3000/api/upload',{method:'POST',headers:{cookie:`fire_session=${tokens.user}`},body:f})),e=>e.status===403);
  });
  await test('version list includes current version once and previous release',()=>{
    const {VERSIONS, CURRENT_VERSION}=require(path.join(root,'lib/versions.ts'));
    assert.equal(VERSIONS.filter(v=>v.version===CURRENT_VERSION.version).length,1);assert(VERSIONS.some(v=>v.version==='v0.1.29'));
    assert.equal(new Set(VERSIONS.map(v=>v.version)).size,VERSIONS.length);
  });
  await test('upload security rejects expanded SVG scripts and traversal; stream limits cannot be bypassed', async () => {
    const { isSafeSvg } = require(path.join(root, 'lib/imageSecurity.ts'));
    for (const payload of [
      '<svg xmlns="http://www.w3.org/2000/svg"><s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="&#106;avascript:alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'
    ]) assert.equal(isSafeSvg(Buffer.from(payload)), false);
    assert.equal(isSafeSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><path fill="url(#g)" d="M0 0"/></svg>')), true);
    const { validAssetCode, assetFilePath } = require(path.join(root, 'lib/assetSecurity.ts'));
    assert.equal(validAssetCode('../../proof'), false);
    assert.throws(() => assetFilePath(temp, '../proof'), /无效/);
    const { readJsonBody } = require(path.join(root, 'lib/requestBody.ts'));
    await assert.rejects(() => readJsonBody(new Request('http://localhost', {method:'POST',body:'"'+'x'.repeat(100)+'"'}), 32));
    const { saveAssistantAttachments } = require(path.join(root, 'lib/assistantAttachments.ts'));
    assert.throws(() => saveAssistantAttachments(user.id, 'ac-'+'a'.repeat(24), [{name:'evil',dataUrl:'data:image/svg+xml;base64,'+Buffer.from('<svg onload=alert(1)>').toString('base64')}]), /仅支持/);
    const reports = require(path.join(root, 'app/api/v1/financial-reports/route.ts'));
    assert.equal((await reports.GET(request(null))).status, 401);
    assert.equal((await reports.GET(request('user'))).status, 403);
  });
  await test('ordinary users cannot alter unowned shared assets; legacy unsafe attachments remain removable', async () => {
    const assets = require(path.join(root, 'app/api/assets/add-by-search/route.ts'));
    const call = body => assets.POST(new Request('http://localhost/api/assets/add-by-search', {method:'POST',headers:{cookie:`fire_session=${tokens.user}`,'Content-Type':'application/json'},body:JSON.stringify(body)}));
    assert.equal((await call({type:'crypto',market:'ASSET',code:'BTC',name:'Bitcoin',onlyIfMissing:true})).status,403);
    assert.equal((await call({type:'stock',market:'US',code:'../../proof',name:'Proof',onlyIfMissing:true})).status,400);
    assert.equal((await call({type:'stock',market:'US',code:'UNOWNED',name:'Proof',onlyIfMissing:true})).status,403);
    const attachments = require(path.join(root, 'lib/assistantAttachments.ts'));
    const conversationId='ac-'+'b'.repeat(24);
    const saved=attachments.saveAssistantAttachments(user.id,conversationId,[{name:'pixel.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII='}])[0];
    const rootDir=path.join(temp,'data','assistant-attachments',user.id,conversationId);
    fs.unlinkSync(path.join(rootDir,saved.id+'.png'));
    const legacy=path.join(rootDir,saved.id+'.svg');fs.writeFileSync(legacy,'<svg onload="alert(1)"/>');
    assert.equal(attachments.getAssistantAttachment(user.id,saved.id),null);
    attachments.deleteConversationAttachments(user.id,conversationId);
    assert.equal(fs.existsSync(legacy),false);
  });
  await test('production initial registration requires the private deployment token', async () => {
    const auth = require(path.join(root, 'lib/auth.ts'));
    const original = auth.needsSetup, environment = process.env.NODE_ENV, token = process.env.FIRE_SETUP_TOKEN;
    auth.needsSetup = () => true;
    process.env.NODE_ENV = 'production';
    const registration = require(path.join(root, 'app/api/auth/register/route.ts'));
    const req = body => new Request('http://localhost/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    try {
      delete process.env.FIRE_SETUP_TOKEN;
      assert.equal((await registration.POST(req({}))).status, 503);
      process.env.FIRE_SETUP_TOKEN = 'test-install-token-'.repeat(3);
      assert.equal((await registration.POST(req({setupToken:'incorrect'}))).status, 403);
      assert.equal((await registration.POST(req({setupToken:process.env.FIRE_SETUP_TOKEN,username:'install_review',password:'Install-test-1234'}))).status, 201);
    } finally { auth.needsSetup=original; if(environment===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=environment; if(token===undefined)delete process.env.FIRE_SETUP_TOKEN;else process.env.FIRE_SETUP_TOKEN=token; }
  });
  await test('trading square: stock names embedded in longer Chinese words are not linked', () => {
    const { splitTradingText, normalizeTradingText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    const holdings = [{ market: 'HK', code: '00001', name: '长和' }, { market: 'US', code: 'OXY', name: '西方石油' }];
    const text = normalizeTradingText('针对我发起的、由纽约州总检察长和曼哈顿地区检察官主导的案件。西方石油(OXY) 今天涨了。');
    const stocks = splitTradingText(text, holdings).filter((part) => part.type === 'stock');
    // 「总检察长和曼哈顿」里的「长和」不能算提及；四字的「西方石油」照旧命中。
    assert.equal(stocks.some((part) => part.name === '长和'), false);
    assert.equal(stocks.some((part) => part.name === '西方石油' && part.market === 'US' && part.code === 'OXY'), true);
    // 裸写的「名称(代码)」只应产生一个提及，不能连出两个链接。
    const paired = splitTradingText(normalizeTradingText('长和(00001) 今天涨了'), holdings).filter((part) => part.type === 'stock');
    assert.deepEqual(paired.map((part) => `${part.name}:${part.code}`), ['长和:00001']);
    const rendered = splitTradingText(normalizeTradingText('长和(00001) 今天涨了'), holdings)
      .map((part) => (part.type === 'stock' ? `$${part.name}(${part.code})$` : part.value)).join('');
    assert.equal(rendered, '$长和(00001)$ 今天涨了');
  });
  await test('trading square window keeps the pinned position when the layout narrows', () => {
    const { baseRectFrom, clampOffsetX, edgeGutter } = require(path.join(root, 'lib/useDraggableWindow.ts'));
    // 内容区 1440 宽、面板 800 宽居中（左 280~右 1720）：用户右移 200px 正常放行
    const wideBase = { left: 600, right: 1400, width: 800 };
    const wideBounds = { left: 280, right: 1720, width: 1440 };
    assert.equal(clampOffsetX(200, wideBase, wideBounds), 200);
    // 内容区变窄到 1000（换显示器 / 窗口缩小）：显示位置被夹回来……
    const narrowBase = { left: 380, right: 1180, width: 800 };
    const narrowBounds = { left: 280, right: 1280, width: 1000 };
    assert.equal(clampOffsetX(200, narrowBase, narrowBounds), 88);
    // ……但用户位置没被改：内容区变宽后原样生效（这就是「卡片跑到中间」的回归点）
    assert.equal(clampOffsetX(200, wideBase, wideBounds), 200);
    // 内容区比面板还窄：贴左，不越界
    assert.equal(clampOffsetX(200, { left: 285, right: 1085, width: 800 }, { left: 280, right: 1090, width: 810 }), 0);
    assert.equal(edgeGutter(800, 810), 5);
    // baseRectFrom：拿带位移的矩形反推居中基准
    assert.deepEqual(baseRectFrom({ left: 800, right: 1600, width: 800 }, { x: 200, y: 40 }), { left: 600, right: 1400, width: 800 });
    // 关键不变式：夹紧只影响渲染，绝不写回 localStorage（只有拖动结束写一次位置）
    const hook = fs.readFileSync(path.join(root, 'lib/useDraggableWindow.ts'), 'utf8');
    assert.equal((hook.match(/localStorage\.setItem/g) || []).length, 1, '只有拖动结束写位置');
    assert(hook.includes('不写回 localStorage'), '夹紧不得持久化');
  });
  await test('trading square parses the Trump archive page markup (time datetime + extra attributes)', () => {
    const { parseTrumpPage } = require(path.join(root, 'lib/tradingSquareRefresh.ts'));
    // 归档站改版后的真实结构：日期包在 <time datetime> 里、正文容器带 data-post-preview
    const html = [
      '<div class="statuses">',
      '<div class="status" data-status-url="https://www.trumpstruth.org/statuses/1">',
      '<div class="status-info__meta"><a href="#" class="status-info__meta-item">@realDonaldTrump</a> · ',
      '<a href="https://www.trumpstruth.org/statuses/1" class="status-info__meta-item"><time datetime="2026-09-17T13:00:22+00:00">September 17, 2026, 9:00 AM</time></a></div>',
      '<div class="status__content" data-post-preview><p>Hello <b>world</b></p></div>',
      '<a href="https://truthsocial.com/@realDonaldTrump/117287545147440255" rel="nofollow">原文</a>',
      '</div>',
      '</div>'
    ].join('');
    const posts = parseTrumpPage(html, 'https://trumpstruth.org/');
    assert.equal(posts.length, 1, '一页解析出 1 条');
    assert.equal(posts[0].date, '2026-09-17T13:00:22.000Z', '日期要取 time[datetime]');
    assert.equal(posts[0].text, 'Hello world', '正文要容得下额外属性');
    assert(posts[0].originalUrl.includes('117287545147440255'));
    // 旧的纯文本日期写法仍要能解析（向后兼容）
    const legacy = '<div class="status"><div class="status-info__meta-item">September 17, 2026, 9:00 AM</div><div class="status__content"><p>Legacy</p></div></div>';
    assert.equal(parseTrumpPage(legacy, 'https://trumpstruth.org/')[0].date, new Date('September 17, 2026, 9:00 AM').toISOString());
  });
  await test('trading square keeps quote-only reposts and preserves emoji labels', () => {
    const { mapDuanStatus } = require(path.join(root, 'lib/tradingSquareRefresh.ts'));
    const { normalizeTradingText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 雪球 emoji 是图片：取 alt，别让整段表情被去标签删掉
    assert.equal(normalizeTradingText('<img src="//assets.imedao.com/emoji.png" title="[很赞]" alt="[很赞]" height="24" />'), '[很赞]');
    assert.equal(normalizeTradingText('今天很好<img src="x" alt="[大笑]">，明天见'), '今天很好 [大笑] ，明天见');
    // 转发别人的帖子：自己的正文只有一个表情、也没有自己的图片 —— 以前会被整条丢掉
    const repost = mapDuanStatus({
      id: 409704400,
      created_at: 1789660143000,
      text: '<img src="//assets.imedao.com/ugc/images/face/emoji_35_like.png?v=1" title="[很赞]" alt="[很赞]" height="24" />',
      retweeted_status: {
        id: 409618513,
        created_at: 1789600000000,
        text: '<p>昨天有幸参观了vivo全球总部（东莞）</p>',
        user: { id: 9914456386, screen_name: '岩木', profile_image_url: 'community/x/a.png,community/x/a.png!50x50.png' }
      }
    });
    assert(repost, '转发+引用型帖子不能被丢弃');
    assert.equal(repost.id, '409704400');
    assert.equal(repost.text, '[很赞]');
    assert.equal(repost.quote.name, '岩木');
    assert(repost.quote.text.includes('vivo全球总部'));
    // 真正空白的状态仍然丢弃
    assert.equal(mapDuanStatus({ id: 1 }), null);
  });
  await test('trading square marks unseen posts consistently', () => {
    const { isUnseenPost, unseenBoundaryIndex, unseenCounts } = require(path.join(root, 'lib/tradingSquareSeen.ts'));
    const seen = { duan: '2026-09-17T00:00:00.000Z', trump: null };
    const posts = [
      { author: 'duan', date: '2026-09-17T01:00:00.000Z' },
      { author: 'duan', date: '2026-09-16T23:00:00.000Z' },
      { author: 'trump', date: '2026-09-04T00:00:00.000Z' }
    ];
    assert.equal(isUnseenPost(posts[0], seen), true, '比已读时间新 → 新');
    assert.equal(isUnseenPost(posts[1], seen), false, '比已读时间旧 → 不算新');
    assert.equal(isUnseenPost(posts[2], seen), true, '从没看过这位作者 → 算新');
    assert.deepEqual(unseenCounts(posts, seen), { duan: 1, trump: 1 });
    assert.equal(isUnseenPost({ author: 'duan', date: 'oops' }, seen), false, '时间解析失败不标记');
    assert.deepEqual(unseenCounts(posts, {}), { duan: 2, trump: 1 }, '首次访问全部算新');
    // 分界线画在最后一条新动态下面：整页都新 / 全都看过时不画线
    const boundary = (list) => unseenBoundaryIndex(list, seen);
    assert.equal(boundary([
      { author: 'duan', date: '2026-09-17T03:00:00.000Z' },
      { author: 'duan', date: '2026-09-17T02:00:00.000Z' },
      { author: 'duan', date: '2026-09-16T23:00:00.000Z' }
    ]), 1, '两条新动态 → 线画在第二条下面');
    assert.equal(boundary([{ author: 'duan', date: '2026-09-16T23:00:00.000Z' }]), -1, '没有新动态 → 不画线');
    assert.equal(boundary([{ author: 'duan', date: '2026-09-17T01:00:00.000Z' }]), -1, '整页都是新动态 → 不画线');
    assert.equal(boundary([]), -1, '空列表 → 不画线');
    // 新动态标记按主流做法：单条只用一个小圆点（不用文字胶囊），交界处画一次分隔线；
    // 颜色必须用站内「未读」色 —— 本站绿色表示下跌，自己发明一枚绿块会和涨跌语义打架
    const square = fs.readFileSync(path.join(root, 'components/views/TradingSquareView.tsx'), 'utf8');
    assert(square.includes('aria-label="上次访问之后的新动态"'), '新动态标记还在');
    assert(square.includes('unseen-dot h-1.5 w-1.5 flex-none rounded-full bg-down dark:bg-[#34d399]'), '单条标记是站内绿色的小圆点（带呼吸动画类）');
    const globals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    assert(/@keyframes unseen-dot-breathe/.test(globals) && /\.unseen-dot\s*\{\s*animation:/.test(globals), '绿点有呼吸动画');
    assert(/prefers-reduced-motion[\s\S]{0,120}\.unseen-dot/.test(globals), '呼吸动画尊重减少动态效果设置');
    // 分界标签压在那条本来就有的帖间分隔线上（微信「以下是新消息」的写法），不额外画线、不用红色
    assert(square.includes('relative flex h-0 items-center justify-center'), '分界标签压在原有分隔线上');
    assert(/font-medium text-faint[^>]*>以上 \{newAboveBoundary\} 条为新动态/.test(square), '分界标签是中性灰小字');
    assert(!square.includes('#4caf58'), '不再引入站外的绿色');
  });
  await test('trading square strips scraped page chrome from post text', () => {
    const { normalizeTradingText, stripTradingSquareChrome } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 开头的「回复@某人:」是回复上下文（雪球页面上的链接），不是作者写的字
    assert.equal(normalizeTradingText('回复@小马种西瓜: 其实是这样'), '其实是这样');
    assert.equal(normalizeTradingText('回复@小马种西瓜： 其实是这样'), '其实是这样');
    assert.equal(normalizeTradingText('回复@科研炒股: 是这个//@科研炒股:同款 查看图片'), '是这个//@科研炒股:同款');
    // 图片 / 外链的链接文案
    assert.equal(normalizeTradingText('这款确实可爱的。查看图片'), '这款确实可爱的。');
    assert.equal(normalizeTradingText('网页链接\n不知道哪个网友收集的'), '不知道哪个网友收集的');
    assert.equal(normalizeTradingText('$泡泡玛特(09992)$ 这款确实可爱的。查看图片'), '$泡泡玛特(09992)$ 这款确实可爱的。');
    // 正文中间的内容要保留：转发链、提及，以及不属于页面文案的方括号标记
    assert.equal(normalizeTradingText('//@小明:转发了这条'), '//@小明:转发了这条');
    assert.equal(stripTradingSquareChrome('好的，谢谢@小明: 我看看'), '好的，谢谢@小明: 我看看');
    assert.equal(stripTradingSquareChrome('回复@小明: 收到[已修改]'), '收到[已修改]');
    // 抓取脚本靠「清洗前的正文」判断是否回复、回复了谁，清洗后必须改用显式字段
    const refresh = fs.readFileSync(path.join(root, 'lib/tradingSquareRefresh.ts'), 'utf8');
    assert(refresh.includes('.match(/^\\s*回复\\s*@('), '清洗前记录回复对象');
    assert(refresh.includes('post.reply === true'), '补抓引用改用 reply 标记');
  });
  await test('trading square comments: avatar url + reply target', () => {
    const { mapXueqiuComment } = require(path.join(root, 'lib/tradingSquareComments.ts'));
    const { normalizeXueqiuAvatar, isAllowedRemoteImageUrl } = require(path.join(root, 'lib/tradingSquareImages.ts'));
    const { replyTargetFromText } = require(path.join(root, 'lib/tradingSquareText.ts'));
    // 雪球头像字段：逗号分隔的多档尺寸、且不带域名（取第一档并补 xavatar 域名，否则前端是破图）
    assert.equal(normalizeXueqiuAvatar('community/20165/a.png,community/20165/a.png!180x180.png'), 'https://xavatar.imedao.com/community/20165/a.png');
    assert.equal(normalizeXueqiuAvatar('https://xavatar.imedao.com/community/a.png'), 'https://xavatar.imedao.com/community/a.png');
    assert.equal(normalizeXueqiuAvatar(''), undefined);
    assert.equal(isAllowedRemoteImageUrl('https://xavatar.imedao.com/community/20165/a.png'), true);
    assert.equal(isAllowedRemoteImageUrl('https://evil.example.com/a.png'), false);
    // 评论：作者、时间、赞数、回复对象、正文里的「回复@x:」前缀要拆出来
    const comment = mapXueqiuComment({
      id: 1,
      created_at: 1789455535000,
      like_count: 18,
      text: '回复@随水而行的Star: 是的，这个位置的人流量在国内也是排前几名的。',
      user: { screen_name: 'neng', profile_image_url: 'community/1/a.png,community/1/a.png!50x50.png' }
    });
    assert.equal(comment.name, 'neng');
    assert.equal(comment.text, '是的，这个位置的人流量在国内也是排前几名的。');
    assert.equal(comment.replyTo, '随水而行的Star');
    assert.equal(comment.likes, 18);
    assert.equal(comment.avatar, 'https://xavatar.imedao.com/community/1/a.png');
    assert.equal(comment.createdAt, new Date(1789455535000).toISOString());
    assert.equal(mapXueqiuComment({ id: 2, text: '   ' }), null);
    assert.equal(replyTargetFromText('回复@小马种西瓜: 正文'), '小马种西瓜');
    assert.equal(replyTargetFromText('//@小明:转发'), undefined);
  });
  await test('fx converter uses USD mid-market rates and sanitizes input', () => {
    const { convertAmount, pairRate, parseFxAmount, sanitizeFxInput, amountToDraft } = require(path.join(root, 'lib/fxConvert.ts'));
    const rates = { USD: 1, CNY: 7.2, HKD: 7.85, JPY: 155 };
    assert.equal(convertAmount(100, 'USD', 'CNY', rates), 720);
    assert.equal(convertAmount(720, 'CNY', 'USD', rates), 100);
    assert.equal(Number(convertAmount(100, 'CNY', 'HKD', rates).toFixed(6)), Number(((100 / 7.2) * 7.85).toFixed(6)));
    assert.equal(convertAmount(100, 'USD', 'GBP', rates), null);
    assert.equal(pairRate('USD', 'JPY', rates), 155);
    assert.equal(parseFxAmount('1,234.50'), 1234.5);
    assert.equal(parseFxAmount('.'), null);
    assert.equal(sanitizeFxInput('12.3.4a'), '12.34');
    assert.equal(amountToDraft(720, 'CNY'), '720');
    assert.equal(amountToDraft(155.4, 'JPY'), '155');
    const { FX_CURRENCIES, FX_EXTRA_CURRENCIES, FX_CURRENCY_META, fxContinent, formatRatesDate, normalizeFxOrder, visibleFxOrder, mergeVisibleFxOrder, moveFxOrder } = require(path.join(root, 'lib/fxConvert.ts'));
    assert.equal(FX_CURRENCIES.length, 14);
    assert.equal(FX_CURRENCIES.length % 2, 0);
    assert(!FX_CURRENCIES.includes('MOP'));
    assert(FX_CURRENCIES.includes('CHF'));
    assert(FX_EXTRA_CURRENCIES.includes('MOP'));
    assert(FX_EXTRA_CURRENCIES.every((code) => Boolean(FX_CURRENCY_META[code]?.iso)));
    assert(!FX_EXTRA_CURRENCIES.some((code) => ['BTC', 'XAU', 'XAG', 'XDR', 'BMD'].includes(code)));
    assert.deepEqual(normalizeFxOrder(['CNY', 'USD', 'MOP', 'NOPE', 'CNY']), ['CNY', 'USD', 'MOP', ...FX_CURRENCIES.filter((code) => code !== 'CNY' && code !== 'USD')]);
    assert.equal(fxContinent('MOP'), '亚洲');
    assert.equal(fxContinent('SEK'), '欧洲');
    assert.equal(fxContinent('BRL'), '南美洲');
    assert.equal(fxContinent('XYZ'), '其他');
    assert.equal(formatRatesDate(Date.UTC(2026, 8, 19, 4, 0, 0)).includes('2026年'), true);
    assert.deepEqual(moveFxOrder(['USD', 'EUR', 'HKD'], 0, 2), ['EUR', 'HKD', 'USD']);
    assert.deepEqual(moveFxOrder(['USD', 'EUR', 'HKD'], 2, 0), ['HKD', 'USD', 'EUR']);
    assert.deepEqual(mergeVisibleFxOrder(['USD', 'EUR', 'HKD'], ['HKD', 'USD']), ['HKD', 'EUR', 'USD']);
    assert(!visibleFxOrder(['USD', 'EUR', 'HKD'], ['USD', 'EUR']).includes('USD'));
    assert.deepEqual(visibleFxOrder(['USD', 'EUR', 'HKD'], ['USD', 'EUR']), ['HKD', ...FX_CURRENCIES.filter(code => !['USD', 'EUR', 'HKD'].includes(code))]);
    const untouched = ['USD', 'EUR'];
    assert.equal(moveFxOrder(untouched, 0, 0), untouched);
    assert.deepEqual(moveFxOrder(['USD', 'EUR'], 9, 0), ['USD', 'EUR']);
  });
  await test('rate refresh shares concurrent upstream calls, preserves cache on HTTP errors and retries', async () => {
    const rates = require(path.join(root, 'lib/rates.ts'));
    const original = global.fetch;
    let calls = 0;
    let finish;
    global.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    try {
      const a = rates.refreshRates();
      const b = rates.refreshRates();
      assert.equal(calls, 1);
      finish(Response.json({ rates: { USD: 1, CNY: 7.1 } }));
      const [first, second] = await Promise.all([a, b]);
      assert.equal(first.CNY, 7.1);
      assert.deepEqual(first, second);
      const at = rates.ratesUpdatedAt();
      global.fetch = async () => { calls++; return Response.json({ rates: { USD: 1, CNY: 99 } }, { status: 429 }); };
      await assert.rejects(rates.refreshRates(), /429/);
      assert.equal((await rates.getRates()).CNY, 7.1);
      assert.equal(rates.ratesUpdatedAt(), at);
      assert.equal(calls, 2, 'ordinary reads never fetch upstream');
      global.fetch = async () => { calls++; return Response.json({ rates: { USD: 1, CNY: 7.2 } }); };
      assert.equal((await rates.refreshRates()).CNY, 7.2);
      assert.equal(calls, 3, 'failure does not poison subsequent refresh');
    } finally { global.fetch = original; }
  });
  await test('currency refresh pattern extracts HH:MM and normalizes USD base', () => {
    const { parseRefreshTimes, nextRefreshAt, extractRateMap, toUsdBase, compileCurrencyRefreshRegex } = require(path.join(root, 'lib/currencyRefresh.ts'));
    assert.deepEqual(parseRefreshTimes('09:00|23:00').map((item) => item.label), ['09:00', '23:00']);
    assert.deepEqual(parseRefreshTimes('^(09|12|18):00$').map((item) => item.label), ['09:00', '12:00', '18:00']);
    assert.equal(parseRefreshTimes('^([01]\\d|2[0-3]):00$').length, 24);
    assert.deepEqual(parseRefreshTimes('/09:00|23:00/').map((item) => item.label), ['09:00', '23:00']);
    assert.deepEqual(parseRefreshTimes('(').map((item) => item.label), ['09:00', '23:00']);
    assert.equal(compileCurrencyRefreshRegex('('), null);
    const noon = new Date(2026, 8, 19, 12, 0, 0).getTime();
    const next = nextRefreshAt(noon, parseRefreshTimes('09:00|23:00'));
    assert.equal(new Date(next).getHours(), 23);
    assert.equal(new Date(next).getMinutes(), 0);
    assert.deepEqual(extractRateMap({ rates: { CNY: 7.2, HKD: '7.85' } }), { CNY: 7.2, HKD: 7.85 });
    assert.equal(Number(toUsdBase({ USD: 1.08, CNY: 7.56 }).CNY.toFixed(4)), 7);
  });
  await test('settings window keeps online height and hover scrollbar', () => {
    const win = fs.readFileSync(path.join(root, 'components/SettingsWindow.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    assert.match(win, /h-\[min\(916px,calc\(100dvh-136px\)\)\]/, '设置窗口应与左侧导航等高');
    assert.match(win, /overflow-hidden">\{children\}/, '中间层不能抢走右侧滚动');
    assert.match(css, /height:min\(916px,calc\(100dvh - 136px\)\)/, 'CSS 高度应与左侧导航一致');
    assert.match(css, /\.sv-win-root \.sw-content-scroll,\s*\.dark \.sv-win-root \.sw-content-scroll\s*\{\s*scrollbar-width:\s*auto;\s*scrollbar-color:\s*auto/, '右侧滚动条必须重置后才能划过显示');
  });
  await test('global economy removes archived heatmap but keeps converter', () => {
    const view = fs.readFileSync(path.join(root, 'components/views/GlobalPreviewView.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    const convert = view.indexOf('["convert", "汇率换算"');
    assert(convert >= 0, '汇率换算入口必须保留');
    assert(!view.includes('GlobalEconomyHeatmap'));
    assert(!view.includes('["heatmap", "经济热图"'));
    assert.match(view, /section === "assets" \? <AssetMarketCapRanking \/> : <FxConverter \/>/);
    assert.match(view, /useState<GlobalSection>\("assets"\)/, '服务端与客户端首帧必须使用相同区块');
    assert.match(view, /useLayoutEffect\(\(\) => \{[\s\S]*?setSection\(parseGlobalSection\(new URLSearchParams\(window\.location\.search\)/, 'URL 区块只能在水合后读取');
    assert.match(view, /if \(pageSize \|\| !urlReady\) return;/, '读取 URL 前不得回写默认区块覆盖分享链接');
    assert.match(css, /\.fx-converter-card\s*\{[^}]*grid-template-columns:\s*1fr 1fr/, '汇率换算必须一排两个');
  });
  await test('calendar and stock detail share the server first-frame clock', () => {
    const layout = fs.readFileSync(path.join(root, 'app/[...slug]/layout.tsx'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'components/RecordsApp.tsx'), 'utf8');
    const calendar = fs.readFileSync(path.join(root, 'components/views/EarningsCalendarView.tsx'), 'utf8');
    const detail = fs.readFileSync(path.join(root, 'components/StockDetailView.tsx'), 'utf8');
    const watchlist = fs.readFileSync(path.join(root, 'components/views/WatchlistView.tsx'), 'utf8');
    const quotes = fs.readFileSync(path.join(root, 'components/views/QuotesView.tsx'), 'utf8');
    assert.match(layout, /const initialNow = Date\.now\(\);[\s\S]*?<RecordsApp[\s\S]*?initialNow=\{initialNow\}/);
    assert.match(app, /<EarningsCalendarView[^>]*initialNow=\{initialNow\}/);
    assert.match(app, /<WatchlistView[^>]*initialNow=\{initialNow\}/);
    assert.match(watchlist, /<QuotesView[^>]*initialNow=\{initialNow\}/);
    assert.match(quotes, /<StockDetailView[^>]*initialNow=\{initialNow\}/);
    assert.match(calendar, /new Date\(initialNow\)/);
    assert.match(calendar, /new Date\(calendarNow\)/);
    assert.match(detail, /useState\(initialNow\)/);
    assert.match(detail, /new Date\(marketClock\)/);
    assert(!detail.includes('useState(() => Date.now())'));
  });
  await test('production build never rotates the local demo password', () => {
    const db = fs.readFileSync(path.join(root, 'lib/db.ts'), 'utf8');
    assert.match(db, /NODE_ENV === "production" && process\.env\.NEXT_PHASE !== "phase-production-build"/, '生产服务的弱密码保护不能在 next build 阶段修改本地账号');
  });
  await test('admin avatar badge does not depend on excluded deployment icons', () => {
    const badge = fs.readFileSync(path.join(root, 'components/AdminBadge.tsx'), 'utf8');
    const menu = fs.readFileSync(path.join(root, 'components/UserMenu.tsx'), 'utf8');
    const users = fs.readFileSync(path.join(root, 'components/views/UsersView.tsx'), 'utf8');
    assert.match(badge, /<svg[\s\S]*<circle[\s\S]*<path/, '角标应直接绘制完整圆形和闪电');
    for (const source of [menu, users]) {
      assert.match(source, /<AdminBadge\b/, '管理员头像应使用共用角标');
      assert(!source.includes('/icons/bolt.circle.fill.svg'), '不得请求未随镜像发布的本地图标');
    }
  });
  await test('Liquid Glass stays on capsules without persistent click halo', () => {
    const provider = fs.readFileSync(path.join(root, 'components/PaletteProvider.tsx'), 'utf8');
    const material = fs.readFileSync(path.join(root, 'styles/liquid-glass.css'), 'utf8');
    const palette = fs.readFileSync(path.join(root, 'styles/palettes.css'), 'utf8');
    const menu = fs.readFileSync(path.join(root, 'components/UserMenu.tsx'), 'utf8');
    assert(!provider.includes('LiquidGlassInteractions'), '全站按钮不能安装点击透镜');
    assert(!material.includes('.lg-global-lens') && !material.includes('button.rounded-full'), '玻璃效果不能覆盖普通圆按钮或头像');
    assert.match(material, /data-material="glass"\] :is\(\.fire-cap,\.settings-primary-pill/, '胶囊仍保留玻璃材质');
    assert(!/data-material="glass"\] :is\(\.card,/.test(palette), '卡片不能附加玻璃材质');
    assert.match(palette, /data-palette="liquid"\] \.sv-win-root\.sv-orca\s*\{\s*--sv-shell:\s*rgb\(var\(--site-bg\)\);\s*--sv-shell-hover:\s*rgb\(var\(--site-surface\)\)/, 'Liquid Glass 设置导航应与正文同底色');
    assert(!menu.includes('scale-[1.4]') && !menu.includes('open ? "ring-2 ring-white"'), '头像菜单打开后不应放大或加亮圈');
  });
  await test('sidebar scrollbar stays hidden until hover (dark mode)', () => {
    const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'components/RecordsApp.tsx'), 'utf8');
    assert.match(css, /\.fire-sidebar-panel,\.dark \.fire-sidebar-panel\s*\{\s*scrollbar-width:none;/, '原生叠加滚动条必须隐藏，避免粗白条');
    assert.match(css, /\.fire-sidebar-panel::-webkit-scrollbar,\.dark \.fire-sidebar-panel::-webkit-scrollbar\s*\{\s*display:none;/, 'WebKit 原生条也必须隐藏');
    assert.match(css, /\.dark \.fire-sidebar-scroll-indicator\s*\{\s*background:rgba\(255,255,255,\.26\)/, '深色滑块应遵循全站 26% 白色规范');
    assert.match(css, /\.fire-sidebar:hover \.fire-sidebar-scroll-indicator/, 'macOS 叠加式滚动条需要可见的悬停滑块');
    assert.match(app, /sidebarScroll\.visible && <span aria-hidden="true" className="fire-sidebar-scroll-indicator"/, '只在实际可滚动时渲染滑块');
  });
  await test('client code never calls crypto.randomUUID (insecure LAN HTTP breaks it)', () => {
    const { clientRandomId } = require(path.join(root, 'lib/randomId.ts'));
    assert.match(clientRandomId('ac-'), /^ac-[0-9a-f]{24}$/);

    const clientFiles = [];
    for (const dir of ['components', 'lib']) {
      for (const name of fs.readdirSync(path.join(root, dir), { recursive: true })) {
        const rel = path.join(dir, String(name));
        if (!/\.(ts|tsx)$/.test(rel)) continue;
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        if (/^\s*"use client"/.test(text)) clientFiles.push([rel, text]);
      }
    }
    assert(clientFiles.length > 20);
    for (const [rel, text] of clientFiles) assert(!text.includes('crypto.randomUUID('), `${rel} 不能调用 crypto.randomUUID`);

    // 模拟局域网 HTTP（非安全上下文）：randomUUID 不存在、getRandomValues 抛错，都必须仍能拿到 id
    const dialog = require(path.join(root, 'lib/appDialog.ts'));
    const cryptoGlobal = globalThis.crypto;
    const originalRandomUUID = cryptoGlobal.randomUUID;
    const originalGetRandomValues = cryptoGlobal.getRandomValues;
    const events = [];
    const originalWindow = globalThis.window;
    try {
      Object.defineProperty(cryptoGlobal, 'randomUUID', { value: undefined, configurable: true, writable: true });
      globalThis.window = { dispatchEvent: (event) => { events.push(event.detail); return true; } };
      void dialog.appConfirm('删除“这条测试对话”？删除后无法恢复。', { title: '删除对话', danger: true });
      assert.equal(events.length, 1);
      assert.match(events[0].id, /^dlg-[0-9a-f]{24}$/);
      Object.defineProperty(cryptoGlobal, 'getRandomValues', { value: () => { throw new Error('insecure context'); }, configurable: true, writable: true });
      assert.match(clientRandomId(), /^[0-9a-f]{24}$/);
    } finally {
      Object.defineProperty(cryptoGlobal, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true });
      Object.defineProperty(cryptoGlobal, 'getRandomValues', { value: originalGetRandomValues, configurable: true, writable: true });
      if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    }
  });
  await test('assistant context covers management pages and attaches live site data', async () => {
    const { normalizeAssistantContext } = require(path.join(root, 'lib/assistantSecurity.ts'));
    for (const [page, label] of [['attachments', '附件管理'], ['users', '用户管理'], ['activities', '日志']]) {
      const normalized = normalizeAssistantContext({ page });
      assert.equal(normalized.page, page);
      assert.equal(normalized.label, label);
    }
    assert.equal(normalizeAssistantContext({ page: '../etc/passwd' }).page, undefined);

    const { buildAssistantLiveData } = require(path.join(root, 'lib/assistantLiveData.ts'));
    const lines = await buildAssistantLiveData([{ id: '1', market: 'US', code: 'AAPL', name: '苹果' }], { includeAccount: true, quoteTimeoutMs: 50 });
    assert(Array.isArray(lines));
    assert(lines.every((line) => typeof line === 'string'));
  });
  await test('assistant answers render markdown tables and only safe links', () => {
    const { parseAssistantBlocks, parseInlineSegments } = require(path.join(root, 'lib/assistantMarkdown.ts'));
    const blocks = parseAssistantBlocks([
      '结论：持仓分化',
      '',
      '| 标的 | 现价 | 涨跌 |',
      '| --- | --- | --- |',
      '| 特斯拉 | 420.5 | +1.2% |',
      '| 苹果 | 233.1 | -0.4% |',
      '',
      '> 数据抓取于 09-16 10:20',
      '---',
      '- 风险：单一标的占比过高',
      '1. 继续观察',
      '详见 https://example.com/news 与 [雪球](https://xueqiu.com/a)'
    ].join('\n'));
    const table = blocks.find((block) => block.type === 'table');
    assert.deepEqual(table && table.rows, [['标的', '现价', '涨跌'], ['特斯拉', '420.5', '+1.2%'], ['苹果', '233.1', '-0.4%']]);
    assert(blocks.some((block) => block.type === 'quote'));
    assert(blocks.some((block) => block.type === 'divider'));
    assert(blocks.some((block) => block.type === 'bullet'));
    assert(blocks.some((block) => block.type === 'numbered' && block.marker === '1'));
    assert(!blocks.some((block) => block.type === 'text' && block.text.includes('|')));

    const inline = parseInlineSegments('详见 https://example.com/news 与 [雪球](https://xueqiu.com/a)');
    assert.deepEqual(inline.filter((segment) => segment.type === 'link').map((segment) => segment.href), ['https://example.com/news', 'https://xueqiu.com/a']);
    assert(parseInlineSegments('[危险](javascript:alert(1))').every((segment) => segment.type !== 'link'));
    assert(parseInlineSegments('[伪装](data:text/html;base64,PHN2Zz4=)').every((segment) => segment.type !== 'link'));

    // 真渲染一遍：表格必须变成 <table>、合法链接必须变成 <a>、危险协议只能留文本。
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const AssistantRichText = require(path.join(root, 'components/AssistantRichText.tsx')).default;
    const html = renderToStaticMarkup(React.createElement(AssistantRichText, { text: [
      '| 标的 | 现价 | 涨跌 |',
      '| --- | --- | --- |',
      '| 特斯拉 | 420.5 | +1.2% |',
      '',
      '详见 [雪球](https://xueqiu.com/a) 与 [危险](javascript:alert(1))'
    ].join('\n') }));
    assert(html.includes('assistant-md-table-wrap') && html.includes('<table class="assistant-md-table">'));
    assert(html.includes('<th><span>标的</span></th>') && html.includes('<th><span>涨跌</span></th>'));
    assert(html.includes('<td><span>特斯拉</span></td>') && html.includes('<td><span>+1.2%</span></td>'));
    assert(html.includes('href="https://xueqiu.com/a"'));
    assert(!html.includes('href="javascript:alert(1)"'));

    const source = fs.readFileSync(path.join(root, 'components/ContextAssistant.tsx'), 'utf8');
    const richText = fs.readFileSync(path.join(root, 'components/AssistantRichText.tsx'), 'utf8');
    const styles = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
    const route = fs.readFileSync(path.join(root, 'app/api/assistant/route.ts'), 'utf8');
    assert(source.includes('function pinToLatest()'));
    assert(source.includes('assistant-jump-latest'));
    assert(source.includes('<AssistantRichText text={message.content} />'));
    assert(richText.includes('parseAssistantBlocks(text)'));
    assert(styles.includes('.assistant-md-table'));
    assert(styles.includes('.assistant-jump-latest'));
    assert(styles.includes('.assistant-inline-link'));
    assert(route.includes('回答风格：默认短'));
  });
  await test('runtime-uploaded assets are served back (regression: model service icon 404)', async () => {
    const upload = require(path.join(root, 'app/api/upload/route.ts'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=', 'base64');
    const fd = new FormData();
    fd.set('kind', 'asset');
    fd.set('folder', 'icon');
    fd.set('name', 'DeepSeek');
    fd.set('code', `deepseek-${Date.now().toString(36)}`);
    fd.set('file', new File([png], 'icon.png', { type: 'image/png' }));
    const res = await upload.POST(new Request('http://localhost/api/upload', { method: 'POST', headers: { cookie: `fire_session=${tokens.admin}` }, body: fd }));
    assert.equal(res.status, 200);
    const { url } = await res.json();
    const beforeServices = settings.getSiteSettings().modelServices;
    const withIcon = beforeServices.map((service, index) => index === 0 ? { ...service, icon: url } : service);
    assert.equal((await settingsRoute.PUT(request('admin', { modelServices: withIcon }, 'PUT'))).status, 200);
    const savedSettings = await (await settingsRoute.GET(request('admin'))).json();
    assert.equal(savedSettings.settings.modelServices[0].icon, url, 'uploaded icon must survive settings save and reload');
    const switched = withIcon.map((service, index) => index === 0 ? { ...service, provider: 'custom' } : service);
    assert.equal((await settingsRoute.PUT(request('admin', { modelServices: switched }, 'PUT'))).status, 200);
    assert.equal((await (await settingsRoute.GET(request('admin'))).json()).settings.modelServices[0].icon, url, 'changing provider must not discard uploaded icon');
    const rel = decodeURIComponent(url.replace(/^\/uploads\//, ''));
    const route = require(path.join(root, 'app/uploads/[...path]/route.ts'));
    const served = await route.GET(new Request(`http://localhost${url}`), { params: Promise.resolve({ path: rel.split('/') }) });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    const suffix = await route.GET(new Request(`http://localhost${url}`, { headers: { range: 'bytes=-4' } }), { params: Promise.resolve({ path: rel.split('/') }) });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), png.subarray(-4));
    for (const range of ['bytes=999999-', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5']) {
      const invalidRange = await route.GET(new Request(`http://localhost${url}`, { headers: { range } }), { params: Promise.resolve({ path: rel.split('/') }) });
      assert.equal(invalidRange.status, 416, range);
      assert.equal(invalidRange.headers.get('content-range'), `bytes */${png.length}`);
    }
    assert.equal((await settingsRoute.PUT(request('admin', { modelServices: beforeServices }, 'PUT'))).status, 200);
    const missing = await route.GET(new Request('http://localhost/uploads/asset/icon/not-there.png'), { params: Promise.resolve({ path: ['asset', 'icon', 'not-there.png'] }) });
    assert.equal(missing.status, 404);
  });
  await test('model icon upload saves atomically and rejects invalid configuration without a file', async () => {
    const route = require(path.join(root, 'app/api/settings/model-icon/route.ts'));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=', 'base64');
    const before = settings.getSiteSettings().modelServices;
    const files = () => fs.readdirSync(path.join(temp, 'public/uploads/asset/icon')).length;
    const makeRequest = (services, code) => {
      const fd = new FormData();
      fd.set('kind', 'asset'); fd.set('folder', 'icon'); fd.set('name', 'Test Model'); fd.set('code', code);
      fd.set('serviceId', before[0].id); fd.set('modelServices', JSON.stringify(services));
      fd.set('file', new File([png], 'icon.png', { type: 'image/png' }));
      return new Request('http://localhost/api/settings/model-icon', { method: 'POST', headers: { cookie: `fire_session=${tokens.admin}` }, body: fd });
    };
    const originalCount = files();
    const invalid = await route.POST(makeRequest(before.map((s, i) => i === 0 ? { ...s, apiUrl: 'file:///bad' } : s), 'INVALID-MODEL'));
    assert.equal(invalid.status, 400);
    assert.equal(files(), originalCount, 'invalid settings must not leave uploaded files');
    const branded = await route.POST(makeRequest(before.map((s, i) => i === 0 ? { ...s, provider: 'openai' } : s), 'BRANDED-MODEL'));
    assert.equal(branded.status, 200);
    const brandedUrl=(await branded.json()).url;
    assert.equal(settings.getSiteSettings().modelServices[0].icons.openai, brandedUrl);
    assert.equal(settings.getSiteSettings().modelServices[0].icons.custom, undefined);
    assert.equal((await settingsRoute.PUT(request('admin', { modelServices: before }, 'PUT'))).status, 200);
    const saved = await route.POST(makeRequest(before, `MODEL-${Date.now().toString(36)}`));
    assert.equal(saved.status, 200);
    const { url } = await saved.json();
    assert.equal(settings.getSiteSettings().modelServices[0].icon, url);
    assert.equal(fs.existsSync(path.join(temp, 'public', decodeURIComponent(url).replace(/^\//, ''))), true);
    assert.equal((await (await settingsRoute.GET(request('admin'))).json()).settings.modelServices[0].icon, url);
    assert.equal((await settingsRoute.PUT(request('admin', { modelServices: before }, 'PUT'))).status, 200);
  });
  await test('model icons are isolated by provider', () => {
    const { normalizeModelServices } = require(path.join(root, 'lib/modelServices.ts'));
    const base={id:'service',name:'Model',icon:'/uploads/asset/icon/custom.png',apiUrl:'https://example.com',apiKey:'',models:['model']};
    for (const provider of ['deepseek','openai','jev']) {
      assert.equal(normalizeModelServices([{...base,provider}])[0].icon,'');
    }
    assert.equal(normalizeModelServices([{...base,provider:'custom'}])[0].icon,base.icon);
    const icons={deepseek:'/uploads/asset/icon/deepseek.png',openai:'/uploads/asset/icon/openai.png',custom:'/uploads/asset/icon/custom.png'};
    for (const provider of ['deepseek','openai','custom']) {
      const normalized=normalizeModelServices([{...base,provider,icons}])[0];
      assert.equal(normalized.icon,icons[provider]);
      assert.deepEqual(normalized.icons,icons);
    }
  });
  await test('showcase 写接口限管理员：普通用户改不了首页车型条', async () => {
    const uploadRoute = require(path.join(root, 'app/api/showcase/models/upload/route.ts'));
    const listRoute = require(path.join(root, 'app/api/showcase/models/route.ts'));
    const orderRoute = require(path.join(root, 'app/api/showcase/models/order/route.ts'));
    const coverRoute = require(path.join(root, 'app/api/showcase/models/cover/route.ts'));
    const idRoute = require(path.join(root, 'app/api/showcase/models/[id]/route.ts'));
    const call = (role, url, method = 'GET', body) =>
      new Request(`http://localhost:3000${url}`, {
        method,
        headers: {
          ...(role ? { cookie: `fire_session=${tokens[role]}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    const params = (id) => ({ params: Promise.resolve({ id }) });

    // 普通用户：导入 / 保存 / 排序 / 封面 / 改参数 / 删除 全部 403（车型条是首页对外的公共内容）
    assert.equal((await uploadRoute.POST(call('user', '/api/showcase/models/upload?name=x.glb', 'POST'))).status, 403);
    assert.equal((await listRoute.POST(call('user', '/api/showcase/models', 'POST', { id: 'x', label: 'x', file: 'x.glb' }))).status, 403);
    assert.equal((await orderRoute.PUT(call('user', '/api/showcase/models/order', 'PUT', { ids: ['mcl35m'] }))).status, 403);
    assert.equal((await coverRoute.DELETE(call('user', '/api/showcase/models/cover?id=mcl35m', 'DELETE'))).status, 403);
    assert.equal((await idRoute.PUT(call('user', '/api/showcase/models/gulf2022', 'PUT', {}), params('gulf2022'))).status, 403);
    assert.equal((await idRoute.DELETE(call('user', '/api/showcase/models/gulf2022?file=1'), params('gulf2022'))).status, 403);

    // 访客：先卡在未登录
    assert.equal((await listRoute.POST(call(null, '/api/showcase/models', 'POST', {}))).status, 401);
    assert.equal((await uploadRoute.POST(call(null, '/api/showcase/models/upload?name=x.glb', 'POST'))).status, 401);

    // 管理员：不再是 403（这里只验证授权，不真去写盘）
    const adminRes = await idRoute.DELETE(call('admin', '/api/showcase/models/not-exist'), params('not-exist'));
    assert.notEqual(adminRes.status, 403);

    // 公开 GET：只给首页要用的清单，不再把整份登记表（文件参数）下发出去
    const published = await (await listRoute.GET()).json();
    assert.ok(Array.isArray(published.models));
    assert.equal(published.stored, undefined);
  });
  await test('showcase 隐藏草稿与正式模型经动态路由读取，保留 Range 与路径防护', async () => {
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    const route = require(path.join(root, 'app/api/showcase/model-files/[file]/route.ts'));
    const config = (await import(path.join(root, 'next.config.mjs'))).default;
    const rules = (await config.rewrites()).beforeFiles;
    assert(rules.some(rule => rule.source === '/uploads/mclaren/models/:file' && rule.destination === '/api/showcase/model-files/:file'), '必须在 public 静态文件匹配之前接管草稿请求');
    fs.mkdirSync(store.MODELS_DIR, { recursive: true });
    const bytes = Buffer.from('glTF-preview-regression');
    const read = (file, range) => route.GET(new Request('http://localhost:3000/api/showcase/model-files/test', { headers: range ? { range } : {} }), { params: Promise.resolve({ file }) });
    for (const file of [store.draftModelFile('preview.glb'), 'published-preview.glb']) {
      fs.writeFileSync(path.join(store.MODELS_DIR, file), bytes);
      const full = await read(file);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'model/gltf-binary');
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
      const partial = await read(file, 'bytes=0-3');
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), `bytes 0-3/${bytes.length}`);
      assert.equal(await partial.text(), 'glTF');
      fs.unlinkSync(path.join(store.MODELS_DIR, file));
    }
    for (const file of ['../outside.glb', 'nested/model.glb', 'showroom.json']) assert.equal((await read(file)).status, 400);
    assert.equal((await read('missing.glb')).status, 404);
    fs.writeFileSync(path.join(temp, 'outside.glb'), bytes);
    fs.symlinkSync(path.join(temp, 'outside.glb'), path.join(store.MODELS_DIR, 'symlink.glb'));
    assert.equal((await read('symlink.glb')).status, 404);
    fs.unlinkSync(path.join(store.MODELS_DIR, 'symlink.glb'));
  });
  await test('showcase 登记表损坏时停止保存，避免覆盖车型参数', () => {
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    const read = fs.readFileSync;
    const exists = fs.existsSync;
    let registryBody = '{invalid-json';
    fs.existsSync = function(file) {
      if (String(file) === path.join(store.SHOWROOM_DIR, 'showroom.json')) return true;
      return exists.call(this, file);
    };
    fs.readFileSync = function(file, ...args) {
      if (String(file) === path.join(store.SHOWROOM_DIR, 'showroom.json')) return registryBody;
      return read.call(this, file, ...args);
    };
    try {
      assert.throws(() => store.readRegistry(), /登记表读取失败/);
      assert.throws(() => store.ensureRegistry(), /登记表读取失败/);
      registryBody = '{"models":[{"id":"bad car","file":"car.glb"}]}';
      assert.throws(() => store.readRegistry(), /登记表读取失败/);
    } finally { fs.readFileSync = read; fs.existsSync = exists; }
  });
  await test('showcase 体检不留附件，保存成功才落盘，失败与旧草稿均清理', async () => {
    const route = require(path.join(root, 'app/api/showcase/models/upload/route.ts'));
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    const { cleanupOrphanFiles } = require(path.join(root, 'lib/fileCleanup.ts'));
    const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], materials: [{ name: 'tire' }], meshes: [{ primitives: [] }] }));
    const chunk = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(chunk);
    const glb = Buffer.alloc(20 + chunk.length); glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8); glb.writeUInt32LE(chunk.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); chunk.copy(glb, 20);
    const metadata = { id: 'retention-test', label: 'Retention', note: '', params: { length: 5.6 } };
    const call = (meta, bytes = glb) => route.POST(new Request('http://localhost:3000/api/showcase/models/upload?name=retention.glb', { method: 'POST', headers: { cookie: `fire_session=${tokens.admin}`, ...(meta ? { 'x-showcase-model': encodeURIComponent(JSON.stringify(meta)) } : {}) }, body: bytes }));
    const list = () => fs.existsSync(store.MODELS_DIR) ? fs.readdirSync(store.MODELS_DIR).sort() : [];
    const before = list(); const tempDirs = [];
    const mkdtemp = fs.promises.mkdtemp;
    fs.promises.mkdtemp = async (...args) => { const dir = await mkdtemp(...args); tempDirs.push(dir); return dir; };
    try {
      const inspected = await call(); assert.equal(inspected.status, 200);
      assert.equal((await inspected.json()).url, undefined, 'inspection cannot expose a stored draft URL');
      assert.deepEqual(list(), before, 'successful inspection retains no uploaded GLB');
      assert.equal((await call(null, Buffer.from('invalid'))).status, 400);
      assert.equal((await call({ ...metadata, params: { length: 0 } })).status, 400);
      assert.deepEqual(list(), before, 'invalid upload and invalid save retain no attachment');
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => { if (String(to).endsWith('showroom.json')) throw new Error('simulated registry failure'); return rename(from, to); };
      try { assert.equal((await call(metadata)).status, 400); } finally { fs.renameSync = rename; }
      assert.deepEqual(list(), before, 'failed registry commit rolls back the copied model');
      const saved = await call(metadata); assert.equal(saved.status, 200);
      const { model } = await saved.json();
      assert.deepEqual(fs.readFileSync(path.join(store.MODELS_DIR, model.file)), glb);
      assert(store.readStoredModels().some(item => item.id === model.id && item.file === model.file));
      assert.equal((await call(metadata)).status, 400);
      assert.deepEqual(list(), [...before, model.file].sort(), 'duplicate save cannot retain another file');
      fs.writeFileSync(path.join(store.MODELS_DIR, '.draft-old--unsaved.glb'), glb);
      assert.equal(cleanupOrphanFiles({ scope: 'showcase-unsaved' }).removed, 1);
      assert(fs.existsSync(path.join(store.MODELS_DIR, model.file)), 'cleanup preserves saved models');
      assert(tempDirs.every(dir => !fs.existsSync(dir)), 'all inspection and save temp directories are removed');
      store.removeStoredModel(model.id, { deleteFile: true });
    } finally { fs.promises.mkdtemp = mkdtemp; }
  });
  await test('showcase 上传草稿不会提前上线，保存后原子转正，移出清单不会自动复活', () => {
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    fs.mkdirSync(store.MODELS_DIR, { recursive: true });
    const draft = store.draftModelFile(`${'future-car-'.repeat(9)}.glb`);
    assert(store.validModelFile(draft));
    fs.writeFileSync(path.join(store.MODELS_DIR, draft), Buffer.from('draft'));
    assert(!store.ensureRegistry().some((item) => item.file === draft));
    const saved = store.upsertStoredModel({ id: 'future-car', label: 'Future Car', file: draft, params: { wheelPattern: '[invalid' } });
    assert(!store.isDraftModelFile(saved.file));
    assert(fs.existsSync(path.join(store.MODELS_DIR, saved.file)));
    assert.equal(saved.params.wheelPattern, undefined);
    store.removeStoredModel('future-car');
    assert(!store.ensureRegistry().some((item) => item.id === 'future-car'));
    assert(fs.existsSync(path.join(store.MODELS_DIR, saved.file)), '移出清单保留 GLB');
    assert.throws(() => store.upsertStoredModel({ id: 'mcl35m', label: 'duplicate', file: saved.file }), /内置车型重复/);
  });
  await test('showcase 本地预览上传权限、隔离、文件限制与失败保留', async () => {
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    const route = require(path.join(root, 'app/api/showcase/models/preview-upload/route.ts'));
    const json = Buffer.from(JSON.stringify({ asset:{version:'2.0'}, buffers:[{byteLength:36}], bufferViews:[{buffer:0,byteLength:36}], accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]}], materials:[{name:'body'}], meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}], nodes:[{mesh:0}], scenes:[{nodes:[0]}], scene:0 }));
    const padded=Math.ceil(json.length/4)*4, glb=Buffer.alloc(28+padded+36);
    glb.writeUInt32LE(0x46546c67,0); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8); glb.writeUInt32LE(padded,12); glb.writeUInt32LE(0x4e4f534a,16); glb.fill(32,20,20+padded); json.copy(glb,20); glb.writeUInt32LE(36,20+padded); glb.writeUInt32LE(0x004e4942,24+padded);
    const call=(role,id,body=glb,extra={})=>new Request(`http://localhost:3000/api/showcase/models/preview-upload?id=${encodeURIComponent(id)}`,{method:'POST',headers:{cookie:`fire_session=${tokens[role]}`,...extra},body});
    assert.equal((await route.POST(call('user','mcl35m'))).status,403);
    assert.equal((await route.POST(call('admin','../bad'))).status,404);
    assert.equal((await route.POST(call('admin','missing-car'))).status,404);
    fs.mkdirSync(store.MODELS_DIR,{recursive:true}); fs.mkdirSync(store.PREVIEWS_DIR,{recursive:true});
    for(const id of ['preview-one','preview-two']) { fs.writeFileSync(path.join(store.MODELS_DIR,`${id}.glb`),glb); store.upsertStoredModel({id,label:id,file:`${id}.glb`}); }
    const target=path.join(store.PREVIEWS_DIR,'preview-one-preview.glb'), untouched=path.join(store.PREVIEWS_DIR,'preview-two-preview.glb'); fs.writeFileSync(untouched,'untouched');
    const uploaded = await route.POST(call('admin','preview-one')); assert.equal(uploaded.status,200,await uploaded.text());
    assert.deepEqual(fs.readFileSync(target),glb); assert.equal(fs.readFileSync(untouched,'utf8'),'untouched');
    assert.equal((await route.POST(call('admin','preview-one',Buffer.from('broken')))).status,400);
    assert.deepEqual(fs.readFileSync(target),glb,'failed upload preserves previous preview');
    assert.equal((await route.POST(call('admin','preview-one',glb,{'content-length':String(33*1024*1024)}))).status,413);
    assert.equal((await route.POST(call('admin','preview-one',Buffer.alloc(33*1024*1024)))).status,413,'streaming body limit applies without Content-Length');
    assert(!fs.readdirSync(store.PREVIEWS_DIR).some(file=>file.startsWith('.')),'temporary files removed');
    assert.equal((await route.POST(call('admin','mcl35m'))).status,200);
    assert(fs.existsSync(path.join(store.PREVIEWS_DIR,'builtin-mcl35m-preview.glb')));
    const gpuRoute = require(path.join(root, 'app/api/showcase/models/gpu-upload/route.ts'));
    const gpuCall=(role,id,body=glb)=>new Request(`http://localhost:3000/api/showcase/models/gpu-upload?id=${encodeURIComponent(id)}`,{method:'POST',headers:{cookie:`fire_session=${tokens[role]}`},body});
    assert.equal((await gpuRoute.POST(gpuCall('user','preview-one'))).status,403);
    assert.equal((await gpuRoute.POST(gpuCall('admin','../bad'))).status,404);
    const gpuDir=path.join(store.SHOWROOM_DIR,'gpu'); fs.mkdirSync(gpuDir,{recursive:true});
    const oldGpu=path.join(gpuDir,'preview-one-uastc.glb'); fs.writeFileSync(oldGpu,'existing validated derivative');
    assert.equal((await gpuRoute.POST(gpuCall('admin','preview-one'))).status,422,'source GLB is not a KTX2 derivative');
    assert.equal(fs.readFileSync(oldGpu,'utf8'),'existing validated derivative','failed upload preserves previous derivative');
    assert(!fs.readdirSync(gpuDir).some(file=>file.startsWith('.')),'failed derivative temporary file removed');
    for(const id of ['preview-one','preview-two']) store.removeStoredModel(id,{deleteFile:true});
  });
  await test('showcase 首页隐藏持久化、权限校验、恢复及全部隐藏不预载', async () => {
    const store = require(path.join(root, 'lib/showcaseModels.ts'));
    const route = require(path.join(root, 'app/api/showcase/models/[id]/route.ts'));
    const list = require(path.join(root, 'app/api/showcase/models/route.ts'));
    const context = id => ({ params: Promise.resolve({ id }) });
    fs.writeFileSync(path.join(store.MODELS_DIR, 'visibility-test.glb'), 'fixture');
    const model = store.upsertStoredModel({ id: 'visibility-test', label: 'Visibility', file: 'visibility-test.glb' });
    assert.equal((await route.PATCH(request(null, {hidden:true}, 'PATCH'), context(model.id))).status, 401);
    assert.equal((await route.PATCH(request('user', {hidden:true}, 'PATCH'), context(model.id))).status, 403);
    assert.equal((await route.PATCH(request('admin', {hidden:'true'}, 'PATCH'), context(model.id))).status, 400);
    const foreign = new Request('http://localhost:3000/api/showcase/models/visibility-test', { method:'PATCH', headers:{cookie:`fire_session=${tokens.admin}`,origin:'https://untrusted.example','Content-Type':'application/json'},body:JSON.stringify({hidden:true}) });
    assert([401,403].includes((await route.PATCH(foreign, context(model.id))).status), 'untrusted origin is rejected');
    const before = store.listShowcaseOptions().map(item => item.id);
    for (const id of before) assert.equal((await route.PATCH(request('admin', {hidden:true}, 'PATCH'), context(id))).status,200);
    assert.deepEqual(store.listShowcaseOptions(), []);
    assert.deepEqual((await (await list.GET()).json()).models, []);
    assert(fs.existsSync(path.join(store.MODELS_DIR, model.file)), 'hidden files are retained');
    assert(store.readStoredModels().some(item => item.id === model.id), 'hidden models remain editable');
    store.upsertStoredModel({ ...model, label:'Edited while hidden' });
    store.saveModelOrder([...before].reverse());
    assert.deepEqual(store.listShowcaseOptions(), [], 'editing and reordering cannot unhide models');
    assert(store.readRegistry().hiddenIds.includes('mcl35m'), 'builtin visibility persists too');
    for (const id of before) assert.equal((await route.PATCH(request('admin', {hidden:false}, 'PATCH'), context(id))).status,200);
    assert.deepEqual(store.listShowcaseOptions().map(item=>item.id), [...before].reverse());
    store.removeStoredModel(model.id, {deleteFile:true});
    const home = fs.readFileSync(path.join(root,'components/showcase/HomeShowcase.tsx'),'utf8');
    assert(home.indexOf('if (!current) return') < home.indexOf('<ShowcaseStage'), 'empty list renders without mounting the scene');
    assert(!fs.readFileSync(path.join(root,'app/page.tsx'),'utf8').includes('all.slice(0, 1)'), 'no hidden/default fallback');
  });
  await test('entrypoint: unwritable data volume fails loudly, failing seed does not block startup', () => {
    const { spawnSync } = require('node:child_process');
    const entrypoint = path.join(root, 'scripts/entrypoint.sh');
    const seedScript = path.join(root, 'scripts/seed-trading-square.mjs');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-entrypoint-'));
    const dirs = {
      data: path.join(base, 'data'),
      uploads: path.join(base, 'uploads'),
      defaults: path.join(base, 'defaults'),
      cache: path.join(base, 'cache'),
      public: path.join(base, 'public')
    };
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    const run = (extraEnv = {}) => spawnSync('sh', [entrypoint, 'echo', 'REACHED_CMD'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FIRE_ENTRYPOINT_DATA_DIR: dirs.data,
        FIRE_ENTRYPOINT_UPLOADS_DIR: dirs.uploads,
        FIRE_ENTRYPOINT_DEFAULTS_DIR: dirs.defaults,
        FIRE_ENTRYPOINT_CACHE_DIR: dirs.cache,
        FIRE_ENTRYPOINT_PUBLIC_DIR: dirs.public,
        FIRE_ENTRYPOINT_SEED_SCRIPT: seedScript,
        ...extraEnv
      }
    });
    try {
      // 数据目录不可写：必须给出中文提示并非零退出，而不是让日志只剩一行英文 EACCES。
      fs.chmodSync(dirs.data, 0o500);
      const blocked = run();
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /数据目录不可写/);
      assert.match(blocked.stderr, /chown -R 1000:1000/);
      assert.equal(blocked.stdout.includes('REACHED_CMD'), false);
      fs.chmodSync(dirs.data, 0o700);
      // 种子步骤失败（用占位目录挡住写入）：只告警，容器命令照常执行。
      fs.mkdirSync(path.join(dirs.data, 'duan-posts.json'), { recursive: true });
      fs.writeFileSync(path.join(dirs.cache, 'duan-posts.json'), JSON.stringify([{ id: '1', date: '2026-09-16T00:00:00Z', text: 'x', originalUrl: 'https://example.com' }]));
      const warned = run();
      assert.equal(warned.status, 0);
      assert.equal(warned.stdout.includes('REACHED_CMD'), true);
      assert.match(warned.stderr, /警告：公开缓存种子合并失败/);
      // 部署素材（插图 / 字体 / 图标 / 分享图）缺失：服务照常启动，但日志必须留一条中文线索，
      // 否则线上只会表现为「FIRE 页面的小丑鱼不见了」这种静默视觉缺失。
      assert.match(warned.stderr, /缺少部署素材： images fonts icons share/);
      for (const media of ['images', 'fonts', 'icons', 'share']) {
        const dir = path.join(dirs.public, media);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'placeholder'), 'x');
      }
      const stocked = run();
      assert.equal(stocked.status, 0);
      assert.equal(stocked.stderr.includes('缺少部署素材'), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  await test('totp: generate, verify, replay, backup codes, login ticket', async () => {
    const totp = require(path.join(root, 'lib/totp.ts'));
    const totpAuth = require(path.join(root, 'lib/totpAuth.ts'));
    const totpInput = require(path.join(root, 'lib/totpInput.ts'));
    assert.equal(totpInput.normalizeTotpDigits('12 34 56'), '123456');
    assert.equal(totpInput.normalizeTotpDigits('1234567'), '123456');
    assert.equal(totpInput.isSixDigitTotp('123456'), true);
    assert.equal(totpInput.isSixDigitTotp('12345'), false);
    assert.equal(totpInput.normalizeBackupInput('ABCD-EF01-2345-6789 extra'), 'abcd-ef01-2345-6789');
    assert.equal(totpInput.isCompleteBackupCode('abcd-ef01'), true);
    const secret = totp.generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    const url = totp.totpOtpauthUrl('Fire', 'review_user', secret);
    assert(url.startsWith('otpauth://totp/Fire:review_user?'));
    assert(url.includes(`secret=${secret}`));
    assert(url.includes('issuer=Fire'));
    assert(url.includes('digits=6'));
    assert(url.includes('period=30'));
    assert(!url.includes('algorithm='));
    const code = totp.totpCodeAt(secret);
    assert.match(code, /^\d{6}$/);
    const first = totp.verifyTotpCode(secret, code);
    assert.equal(first.ok, true);
    assert.equal(totp.verifyTotpCode(secret, code, first.step).ok, false, '同一时间步不能重放');
    assert.equal(totp.verifyTotpCode(secret, '000000').ok, false);
    const backups = totp.generateBackupCodes();
    assert.equal(backups.length, 8);
    assert.match(backups[0], /^[a-f0-9]{4}(?:-[a-f0-9]{4}){3}$/);
    const hashes = backups.map(totp.hashBackupCode);
    assert(hashes[0].startsWith('v2:'));
    const used = totp.verifyBackupCode(backups[0], hashes);
    assert.equal(used.ok, true);
    assert.equal(used.remaining.length, 7);
    assert.equal(totp.verifyBackupCode(backups[0], used.remaining).ok, false, '备用码只能用一次');
    const legacy = require('node:crypto').createHash('sha256').update(totp.normalizeBackupCode('abcd-ef01')).digest('hex');
    assert.equal(totp.verifyBackupCode('abcd-ef01', [legacy]).ok, true, '旧版 SHA256 备用码哈希仍可核验');

    const totpUser = createUser('totp_review', 'Totp-test-1234');
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), false);
    const setup = await totpAuth.beginTotpSetup(totpUser.id, totpUser.username, 'Fire');
    assert(setup.qrSvg.includes('<svg'));
    assert(setup.qrPng.startsWith('data:image/png'));
    assert(setup.otpauthUrl.includes(`secret=${setup.secret}`));
    assert(!setup.otpauthUrl.includes('chart.googleapis'));
    const enableCode = totp.totpCodeAt(setup.secret);
    const enabled = totpAuth.enableTotp(totpUser.id, enableCode);
    assert.equal(enabled.ok, true);
    assert.equal(enabled.backupCodes.length, 8);
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), true);
    assert.equal(totpAuth.enableTotp(totpUser.id, totp.totpCodeAt(setup.secret)).ok, false, '已开启不能再绑定');
    const stored = getDb().prepare('SELECT totp_secret FROM users WHERE id = ?').get(totpUser.id);
    assert(String(stored.totp_secret).startsWith('enc:v1:'), '密钥落盘需加密');
    const ticket = totpAuth.createLoginTicket(totpUser.id);
    const replay = totpAuth.completeLoginTicket(ticket, enableCode);
    assert.equal(replay.ok, false, '开启时用过的验证码不能再登录');
    const firstTicket = totpAuth.createLoginTicket(totpUser.id);
    const secondTicket = totpAuth.createLoginTicket(totpUser.id);
    assert.equal(totpAuth.completeLoginTicket(firstTicket, enabled.backupCodes[0]).ok, false, '新 ticket 作废旧 ticket');
    const viaBackup = totpAuth.completeLoginTicket(secondTicket, enabled.backupCodes[0]);
    assert.equal(viaBackup.ok, true);
    assert.equal(viaBackup.userId, totpUser.id);
    const ticket3 = totpAuth.createLoginTicket(totpUser.id);
    assert.equal(totpAuth.completeLoginTicket(ticket3, enabled.backupCodes[0]).ok, false, '同一备用码不能再用');
    const locked = totpAuth.createLoginTicket(totpUser.id);
    for (let i = 0; i < 8; i++) assert.equal(totpAuth.completeLoginTicket(locked, '000000').ok, false);
    assert.match(totpAuth.completeLoginTicket(locked, enabled.backupCodes[1]).error, /次数过多|过期/);
    totpAuth.clearTotp(totpUser.id);
    assert.equal(totpAuth.userTotpEnabled(totpUser.id), false);
    const disableUser = createUser('totp_disable', 'Totp-test-1234');
    const setup2 = await totpAuth.beginTotpSetup(disableUser.id, disableUser.username, 'Fire');
    totpAuth.enableTotp(disableUser.id, totp.totpCodeAt(setup2.secret));
    assert.equal(totpAuth.disableTotp(disableUser.id, totp.totpCodeAt(setup2.secret), false).ok, false);
    assert.equal(totpAuth.disableTotp(disableUser.id, totp.totpCodeAt(setup2.secret), false).error, '密码或验证码不正确');

    const loginForm = fs.readFileSync(path.join(root, 'components/LoginForm.tsx'), 'utf8');
    assert(loginForm.includes('/api/auth/login/totp'));
    assert(loginForm.includes('{!totpTicket && ('));
    assert(loginForm.includes('使用备用码'));
    assert(loginForm.includes('normalizeTotpDigits'));
    const loginRoute = fs.readFileSync(path.join(root, 'app/api/auth/login/route.ts'), 'utf8');
    assert(loginRoute.includes('requires2fa'));
    assert(loginRoute.includes('createLoginTicket'));
    const listUsersSrc = fs.readFileSync(path.join(root, 'lib/auth.ts'), 'utf8');
    assert(listUsersSrc.includes('u.totp_enabled'));
    assert(!/SELECT u\.\*/.test(listUsersSrc), '用户列表不得 SELECT * 带出密钥');
    const setupRoute = fs.readFileSync(path.join(root, 'app/api/auth/totp/route.ts'), 'utf8');
    assert(setupRoute.includes('otpauthUrl'));
    assert(setupRoute.includes('qrPng'));
    const spec = fs.readFileSync(path.join(root, 'docs/api-spec.md'), 'utf8');
    assert(spec.includes('40104'));
    assert(spec.includes('/api/v1/auth/login/totp'));
    const settings = fs.readFileSync(path.join(root, 'components/views/SettingsView.tsx'), 'utf8');
    assert(settings.includes('复制密钥'));
    assert(settings.includes('或手动输入密钥'));
    assert(settings.includes('确认开启后密钥和二维码都不再显示'));
    assert(settings.includes('confirmTotpSetup} className="mt-4 flex flex-col gap-3"'));
    assert(settings.includes('下载备用码'));
    assert(settings.includes('totpEnabled && !totpBackupCodes?.length'));
    assert(!settings.includes('/api/auth/totp/reveal'));
    assert(!settings.includes('添加其他验证器'));
    // 入口名用通用叫法 2FA，但点进去的页面文案保持「二次验证」
    assert(settings.includes('{ key: "totp", label: "2FA" }'));
    assert(settings.includes('label: "2FA", groupLabel: "账号"'));
    assert(settings.includes('<SettingsHeader name="totp" title="二次验证" />'));
    assert(settings.includes('{sub === "totp" && ('));
    assert(settings.includes('sub: "totp"'));
    assert(!settings.includes('desc: "头像、资料、密码、二次验证、数据管理"'));
    assert(settings.includes('url.searchParams.delete("anchor")'), '只有一个区块时不写重复的 anchor');
  });
  db.close();console.log(`${passed} regression suites passed (isolated database)`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{ fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode || 0); });
