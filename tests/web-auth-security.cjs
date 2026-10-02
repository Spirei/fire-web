// Real Web authentication routes, isolated SQLite and uploads; no live account writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-web-auth-security-'));
process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off';
global.fetch = async () => { throw new Error('Network disabled in isolated regression'); };
const load = name => require(path.join(root, name));
const auth = load('lib/auth.ts'), db = load('lib/db.ts').getDb();
const totp = load('lib/totp.ts'), factors = load('lib/totpAuth.ts');
const me = load('app/api/auth/me/route.ts'), login = load('app/api/auth/login/route.ts');
const loginFactor = load('app/api/auth/login/totp/route.ts'), register = load('app/api/auth/register/route.ts');
const profile = load('app/api/auth/profile/route.ts');
const origin = 'https://web.example.test', password = 'Audit-auth-123';
const owner = auth.createUser('audit_owner', password), other = auth.createUser('audit_other', password);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const backupCode = 'abcd-1234-abcd-1234';
function enableFactor(user) {
  db.prepare('UPDATE users SET totp_enabled=1,totp_secret=?,totp_backup_codes=?,totp_last_step=-1 WHERE id=?')
    .run(load('lib/secretStorage.ts').encryptSecret(totp.generateTotpSecret()), JSON.stringify([totp.hashBackupCode(backupCode)]), user.id);
}
function request(endpoint, method = 'GET', body, headers = {}) {
  return new Request(origin + '/api/auth/' + endpoint, { method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
(async () => {
  await test('database session digests cannot be replayed as any accepted Web credential', async () => {
    for (const credential of ['cookie', 'legacy-cookie', 'bearer']) {
      const token = auth.createSession(owner.id), hash = digest(token);
      const headers = credential === 'bearer' ? { authorization: 'Bearer ' + hash } : { cookie: (credential === 'legacy-cookie' ? auth.LEGACY_SESSION_COOKIE : auth.SESSION_COOKIE) + '=' + hash };
      assert.equal((await me.GET(request('me', 'GET', undefined, headers))).status, 401, credential + ' rejects stored digest');
      assert.equal(auth.getUserByToken(hash), null);
      assert(db.prepare('SELECT 1 FROM sessions WHERE token=?').get(hash), 'rejection does not replace or revoke the legitimate session');
      assert.equal((await me.GET(request('me', 'GET', undefined, { cookie: auth.SESSION_COOKIE + '=' + token }))).status, 200);
      assert.equal((await me.GET(request('me', 'GET', undefined, { cookie: auth.LEGACY_SESSION_COOKIE + '=' + token }))).status, 200);
      assert.equal((await me.GET(request('me', 'GET', undefined, { authorization: 'Bearer ' + token }))).status, 200);
    }
  });
  await test('revocation accepts a real token but never its stored digest', () => {
    const token = auth.createSession(owner.id);
    auth.deleteSession(digest(token));
    assert.equal(auth.getUserByToken(token)?.id, owner.id);
    auth.deleteSession(token);
    assert.equal(auth.getUserByToken(token), null);
  });
  await test('cross-site text/plain forms cannot set login or registration cookies or consume factors', async () => {
    enableFactor(other);
    const ticket = factors.createLoginTicket(other.id);
    const entries = [[login.POST, 'login', { username: owner.username, password }], [loginFactor.POST, 'login/totp', { ticket, code: backupCode }], [register.POST, 'register', { username: 'csrf_created', password }]];
    for (const [handler, endpoint, body] of entries) {
      for (const source of ['https://evil.example.test', 'null', '']) {
        const headers = { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site', ...(source ? { origin: source } : {}) };
        // A text/plain HTML form can emit this valid JSON as its name=value pair.
        const form = JSON.stringify({ ...body, padding: '=' }) + '\r\n';
        const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
        const response = await handler(new Request(origin + '/api/auth/' + endpoint, { method: 'POST', headers, body: form }));
        assert.equal(response.status, 403, endpoint + ' rejects untrusted source');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
        assert.equal(auth.findUserByUsername('csrf_created'), undefined);
      }
    }
    assert(db.prepare('SELECT 1 FROM totp_tickets WHERE user_id=?').get(other.id));
    assert.equal(JSON.parse(db.prepare('SELECT totp_backup_codes FROM users WHERE id=?').get(other.id).totp_backup_codes).length, 1);
    assert.equal((await login.POST(request('login', 'POST', { username: owner.username, password }))).status, 200);
    assert.equal((await loginFactor.POST(request('login/totp', 'POST', { ticket, code: backupCode }))).status, 200);
    assert.equal((await register.POST(request('register', 'POST', { username: 'same_site_created', password }))).status, 201);
  });
  await test('Web recovery-email changes require the same second factor as App edits', async () => {
    enableFactor(other);
    const token = auth.createSession(other.id), cookie = auth.SESSION_COOKIE + '=' + token;
    const before = db.prepare('SELECT email,totp_backup_codes FROM users WHERE id=?').get(other.id);
    for (const code of [undefined, 'invalid-code', 123456]) {
      const response = await profile.PUT(request('profile', 'PUT', { email: 'replacement@example.test', currentPassword: password, ...(code === undefined ? {} : { code }) }, { cookie }));
      assert.equal(response.status, code === 123456 ? 400 : 403);
      assert.equal((await response.json()).requiresSecondFactor, code === 123456 ? undefined : true, 'factor rejection lets an unloaded status form recover');
      assert.deepEqual(db.prepare('SELECT email,totp_backup_codes FROM users WHERE id=?').get(other.id), before);
    }
    const badPassword = await profile.PUT(request('profile', 'PUT', { email: 'replacement@example.test', currentPassword: 'incorrect' }, { cookie }));
    assert.equal(badPassword.status, 403);
    assert.equal((await badPassword.json()).requiresSecondFactor, undefined);
    const response = await profile.PUT(request('profile', 'PUT', { email: 'replacement@example.test', currentPassword: password, code: backupCode }, { cookie }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.email, 'replacement@example.test');
    assert.equal(auth.getUserByToken(token)?.id, other.id, 'successful email change preserves the authenticated Web session');
    assert.deepEqual(JSON.parse(db.prepare('SELECT totp_backup_codes FROM users WHERE id=?').get(other.id).totp_backup_codes), []);
    assert.equal((await profile.PUT(request('profile', 'PUT', { email: 'again@example.test', currentPassword: password, code: backupCode }, { cookie }))).status, 403, 'consumed factor cannot be replayed');
    assert.equal((await profile.PUT(request('profile', 'PUT', { nickname: 'Safe nickname' }, { cookie }))).status, 200, 'ordinary profile fields do not require a factor');
    assert.equal((await profile.PUT(request('profile', 'PUT', { email: 'REPLACEMENT@example.test' }, { cookie }))).status, 200, 'case-only edits keep the same recovery identity');
  });
  await test('a password change invalidates a previously password-authenticated TOTP login ticket', () => {
    enableFactor(other);
    const ticket = factors.createLoginTicket(other.id);
    assert.equal(auth.updatePassword(other.id, 'Audit-changed-456'), true);
    assert.equal(factors.completeLoginTicket(ticket, backupCode).ok, false);
    assert.equal(JSON.parse(db.prepare('SELECT totp_backup_codes FROM users WHERE id=?').get(other.id).totp_backup_codes).length, 1, 'stale ticket cannot consume a current backup code');
  });
  await test('an unloaded TOTP status form recovers from a factor rejection and clears secrets only after a successful save', async () => {
    const source = fs.readFileSync(path.join(root, 'components/views/SettingsView.tsx'), 'utf8');
    const tree = ts.createSourceFile('SettingsView.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    let save, field;
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'saveProfile') save = node.getText(tree);
      if (ts.isJsxExpression(node) && node.expression?.getText(tree).startsWith('(totpEnabled || profileFactorRequired) &&')) field = node.expression.getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree); assert(save && field);
    const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
    const c = vm.createContext({ React, Event, profileSavingRef: { current: false }, profileSaving: false,
      nickname: 'Nickname', email: 'new@example.test', profilePassword: 'entered-password', profileCode: '',
      profileFactorRequired: false, totpEnabled: false, me: { email: 'old@example.test' }, editingProfile: true,
      window: { dispatchEvent() {} }, showToast() {}, sendEmailConfirmation() {},
      setProfileSaving(value) { c.profileSaving = value; }, setNickMsg(value) { c.nickMsg = value; },
      setProfileFactorRequired(value) { c.profileFactorRequired = value; }, setProfileCode(value) { c.profileCode = value; },
      setProfilePassword(value) { c.profilePassword = value; }, setEditingProfile(value) { c.editingProfile = value; },
      setNickname(value) { c.nickname = value; }, setEmail(value) { c.email = value; }, setMe(update) { c.me = update(c.me); },
      fetch: async () => new Response(JSON.stringify({ error: '二次验证失败', requiresSecondFactor: true }), { status: 403 })
    });
    vm.runInContext(ts.transpileModule(save, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, c);
    const renderField = () => {
      vm.runInContext(ts.transpileModule('globalThis.factorField=(' + field + ');', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText, c);
      return c.factorField ? renderToStaticMarkup(c.factorField) : '';
    };
    assert.equal(renderField(), '');
    await c.saveProfile();
    assert(/autocomplete="one-time-code"/i.test(renderField()));
    assert.equal(c.editingProfile, true); assert.equal(c.profilePassword, 'entered-password'); assert.equal(c.email, 'new@example.test');
    c.profileCode = 'entered-backup';
    // The initial GET can still fail/return late; its boolean cannot erase the server's form-specific requirement.
    c.totpEnabled = false; assert(renderField().includes('entered-backup'));
    c.fetch = async () => new Response(JSON.stringify({ user: { nickname: c.nickname, email: c.email, emailVerified: true } }));
    await c.saveProfile();
    assert.equal(c.profilePassword, ''); assert.equal(c.profileCode, ''); assert.equal(c.profileFactorRequired, false); assert.equal(c.editingProfile, false);
  });
  console.log(`${passed} Web authentication security regressions passed${failed ? `, ${failed} failed` : ''}.`);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
