/* Real handlers and collectors, disposable SQLite, transport mocks: no live writes/network. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-outbound-security-'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
process.chdir(temp); process.env.NODE_ENV = 'production'; process.env.INITIAL_ADMIN_USERNAME = ''; process.env.INITIAL_ADMIN_PASSWORD = '';
process.env.STOCKLOG_FUTU = 'off'; process.env.STOCKLOG_PROXY = 'off'; process.env.FIRE_APP_ORIGIN = 'https://outbound.example.test';
global.fetch = async () => { throw Error('External network disabled'); };
const load = file => require(path.join(root, file));
const network = load('lib/net.ts'), remote = load('lib/remoteFetch.ts'), images = load('lib/tradingSquareImages.ts'), bodies = load('lib/requestBody.ts');
const settings = load('lib/settings.ts'), auth = load('lib/auth.ts'), db = load('lib/db.ts').getDb();
const admin = auth.createUser('outbound_admin', 'Outbound-test-123'); db.prepare("UPDATE users SET role='admin',email='admin@example.test' WHERE id=?").run(admin.id);
const session = auth.createSession(admin.id), origin = process.env.FIRE_APP_ORIGIN;
const request = body => new Request(origin + '/api/settings', { method: 'PUT', headers: { cookie: 'fire_session=' + session, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
let passed = 0;
async function test(name, run) { await run(); console.log('PASS ' + name); passed++; }

(async () => {
  await test('proxy diagnostics drop credentials, path secrets, queries and fragments', async () => {
    assert.equal(network.redactedNetworkTarget('http://proxy-user:proxy-pass@proxy.example:8080/private/token?api_key=SECRET#code'), 'http://proxy.example:8080');
    assert.equal(network.redactedNetworkTarget(new Request('https://api.example/SECRET?token=SECRET')), 'https://api.example');
    const log = console.log, messages = [], fetch = global.fetch; process.env.STOCKLOG_PROXY_DEBUG = '1';
    console.log = value => messages.push(value); global.fetch = async () => new Response('ok');
    try { await network.proxyFetch('http://127.0.0.1/private-secret?key=query-secret#fragment-secret'); }
    finally { console.log = log; global.fetch = fetch; delete process.env.STOCKLOG_PROXY_DEBUG; }
    assert.equal(messages.length, 1); assert(!messages.join('').includes('secret')); assert(messages[0].includes('127.0.0.1'));
  });
  await test('mapped IPv6 and full link-local range bypass proxy while public names stay public', () => {
    for (const host of ['::', '::1', 'fe80::1', 'febf::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:c0a8:1', 'localhost.']) assert(network.isPrivateHost(host), host);
    for (const host of ['fc-news.example', 'fda.example', '1.1.1.1', '2001:4860:4860::8888', '::ffff:808:808']) assert(!network.isPrivateHost(host), host);
  });
  await test('remote images validate before every redirect and cancel redirect bodies', async () => {
    let calls = 0, cancelled = 0;
    global.fetch = async (url, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: 'https://127.0.0.1/private' } }); };
    await assert.rejects(remote.fetchAllowedRemoteGet('https://xqimg.imedao.com/photo.png', images.isAllowedRemoteImageUrl), /not_allowed/);
    assert.equal(calls, 1); assert.equal(cancelled, 1);
    calls = 0;
    global.fetch = async (url, init) => { calls++; assert.equal(init.redirect, 'manual'); return calls === 1 ? new Response(null, { status: 302, headers: { location: 'https://xavatar.imedao.com/photo.png' } }) : new Response('image'); };
    assert.equal(await (await remote.fetchAllowedRemoteGet('https://xqimg.imedao.com/photo.png', images.isAllowedRemoteImageUrl)).text(), 'image'); assert.equal(calls, 2);
    for (const url of ['https://xqimg.imedao.com:8443/photo.png', 'https://xqimg.imedao.com.attacker.example/photo.png', 'https://user:secret@xqimg.imedao.com/photo.png']) assert(!images.isAllowedRemoteImageUrl(url));
  });
  await test('archive pagination stays on administrator-authorized origin, including a private gateway', async () => {
    assert(remote.sameOriginRemoteUrl('http://192.168.1.2:8080/archive?cursor=2', 'http://192.168.1.2:8080/archive'));
    assert(remote.sameOriginRemoteUrl('https://www.trumpstruth.org/?cursor=2', 'https://trumpstruth.org/'));
    assert(!remote.sameOriginRemoteUrl('https://www.trumpstruth.org.attacker.example/?cursor=2', 'https://trumpstruth.org/'));
    assert(!remote.sameOriginRemoteUrl('http://www.trumpstruth.org/?cursor=2', 'https://trumpstruth.org/'));
    assert(!remote.sameOriginRemoteUrl('http://127.0.0.1:8080/?cursor=2', 'https://trumpstruth.org/'));
    const collector = load('lib/tradingSquareRefresh.ts'), calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url)); assert.equal(init.redirect, 'manual');
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://www.trumpstruth.org/' } });
      return new Response('<div class="status" data-status-url="https://trumpstruth.org/statuses/1001"><time datetime="2026-10-01T12:00:00Z"></time><div class="status__content">Published original.</div></div><a href="http://127.0.0.1/private?cursor=2">Next Page</a>');
    };
    const posts = await collector.refreshTrumpPosts({ translateBeforeSave: false, maxPages: 2 });
    assert.equal(calls.length, 2); assert.equal(calls[1], 'https://www.trumpstruth.org/'); assert.equal(posts.length, 1); assert.equal(posts[0].text, 'Published original.');
  });
  await test('chunked remote bodies stop and cancel at the byte budget', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }));
    await assert.rejects(bodies.readLimitedResponseBytes(response, 8), bodies.RequestBodyTooLargeError); assert(cancelled);
  });
  await test('SMTP save binds old password to endpoint and login, and leaves failed configuration untouched', async () => {
    const initial = { smtpHost: 'smtp.example.test', smtpPort: '587', smtpSecure: false, smtpUser: 'sender', smtpPassword: 'fixture-smtp-secret', smtpFromEmail: 'sender@example.test' };
    settings.updateSiteSettings(initial);
    const route = load('app/api/settings/route.ts');
    for (const patch of [{ smtpHost: 'attacker.example.test' }, { smtpPort: '465' }, { smtpUser: 'attacker' }, { smtpSecure: true }]) {
      const result = await route.PUT(request(patch)); assert.equal(result.status, 400); assert((await result.json()).error.includes('密码')); assert.equal(settings.getSiteSettings().smtpHost, initial.smtpHost); assert.equal(settings.getSiteSettings().smtpPassword, initial.smtpPassword);
    }
    assert.equal((await route.PUT(request({ smtpHost: 'SMTP.EXAMPLE.TEST', smtpPassword: '', title: 'Unrelated setting' }))).status, 200);
    assert.equal(settings.getSiteSettings().smtpPassword, initial.smtpPassword);
    assert.equal((await route.PUT(request({ smtpHost: 'new.example.test', smtpPassword: 'new-fixture-secret' }))).status, 200);
    assert.equal(settings.getSiteSettings().smtpPassword, 'new-fixture-secret');
    settings.updateSiteSettings(initial);
  });
  await test('SMTP test refuses old credentials for a new endpoint before creating a transport', async () => {
    const nodemailer = require('nodemailer'), mailer = nodemailer.default || nodemailer, original = mailer.createTransport, transports = [];
    mailer.createTransport = config => { transports.push(config); return { sendMail: async () => ({}) }; };
    try {
      const mail = load('lib/mail.ts');
      await assert.rejects(mail.sendTestEmail('admin@example.test', { host: 'attacker.example.test', password: '' }), /密码/); assert.equal(transports.length, 0);
      const tested = await load('app/api/settings/mail-test/route.ts').POST(new Request(origin + '/api/settings/mail-test', { method: 'POST', headers: { cookie: 'fire_session=' + session, origin, 'content-type': 'application/json' }, body: JSON.stringify({ smtpHost: 'attacker.example.test', smtpPort: 587, smtpUser: 'sender', smtpPassword: '', smtpFromEmail: 'sender@example.test' }) }));
      assert.equal(tested.status, 400); assert((await tested.json()).error.includes('密码')); assert.equal(transports.length, 0);
      await mail.sendTestEmail('same@example.test', { host: 'SMTP.EXAMPLE.TEST', password: '' }); assert.equal(transports[0].auth.pass, 'fixture-smtp-secret');
      await mail.sendTestEmail('new@example.test', { host: 'new.example.test', password: 'explicit-new-secret' }); assert.equal(transports[1].auth.pass, 'explicit-new-secret');
      assert.equal(transports[0].requireTLS, true); assert.equal(transports[0].tls.rejectUnauthorized, true);
    } finally { mailer.createTransport = original; }
  });
  await test('browser-visible configured URLs reject new userinfo and redact legacy userinfo without changing storage', async () => {
    const route = load('app/api/settings/route.ts');
    assert.equal((await route.PUT(request({ quoteApiUrl: 'https://user:secret@quotes.example.test/' }))).status, 400);
    assert.equal((await route.PUT(request({ quoteApiUrl: 'http://192.168.1.2:8080/q={q}' }))).status, 200);
    const raw = 'https://legacy-user:legacy-secret@quotes.example.test/q='; settings.updateSiteSettings({ quoteApiUrl: raw });
    for (const adminView of [true, false]) {
      const client = load('lib/settingsClient.ts').clientSettings(settings.getSiteSettings(), adminView);
      assert.equal(client.quoteApiUrl, adminView ? 'https://quotes.example.test/q=' : ''); assert(!JSON.stringify(client).includes('legacy-secret'));
    }
    assert.equal(settings.getSiteSettings().quoteApiUrl, raw);
  });
  await test('ordinary configuration hides server source query keys while preserving safe calendar image bases', () => {
    const fixture = { ...settings.getSiteSettings(), currencyApiUrl: 'https://rates.example.test/latest?api_key=FIXTURE_QUERY_SECRET&base=USD', usLogoApiUrl: 'https://logos.example.test/logo/?apikey=FIXTURE_LOGO_SECRET&size=64', cnLogoApiUrl: 'https://logos.example.test/cn/?token=FIXTURE_TOKEN&scale=2' };
    const ordinary = load('lib/settingsClient.ts').clientSettings(fixture, false), administrator = load('lib/settingsClient.ts').clientSettings(fixture, true);
    assert.equal(ordinary.currencyApiUrl, ''); assert.equal(ordinary.usLogoApiUrl, 'https://logos.example.test/logo/?size=64'); assert.equal(ordinary.cnLogoApiUrl, 'https://logos.example.test/cn/?scale=2');
    assert(!JSON.stringify(ordinary).includes('FIXTURE_')); assert.equal(administrator.currencyApiUrl, fixture.currencyApiUrl); assert.equal(administrator.usLogoApiUrl, fixture.usLogoApiUrl);
    assert.equal(fixture.currencyApiUrl, 'https://rates.example.test/latest?api_key=FIXTURE_QUERY_SECRET&base=USD');
  });
  await test('vision transports forbid redirects and never log untrusted response text or error messages', async () => {
    const image = path.join(temp, 'vision.png'); fs.writeFileSync(image, 'local fixture image');
    const warn = console.warn, logs = []; console.warn = (...args) => logs.push(args.join(' '));
    try {
      process.env.DEEPSEEK_API_KEY = 'fixture-key'; const vision = load('lib/deepseekVision.ts');
      global.fetch = async (url, init) => { assert.equal(init.redirect, 'error'); return new Response('PRIVATE_IMAGE_AND_CREDENTIALS', { status: 500 }); };
      assert.equal(await vision.askDeepSeekVision(image, 'image/png', 'fixture'), null);
      global.fetch = async () => { throw Error('PRIVATE_IMAGE_AND_CREDENTIALS'); }; assert.equal(await vision.askDeepSeekVision(image, 'image/png', 'fixture'), null);
      delete process.env.DEEPSEEK_API_KEY; process.env.DASHSCOPE_API_KEY = 'fixture-key'; const card = load('lib/cardRecognize.ts');
      global.fetch = async (url, init) => { assert.equal(init.redirect, 'error'); return new Response('PRIVATE_IMAGE_AND_CREDENTIALS', { status: 500 }); };
      assert.equal(await card.recognizeCardImage(image, 'image/png'), null); assert(!logs.join('').includes('PRIVATE_IMAGE'));
    } finally { console.warn = warn; delete process.env.DASHSCOPE_API_KEY; delete process.env.DEEPSEEK_API_KEY; }
  });
  console.log(`${passed} outbound security regressions passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
