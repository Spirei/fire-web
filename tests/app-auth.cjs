// Native authorization through real routes, isolated SQLite; never writes application data.
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const crypto = require('node:crypto'); const Module = require('node:module'); const ts = require('typescript');
const root = path.resolve(__dirname, '..'); const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-app-auth-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://fire.test.example:18520';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const origin = process.env.FIRE_APP_ORIGIN;
const auth = require(path.join(root, 'lib/auth.ts')); const native = require(path.join(root, 'lib/appAuth.ts'));
const authorize = require(path.join(root, 'app/api/v1/auth/authorize/route.ts'));
const tokenRoute = require(path.join(root, 'app/api/v1/auth/token/route.ts'));
const deviceRoute = require(path.join(root, 'app/api/v1/auth/devices/route.ts'));
const configRoute = require(path.join(root, 'app/api/v1/auth/config/route.ts'));
const revokeRoute = require(path.join(root, 'app/api/v1/auth/revoke/route.ts'));
const meRoute = require(path.join(root, 'app/api/v1/auth/me/route.ts'));
const recordsRoute = require(path.join(root, 'app/api/v1/records/route.ts'));
const assetsRoute = require(path.join(root, 'app/api/v1/assets/route.ts'));
const db = require(path.join(root, 'lib/db.ts')).getDb();
const user = auth.createUser('app_admin', 'Test-app-123'); const other = auth.createUser('app_other', 'Test-app-123');
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
const browser = auth.createSession(user.id); const otherBrowser = auth.createSession(other.id);
const b64 = bytes => bytes.toString('base64url');
const verifier = b64(crypto.randomBytes(32));
const requestValues = { response_type: 'code', client_id: 'fire-ios', redirect_uri: native.APP_REDIRECT_URI, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: b64(crypto.randomBytes(32)), scope: native.APP_SCOPE, device_name: '测试 iPhone' };
let count = 0;
async function test(name, fn) { db.prepare("DELETE FROM rate_limit WHERE key LIKE ?").run("app-authorize:%"); await fn(); console.log('PASS ' + name); count++; }
function req(endpoint, body, cookieToken = browser, method = 'POST', source = origin, bearer) {
  const headers = { host: new URL(origin).host, ...(source ? { origin: source } : {}), 'content-type': 'application/json', ...(cookieToken ? { cookie: 'fire_session=' + cookieToken } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) };
  return new Request(origin + '/api/v1/' + endpoint, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function connect(values = requestValues, browserToken = browser) {
  const response = await authorize.POST(req('auth/authorize', { ...values, decision: 'allow' }, browserToken));
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  const url = new URL(body.data.callback);
  assert.equal(url.searchParams.get('state'), values.state); assert(!url.searchParams.has('access_token'));
  const code = url.searchParams.get('code');
  const exchange = { grant_type: 'authorization_code', client_id: 'fire-ios', redirect_uri: native.APP_REDIRECT_URI, code, code_verifier: verifier };
  return { code, exchange };
}
async function redeem(exchange) { return tokenRoute.POST(req('auth/token', exchange, null)); }
async function connected(values, browserToken) { const { exchange } = await connect(values, browserToken); const response = await redeem(exchange); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data; }
const identity = token => auth.getAuthUser(req('auth/me', null, null, 'GET', null, token));
(async () => {
  await test('authorization duration handles minute boundaries, whole days and clock skew', () => {
    const { appAuthorizationDuration: duration } = require(path.join(root, 'lib/appDeviceTime.ts'));
    const start = Date.UTC(2026, 8, 27, 14, 32);
    assert.equal(duration(start, start + 59_999), '不足 1 分钟');
    assert.equal(duration(start, start + 60_000), '1 分钟');
    assert.equal(duration(start, start + 3_600_000), '1 小时');
    assert.equal(duration(start, start + 3_720_000), '1 小时 2 分钟');
    assert.equal(duration(start, start + 86_400_000), '1 天');
    assert.equal(duration(start, start + 2 * 86_400_000 + 7 * 3_600_000), '2 天 7 小时');
    assert.equal(duration(start, start - 60_000), '不足 1 分钟');
    assert.equal(duration(NaN, start), '—');
    assert.equal(duration(start, Infinity), '—');
    assert.equal(duration(0, start), '—');
  });
  await test('discovery supports a nonstandard HTTPS port and only relative same-origin endpoints', async () => {
    const response = await configRoute.GET(req('auth/config', null, null, 'GET', null));
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.data.authorization_path, '/app/authorize'); assert.equal(body.data.redirect_uri, native.APP_REDIRECT_URI);
    assert.throws(() => native.assertAppOrigin(new Request('https://wrong.example/api/v1/auth/config')));
  });
  await test('consent requires browser login and rejects CSRF and Bearer authorization', async () => {
    const body = { ...requestValues, decision: 'allow' };
    assert.equal((await authorize.POST(req('auth/authorize', body, null))).status, 401);
    assert.equal((await authorize.POST(req('auth/authorize', body, browser, 'POST', 'https://evil.example'))).status, 403);
    assert.equal((await authorize.POST(req('auth/authorize', body, browser, 'POST', null))).status, 403);
    assert.equal((await authorize.POST(req('auth/authorize', body, browser, 'POST', origin, browser))).status, 403);
  });
  await test('redirect, client, scopes, state and S256 are strictly validated', async () => {
    for (const changes of [{ redirect_uri: 'evil:/oauth/callback' }, { client_id: 'evil' }, { scope: 'portfolio.read admin' }, { state: 'short' }, { code_challenge_method: 'plain' }, { code_challenge: 'short' }, { response_type: 'token' }]) {
      assert.equal((await authorize.POST(req('auth/authorize', { ...requestValues, ...changes, decision: 'allow' }))).status, 400);
    }
    const denied = await authorize.POST(req('auth/authorize', { ...requestValues, decision: 'deny' }));
    const callback = new URL((await denied.json()).data.callback); assert.equal(callback.searchParams.get('error'), 'access_denied');
  });
  await test('wrong verifier and wrong redirect cannot redeem; correct exchange succeeds exactly once', async () => {
    const { exchange } = await connect();
    assert.equal((await redeem({ ...exchange, code_verifier: b64(crypto.randomBytes(32)) })).status, 401);
    assert.equal((await redeem({ ...exchange, redirect_uri: 'evil:/oauth/callback' })).status, 401);
    assert.equal((await redeem(exchange)).status, 200); assert.equal((await redeem(exchange)).status, 401);
  });
  await test('expired authorization codes and logged-out originating sessions cannot be exchanged', async () => {
    const first = await connect(); db.prepare('UPDATE app_codes SET expires_at=? WHERE code_hash=?').run(Date.now()-1, native.appTokenHash(first.code));
    assert.equal((await redeem(first.exchange)).status, 401);
    const temporary = auth.createSession(user.id); const second = await connect(requestValues, temporary); auth.deleteSession(temporary);
    assert.equal((await redeem(second.exchange)).status, 401);
  });
  let credential;
  await test('native access is personal even when the source account is an administrator', async () => {
    credential = await connected(); assert.equal(auth.getUserByToken(browser).role, 'admin'); assert.equal(identity(credential.access_token).role, 'user');
    const me = await meRoute.GET(req('auth/me', null, null, 'GET', null, credential.access_token)); assert.equal((await me.json()).data.id, user.id);
    assert.equal(auth.getUserByToken(credential.access_token), null, 'native token never becomes a web Cookie session');
    assert.equal(auth.getAuthUser(req('assets', null, null, 'POST', null, credential.access_token)), null);
    assert.equal((await assetsRoute.POST(req('assets', { type: 'stock' }, null, 'POST', null, credential.access_token))).status, 401);
    assert.equal(auth.getAuthUser(req('auth/delete-account', null, null, 'POST', null, credential.access_token)), null);
    assert.equal(auth.getAuthUser(new Request(origin+'/api/settings',{method:'PUT',headers:{authorization:'Bearer '+credential.access_token}})), null);
  });
  await test('native writes remain user-isolated and more than 100 records are available through meta', async () => {
    const store = require(path.join(root, 'lib/store.ts'));
    for(let i=0;i<101;i++) store.createRecord(user.id, { name:'股票'+i,code:'T'+i,market:'US',qty:1,cost:1,price:1,group:'',note:'',source:'' });
    store.createRecord(other.id, { name:'另一个账户',code:'PRIVATE',market:'US',qty:1,cost:1,price:1,group:'',note:'',source:'' });
    const first = await recordsRoute.GET(new Request(origin+'/api/v1/records?page=1&pageSize=100',{headers:{authorization:'Bearer '+credential.access_token}})); const a=await first.json();
    const second = await recordsRoute.GET(new Request(origin+'/api/v1/records?page=2&pageSize=100',{headers:{authorization:'Bearer '+credential.access_token}})); const b=await second.json();
    assert.equal(a.meta.total,101); assert.equal(a.data.length,100); assert.equal(b.data.length,1); assert(![...a.data,...b.data].some(r=>r.code==='PRIVATE')); assert.match(first.headers.get('cache-control'),/no-store/);
  });
  await test('App connection reads the shared identity but cannot modify account profiles or avatars', async () => {
    const uploadRoute = require(path.join(root, 'app/api/v1/upload/route.ts'));
    const before = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    for (const endpoint of ['auth/profile', 'upload']) {
      for (const method of ['PUT', 'POST', 'DELETE']) assert.equal(auth.getAuthUser(req(endpoint, null, null, method, null, credential.access_token)), null);
    }
    assert.equal(auth.getAuthUser(new Request(origin + '/api/auth/profile', { method: 'PUT', headers: { authorization: 'Bearer ' + credential.access_token, cookie: 'fire_session=' + browser } })), null);
    const form = new FormData(); form.set('kind', 'avatar'); form.set('file', new File(['not uploaded'], 'avatar.png', { type: 'image/png' }));
    const denied = await uploadRoute.POST(new Request(origin + '/api/v1/upload', { method: 'POST', headers: { authorization: 'Bearer ' + credential.access_token, cookie: 'fire_session=' + browser }, body: form }));
    assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 40101);
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(user.id), before);
    assert(identity(credential.access_token)); assert(auth.getUserByToken(browser));
    assert.equal(identity(credential.access_token).id, auth.getUserByToken(browser).id, 'App and Web keep the same user');
  });
  await test('read-only grants cannot write', async () => {
    const limited = await connected({ ...requestValues, scope: 'portfolio.read' });
    assert(identity(limited.access_token)); assert.equal(auth.getAuthUser(req('records', {name:'bad'}, null,'POST',null,limited.access_token)),null);
  });
  await test('refresh is rotated, access lives 15 minutes, old refresh reuse revokes the whole family', async () => {
    const initial = await connected(); assert.equal(initial.expires_in,900);
    const response = await tokenRoute.POST(req('auth/token',{grant_type:'refresh_token',client_id:'fire-ios',refresh_token:initial.refresh_token},null)); const rotated=(await response.json()).data;
    assert.notEqual(initial.refresh_token,rotated.refresh_token); assert(identity(rotated.access_token));
    assert.equal((await tokenRoute.POST(req('auth/token',{grant_type:'refresh_token',client_id:'fire-ios',refresh_token:initial.refresh_token},null))).status,401);
    assert.equal(identity(rotated.access_token),null); assert.equal(native.refreshAppTokens('fire-ios',rotated.refresh_token),null);
  });
  await test('concurrent refresh attempts cannot both succeed or leave a usable replayed family', async () => {
    const initial = await connected();
    const body={grant_type:'refresh_token',client_id:'fire-ios',refresh_token:initial.refresh_token};
    const responses=await Promise.all([tokenRoute.POST(req('auth/token',body,null)),tokenRoute.POST(req('auth/token',body,null))]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
    const success=await responses.find(r=>r.status===200).json(); assert.equal(identity(success.data.access_token),null);
  });
  await test('expired access can refresh; idle and absolute grant expiry cannot be revived', async () => {
    const initial=await connected(); db.prepare('UPDATE app_access_tokens SET expires_at=? WHERE token_hash=?').run(Date.now()-1,native.appTokenHash(initial.access_token)); assert.equal(identity(initial.access_token),null);
    const fresh=native.refreshAppTokens('fire-ios',initial.refresh_token); assert(fresh);
    db.prepare('UPDATE app_grants SET expires_at=? WHERE id=?').run(Date.now()-1,fresh.grant_id); assert.equal(native.refreshAppTokens('fire-ios',fresh.refresh_token),null);
    const absolute=await connected(); db.prepare('UPDATE app_grants SET created_at=? WHERE id=?').run(Date.now()-91*86400000,absolute.grant_id); assert.equal(identity(absolute.access_token),null);
  });
  await test('device lists contain no token material and another account cannot revoke a device', async () => {
    const initial=await connected(); const response=await deviceRoute.GET(req('auth/devices',null,browser,'GET')); const text=await response.text(); assert(!text.includes(initial.access_token)); assert(!text.includes(initial.refresh_token)); assert(text.includes(initial.grant_id));
    assert.equal((await deviceRoute.GET(req('auth/devices',null,null,'GET',null,initial.access_token))).status,401);
    await deviceRoute.DELETE(req('auth/devices',{id:initial.grant_id},otherBrowser,'DELETE')); assert(identity(initial.access_token));
    await deviceRoute.DELETE(req('auth/devices',{id:initial.grant_id},browser,'DELETE')); assert.equal(identity(initial.access_token),null); assert.equal(native.refreshAppTokens('fire-ios',initial.refresh_token),null);
  });
  await test('device management preserves first authorization time across token refresh', async () => {
    const initial = await connected();
    const createdAt = Date.now() - 2 * 86_400_000 - 7 * 3_600_000;
    db.prepare('UPDATE app_grants SET created_at=?,last_used_at=? WHERE id=?').run(createdAt, createdAt, initial.grant_id);
    const rotated = native.refreshAppTokens('fire-ios', initial.refresh_token); assert(rotated);
    const response = await deviceRoute.GET(req('auth/devices', null, browser, 'GET'));
    const device = (await response.json()).data.devices.find(item => item.id === initial.grant_id);
    assert(device); assert.equal(device.name, requestValues.device_name); assert.equal(device.scope, requestValues.scope);
    assert.equal(device.createdAt, createdAt); assert(device.lastUsedAt > createdAt); assert(device.expiresAt > Date.now());
    const { appAuthorizationDuration } = require(path.join(root, 'lib/appDeviceTime.ts'));
    assert.equal(appAuthorizationDuration(device.createdAt, Date.now()), '2 天 7 小时');
    await deviceRoute.DELETE(req('auth/devices', { id: initial.grant_id }, browser, 'DELETE'));
    assert(!native.listAppDevices(user.id).some(item => item.id === initial.grant_id));
    assert.equal(identity(rotated.access_token), null); assert.equal(native.refreshAppTokens('fire-ios', rotated.refresh_token), null);
  });
  await test('legacy App default names adapt without rewriting grants or requiring authorization again', async () => {
    for (const name of ['Fire iOS', 'fire ios', 'Fire Fire iOS', '']) {
      const parsed = native.parseAppAuthorization({ ...requestValues, device_name: name });
      assert.equal(parsed.device_name, 'Alcor iOS');
      assert.equal(parsed.client_id, 'fire-ios'); assert.equal(parsed.redirect_uri, 'com.fire.app:/oauth/callback');
    }
    for (const name of ['My Fire iPhone', 'FIRE 平板', 'fire.example.com', '自定义设备']) {
      assert.equal(native.parseAppAuthorization({ ...requestValues, device_name: name }).device_name, name);
    }
    const initial = await connected();
    try {
      for (const [stored, displayed] of [['Fire iOS', 'Alcor iOS'], ['fire ios', 'Alcor iOS'], ['Fire Fire iOS', 'Alcor iOS'], ['My Fire iPhone', 'My Fire iPhone'], ['自定义设备', '自定义设备']]) {
        db.prepare('UPDATE app_grants SET device_name=? WHERE id=?').run(stored, initial.grant_id);
        const before = db.prepare('SELECT * FROM app_grants WHERE id=?').get(initial.grant_id);
        const response = await deviceRoute.GET(req('auth/devices', null, browser, 'GET'));
        const device = (await response.json()).data.devices.find(item => item.id === initial.grant_id);
        assert.equal(device.name, displayed);
        assert.equal(device.createdAt, before.created_at); assert.equal(device.scope, before.scope);
        assert.deepEqual(db.prepare('SELECT * FROM app_grants WHERE id=?').get(initial.grant_id), before, 'reading the device list does not migrate the grant');
        assert(identity(initial.access_token), 'existing access remains valid');
      }
      const rotated = native.refreshAppTokens('fire-ios', initial.refresh_token);
      assert(rotated); assert.equal(rotated.grant_id, initial.grant_id); assert(identity(rotated.access_token));
      assert(auth.getUserByToken(browser), 'the browser session is unchanged');
    } finally { native.revokeAppGrant(initial.grant_id); }
  });
  await test('App disconnect revokes refresh and access together, independently of browser login', async () => {
    const initial=await connected(); assert.equal((await revokeRoute.POST(req('auth/revoke',{client_id:'fire-ios',token:initial.refresh_token},null))).status,200);
    assert.equal(identity(initial.access_token),null); assert(auth.getUserByToken(browser));
  });
  await test('password and TOTP changes invalidate access immediately, and explicit session revocation clears grants', async () => {
    const initial=await connected(); const original=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id).password_hash;
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('changed',user.id); assert.equal(identity(initial.access_token),null);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(original,user.id);
    const factor=await connected(); db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(user.id); assert.equal(identity(factor.access_token),null); db.prepare('UPDATE users SET totp_enabled=0 WHERE id=?').run(user.id);
    const explicit=await connected(); auth.deleteOtherSessions(user.id,browser); assert.equal(identity(explicit.access_token),null); assert(auth.getUserByToken(browser));
  });
  await test('stored tokens are hashes, credentials cascade on account deletion, and pagination rejects nonfinite numbers', async () => {
    const initial=await connected(requestValues,otherBrowser);
    assert.equal(db.prepare('SELECT token_hash FROM app_access_tokens WHERE grant_id=?').get(initial.grant_id).token_hash,native.appTokenHash(initial.access_token));
    db.prepare('DELETE FROM users WHERE id=?').run(other.id); assert.equal(db.prepare('SELECT 1 FROM app_grants WHERE id=?').get(initial.grant_id),undefined);
    const {parsePage}=require(path.join(root,'lib/api.ts')); assert.deepEqual(parsePage(new URLSearchParams('page=Infinity&pageSize=Infinity')),{page:1,pageSize:20}); assert.deepEqual(parsePage(new URLSearchParams('page=2.8&pageSize=3.9')),{page:2,pageSize:3});
  });
  console.log(`PASS ${count} native authorization suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode || 0);});
