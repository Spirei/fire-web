// Real ES256 attestations/assertions against real routes and an isolated SQLite database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-passkeys-'));
process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const { isoCBOR } = require('@simplewebauthn/server/helpers');
const auth = require(path.join(root, 'lib/auth.ts'));
const store = require(path.join(root, 'lib/passkeys.ts'));
const route = require(path.join(root, 'app/api/auth/passkeys/route.ts'));
const configRoute = require(path.join(root, 'app/api/auth/passkeys/config/route.ts'));
const db = require(path.join(root, 'lib/db.ts')).getDb();
const origin = 'https://fire.example.test';
const password = 'Passkey-test-123';
const user = auth.createUser('passkey_user', password);
const other = auth.createUser('passkey_other', password);
const session = auth.createSession(user.id);
const otherSession = auth.createSession(other.id);
const hash = value => crypto.createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
let suites = 0;
async function test(name, fn) { await fn(); suites++; console.log(`PASS ${name}`); }
function request(body, cookie = '', method = 'POST', source = origin) {
  return new Request(`${origin}/api/auth/passkeys`, { method, headers: { origin: source, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const cookie = token => `fire_session=${token}`;
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicCOSE = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  return { id: crypto.randomBytes(32), privateKey, publicCOSE };
}
function clientData(type, challenge, source = origin, crossOrigin = false) { return Buffer.from(JSON.stringify({ type, challenge, origin: source, crossOrigin })); }
function attestation(device, options, flags = 0x5d) {
  const client = clientData('webauthn.create', options.challenge);
  const idLength = Buffer.alloc(2); idLength.writeUInt16BE(device.id.length);
  const data = Buffer.concat([hash(options.rp.id), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), idLength, device.id, Buffer.from(device.publicCOSE)]);
  const object = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]));
  return { id: b64(device.id), rawId: b64(device.id), type: 'public-key', clientExtensionResults: { credProps: { rk: true } }, response: { attestationObject: b64(object), clientDataJSON: b64(client), transports: ['internal', 'hybrid'] } };
}
function assertion(device, options, handle, changes = {}) {
  const counter = Buffer.alloc(4); counter.writeUInt32BE(changes.counter ?? 0);
  const data = Buffer.concat([hash(changes.rpID || options.rpId), Buffer.from([changes.flags ?? 0x1d]), counter]);
  const client = clientData('webauthn.get', changes.challenge || options.challenge, changes.origin || origin, changes.crossOrigin || false);
  const signature = crypto.sign('sha256', Buffer.concat([data, hash(client)]), device.privateKey);
  return { id: b64(device.id), rawId: b64(device.id), type: 'public-key', clientExtensionResults: {}, response: { authenticatorData: b64(data), clientDataJSON: b64(client), signature: b64(signature), userHandle: handle } };
}
async function options(action, sessionToken, extra = {}) {
  const response = await route.POST(request({ action, password, ...extra }, sessionToken ? cookie(sessionToken) : ''));
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  return { ...body, cookie: [sessionToken ? cookie(sessionToken) : '', ...response.headers.getSetCookie().map(value => value.split(';')[0])].filter(Boolean).join('; ') };
}
async function login(device, handle, changes = {}, binding) {
  const pending = await options('login-options');
  const body = { action: 'login-verify', requestId: pending.requestId, response: assertion(device, pending.options, handle, changes) };
  return { response: await route.POST(request(body, binding ?? pending.cookie)), body, pending };
}
(async () => {
  await test('configuration accepts HTTPS domains and localhost, rejects unsafe URLs', () => {
    for (const bad of ['http://example.com', 'https://127.0.0.1', 'https://example.com/path', 'https://name:pass@example.com', 'https://example.com?x=1', 'javascript:alert(1)']) assert.throws(() => store.normalizePasskeyConfig({ enabled: true, origin: bad, name: 'Fire' }));
    assert.equal(store.normalizePasskeyConfig({ enabled: true, origin: 'http://localhost:3000/', name: 'Fire' }).rpID, 'localhost');
    store.savePasskeyConfig(store.normalizePasskeyConfig({ enabled: true, origin, name: 'Fire' }));
  });
  await test('config is public but mutations require admin password and reject CSRF', async () => {
    assert.equal((await configRoute.GET()).status, 200);
    assert.equal((await configRoute.PUT(request({ enabled: false }, cookie(session), 'PUT'))).status, 403);
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(other.id);
    assert.equal((await configRoute.PUT(request({ enabled: false, currentPassword: 'wrong' }, cookie(otherSession), 'PUT'))).status, 403);
    assert.equal((await configRoute.PUT(request({ enabled: false, currentPassword: password }, cookie(otherSession), 'PUT', 'https://evil.example'))).status, 403);
  });
  await test('enrollment requires session, password, correct origin and no authenticator restriction', async () => {
    assert.equal((await route.POST(request({ action: 'register-options', password }))).status, 401);
    assert.equal((await route.POST(request({ action: 'register-options', password: 'wrong' }, cookie(session)))).status, 400);
    assert.equal((await route.POST(request({ action: 'register-options', password }, cookie(session), 'POST', 'https://evil.example'))).status, 400);
  });
  const device = authenticator(); let handle;
  await test('real ES256 discoverable registration stores only public key and can be replayed zero times', async () => {
    const pending = await options('register-options', session);
    handle = pending.options.user.id;
    assert.equal(pending.options.authenticatorSelection.residentKey, 'required');
    assert.equal(pending.options.authenticatorSelection.userVerification, 'required');
    assert.equal(pending.options.authenticatorSelection.authenticatorAttachment, undefined);
    const body = { action: 'register-verify', requestId: pending.requestId, response: attestation(device, pending.options), name: 'iCloud test' };
    assert.equal((await route.POST(request(body, pending.cookie))).status, 200);
    assert.equal((await route.POST(request(body, pending.cookie))).status, 400);
    assert.equal(store.listPasskeys(user.id)[0].backed_up, 1);
    assert.equal(store.listPasskeys(user.id)[0].user_handle, handle);
  });
  await test('username-less synced passkey login accepts zero counter and issues HttpOnly Secure cookie', async () => {
    const result = await login(device, handle);
    assert.equal(result.response.status, 200);
    const cookies = result.response.headers.get('set-cookie');
    assert(cookies.includes('HttpOnly') && cookies.includes('Secure') && cookies.includes('SameSite=lax'));
    const token = cookies.match(/(?:^|, )fire_session=([^;]+)/)[1];
    assert.equal(auth.getUserByToken(token).id, user.id);
    assert.equal((await route.POST(request(result.body, result.pending.cookie))).status, 400);
    assert.equal((await login(device, handle)).response.status, 200, 'synced passkeys may keep a zero counter');
  });
  await test('wrong origin, RP ID, challenge, user handle, missing UV and cross-origin all fail', async () => {
    for (const change of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { challenge: 'wrong' }, { flags: 0x19 }, { crossOrigin: true }]) {
      assert.equal((await login(device, handle, change)).response.status, 400, JSON.stringify(change));
    }
    assert.equal((await login(device, 'wrong-user')).response.status, 400);
    assert.equal((await login(device, handle, {}, '')).response.status, 400, 'no challenge binding cookie');
    const stranger = authenticator(); stranger.id = device.id;
    assert.equal((await login(stranger, handle)).response.status, 400, 'bad signature');
  });
  await test('expired challenges and disabled config cannot log in', async () => {
    const pending = await options('login-options');
    db.prepare('UPDATE passkey_challenges SET expires_at=0 WHERE id=?').run(pending.requestId);
    assert.equal((await route.POST(request({ action: 'login-verify', requestId: pending.requestId, response: assertion(device, pending.options, handle) }, pending.cookie))).status, 400);
    const another = await options('login-options');
    store.savePasskeyConfig(store.normalizePasskeyConfig({ enabled: false, origin, name: 'Fire' }));
    assert.equal((await route.POST(request({ action: 'login-verify', requestId: another.requestId, response: assertion(device, another.options, handle) }, another.cookie))).status, 400);
    store.savePasskeyConfig(store.normalizePasskeyConfig({ enabled: true, origin, name: 'Fire' }));
  });
  await test('enrollment binds session and password version; cross-user management is denied', async () => {
    const pending = await options('register-options', session);
    const second = authenticator();
    const body = { action: 'register-verify', requestId: pending.requestId, response: attestation(second, pending.options) };
    assert.equal((await route.POST(request(body, pending.cookie.replace(session, otherSession)))).status, 400);
    auth.updatePassword(user.id, 'Changed-test-456');
    assert.equal((await route.POST(request(body, pending.cookie))).status, 400);
    auth.updatePassword(user.id, password);
    assert.equal((await route.PATCH(request({ id: b64(device.id), name: 'stolen' }, cookie(otherSession), 'PATCH'))).status, 404);
    assert.equal((await route.DELETE(request({ id: b64(device.id), password }, cookie(otherSession), 'DELETE'))).status, 404);
  });
  await test('TOTP protects enrollment; password reset revokes credentials and sessions', async () => {
    const totp = require(path.join(root, 'lib/totpAuth.ts'));
    const setup = await totp.beginTotpSetup(user.id, user.username);
    const enabled = totp.enableTotp(user.id, require(path.join(root, 'lib/totp.ts')).totpCodeAt(setup.secret));
    assert(enabled.ok);
    assert.equal((await route.POST(request({ action: 'register-options', password }, cookie(session)))).status, 400);
    assert.equal((await login(device, handle)).response.status, 200, 'passkey UV replaces password plus TOTP');
    const reset = require(path.join(root, 'app/api/users/[id]/reset-password/route.ts'));
    assert.equal((await reset.POST(request({ newPassword: 'Recovery-123', currentPassword: password }, cookie(otherSession)), { params: Promise.resolve({ id: user.id }) })).status, 200);
    assert.equal(store.listPasskeys(user.id).length, 0);
    assert.equal(auth.getUserByToken(session), null);
    assert.equal((await login(device, handle)).response.status, 400);
  });
  await test('owner can rename and revoke a key; hardware counter cannot go backwards', async () => {
    const pending = await options('register-options', otherSession);
    const hardware = authenticator();
    const registered = await route.POST(request({ action: 'register-verify', requestId: pending.requestId, response: attestation(hardware, pending.options, 0x45), name: 'Security key' }, pending.cookie));
    assert.equal(registered.status, 200);
    const id = b64(hardware.id);
    assert.equal((await login(hardware, pending.options.user.id, { flags: 0x05, counter: 1 })).response.status, 200);
    assert.equal((await login(hardware, pending.options.user.id, { flags: 0x05, counter: 1 })).response.status, 400);
    assert.equal((await route.PATCH(request({ id, name: 'Renamed key' }, cookie(otherSession), 'PATCH'))).status, 200);
    assert.equal(store.listPasskeys(other.id)[0].name, 'Renamed key');
    assert.equal((await route.DELETE(request({ id, password: 'wrong' }, cookie(otherSession), 'DELETE'))).status, 403);
    assert.equal((await route.DELETE(request({ id, password }, cookie(otherSession), 'DELETE'))).status, 200);
    assert.equal((await login(hardware, pending.options.user.id, { flags: 0x05, counter: 2 })).response.status, 400);
  });
  await test('registration without user verification is rejected', async () => {
    const pending = await options('register-options', otherSession);
    const unverified = authenticator();
    assert.equal((await route.POST(request({ action: 'register-verify', requestId: pending.requestId, response: attestation(unverified, pending.options, 0x41) }, pending.cookie))).status, 400);
    assert.equal(store.listPasskeys(other.id).length, 0);
  });
  await test('deletion revokes associated and legacy sessions but preserves unrelated sessions', async () => {
    db.prepare('DELETE FROM rate_limit').run();
    const owner = auth.createUser('revocation_owner', password);
    const ownerSession = auth.createSession(owner.id);
    const first = authenticator(), second = authenticator();
    let userHandle;
    for (const key of [first, second]) {
      const pending = await options('register-options', ownerSession);
      userHandle = pending.options.user.id;
      assert.equal((await route.POST(request({ action: 'register-verify', requestId: pending.requestId, response: attestation(key, pending.options) }, pending.cookie))).status, 200);
    }
    const tokenOf = result => result.response.headers.getSetCookie().find(value => value.startsWith('fire_session=')).split(';')[0].slice('fire_session='.length);
    const firstSession = tokenOf(await login(first, userHandle));
    const secondSession = tokenOf(await login(second, userHandle));
    const legacyToken = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(hash(legacyToken).toString('hex'), owner.id, Date.now()+86400000);
    assert.equal(auth.getUserByToken(legacyToken).id, owner.id);
    const pendingLogin = await options('login-options');
    const pendingRegister = await options('register-options', firstSession);
    const replacement = authenticator();
    const removed = await route.DELETE(request({ id: b64(first.id), password }, cookie(ownerSession), 'DELETE'));
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).signedOut, false);
    assert.equal(auth.getUserByToken(firstSession), null);
    assert.equal(auth.getUserByToken(legacyToken), null);
    assert.equal(auth.renewSessionIfNeeded(firstSession), false);
    assert.equal(auth.getUserByToken(ownerSession).id, owner.id);
    assert.equal(auth.getUserByToken(secondSession).id, owner.id);
    assert.equal(auth.getUserByToken(otherSession).id, other.id);
    assert.equal((await route.POST(request({ action: 'login-verify', requestId: pendingLogin.requestId, response: assertion(first, pendingLogin.options, userHandle) }, pendingLogin.cookie))).status, 400);
    assert.equal((await route.POST(request({ action: 'register-verify', requestId: pendingRegister.requestId, response: attestation(replacement, pendingRegister.options) }, pendingRegister.cookie))).status, 401);
    const selfRemoved = await route.DELETE(request({ id: b64(second.id), password }, cookie(secondSession), 'DELETE'));
    assert.equal(selfRemoved.status, 200);
    assert.equal((await selfRemoved.json()).signedOut, true);
    assert.equal(auth.getUserByToken(secondSession), null);
  });
  await test('invalid anonymous requests do not exhaust valid options or enrollment', async () => {
    db.prepare('DELETE FROM rate_limit').run();
    delete process.env.FIRE_TRUST_PROXY_HEADERS;
    for (let i=0; i<510; i++) {
      assert.equal((await route.POST(request({ action: 'invalid' }, '', 'POST', i%2 ? origin : 'https://evil.example'))).status, 400);
    }
    assert.equal((await route.POST(request({ action: 'login-options' }))).status, 200);
    assert.equal((await route.POST(request({ action: 'register-options', password }, cookie(otherSession)))).status, 200);
  });
  await test('direct browser budgets are isolated and keep one pending challenge per browser', async () => {
    db.prepare('DELETE FROM rate_limit').run();
    const initial = await options('login-options');
    let latest;
    for (let i=1; i<30; i++) {
      const response = await route.POST(request({ action: 'login-options' }, initial.cookie));
      assert.equal(response.status, 200);
      latest = await response.json();
    }
    assert.equal((await route.POST(request({ action: 'login-options' }, initial.cookie))).status, 429);
    assert.equal((await route.POST(request({ action: 'login-options' }))).status, 200, 'another browser is not locked');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM passkey_challenges WHERE id=?').get(initial.requestId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM passkey_challenges WHERE id=?').get(latest.requestId).n, 1);
    const good = store.passkeyLoginClient(request({}, initial.cookie));
    assert(initial.cookie.includes(good.cookie));
    const forged = store.passkeyLoginClient(request({}, `${store.PASSKEY_CLIENT_COOKIE}=${good.cookie.slice(0,-1)}${good.cookie.endsWith('0')?'1':'0'}`));
    assert.notEqual(forged.id, good.id, 'tampering cannot choose another browser bucket');
  });
  await test('proxy IP budgets are isolated and options exhaustion cannot block valid verification', async () => {
    db.prepare('DELETE FROM rate_limit').run();
    process.env.FIRE_TRUST_PROXY_HEADERS='true';
    const pending = await options('register-options', otherSession);
    const key = authenticator();
    assert.equal((await route.POST(request({ action:'register-verify', requestId:pending.requestId, response:attestation(key,pending.options) }, pending.cookie))).status,200);
    const loginPending = await options('login-options');
    for (let i=0; i<100; i++) {
      const req = request({action:'login-options'}); req.headers.set('x-forwarded-for','192.0.2.1');
      assert.equal((await route.POST(req)).status,200);
    }
    const denied = request({action:'login-options'}); denied.headers.set('x-forwarded-for','192.0.2.1');
    assert.equal((await route.POST(denied)).status,429);
    const unaffected = request({action:'login-options'}); unaffected.headers.set('x-forwarded-for','198.51.100.1');
    assert.equal((await route.POST(unaffected)).status,200);
    const verify = request({action:'login-verify', requestId:loginPending.requestId, response:assertion(key,loginPending.options,pending.options.user.id)},loginPending.cookie);
    verify.headers.set('x-forwarded-for','192.0.2.1');
    const replay = verify.clone();
    assert.equal((await route.POST(verify)).status,200);
    assert.equal((await route.POST(replay)).status,400);
    delete process.env.FIRE_TRUST_PROXY_HEADERS;
  });
  console.log(`${suites} passkey security suites passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  db.close(); process.chdir(root); fs.rmSync(temp, { recursive: true, force: true });
});
