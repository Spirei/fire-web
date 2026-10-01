// All mutations use a disposable database/uploads tree, never the running site's users.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-profile-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://profile.test.example';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const auth = load('lib/auth.ts'), native = load('lib/appAuth.ts'), db = load('lib/db.ts').getDb();
const profile = load('app/api/v1/auth/profile/route.ts'), web = load('app/api/auth/profile/route.ts');
const me = load('app/api/v1/auth/me/route.ts'), upload = load('app/api/v1/upload/route.ts'), config = load('app/api/v1/auth/config/route.ts');
const user = auth.createUser('profile_owner', 'Profile-test-123'), other = auth.createUser('profile_other', 'Profile-test-123');
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
auth.updateProfile(other.id, { email: 'other@example.test' });
const browser = auth.createSession(user.id), origin = process.env.FIRE_APP_ORIGIN;
const request = (endpoint, body, token, method = 'PUT') => new Request(origin + '/api/v1/' + endpoint, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
function connect(scope = native.APP_SCOPE) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const values = { client_id: native.APP_CLIENT_ID, redirect_uri: native.APP_REDIRECT_URI, response_type: 'code', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: crypto.randomBytes(32).toString('base64url'), scope };
  const code = native.issueAppCode(native.parseAppAuthorization(values), user.id, browser);
  return native.exchangeAppCode({ ...values, code, code_verifier: verifier });
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ8sAAAAASUVORK5CYII=', 'base64');
function imageRequest(token, { kind = 'avatar', bytes = png, filename = 'picture.png', fields = {} } = {}) {
  const form = new FormData(); form.set('kind', kind); form.set('file', new File([bytes], filename, { type: 'image/png' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(origin + '/api/v1/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token, cookie: 'fire_session=' + browser }, body: form });
}
let count = 0;
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); count++; console.log('PASS ' + name); }
const row = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
(async () => {
  await test('discovery advertises optional editing without expanding default/old grants', async () => {
    const data = (await (await config.GET(new Request(origin + '/api/v1/auth/config'))).json()).data;
    assert.equal(data.scope, 'portfolio.read portfolio.write'); assert(data.scopes_supported.includes('profile.write'));
    assert.throws(() => native.parseAppAuthorization({ client_id: native.APP_CLIENT_ID, redirect_uri: native.APP_REDIRECT_URI, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'x'.repeat(43), state: 'x'.repeat(32), scope: 'profile.write' }));
    const old = connect();
    const identity = (await (await me.GET(request('auth/me', undefined, old.access_token, 'GET'))).json()).data;
    assert.equal(identity.id, user.id); assert.equal(identity.role, 'user'); assert.equal(identity.capabilities.profileWrite, false); assert.equal(identity.capabilities.avatarUpload, false);
    assert.equal((await profile.PUT(request('auth/profile', {nickname:'Not saved'}, old.access_token))).status, 401);
    assert.equal((await upload.POST(imageRequest(old.access_token))).status, 401);
    assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID, old.refresh_token).scope, native.APP_SCOPE);
  });
  const grant = connect('portfolio.read profile.write'), token = grant.access_token;
  await test('profile-only write is explicit and never grants portfolio/admin/legacy writes', () => {
    assert(auth.getAuthUser(request('auth/profile', {}, token)));
    for (const [path, method] of [['records','POST'], ['brokers','POST'], ['auth/devices','DELETE'], ['settings','PUT']]) assert.equal(auth.getAuthUser(request(path, undefined, token, method)), null);
    assert.equal(auth.getAuthUser(new Request(origin + '/api/auth/profile', { method:'PUT', headers:{authorization:'Bearer '+token,cookie:'fire_session='+browser,origin} })), null);
    assert.equal(db.prepare('SELECT scope FROM app_grants WHERE id=?').get(grant.grant_id).scope, 'portfolio.read profile.write');
  });
  await test('partial profiles are bidirectional, direct User responses and keep site role private', async () => {
    const before = row(user.id), foreign = row(other.id);
    const response = await profile.PUT(request('auth/profile', {nickname:'App昵称'}, token));
    const data = (await response.json()).data;
    assert.equal(response.status, 200); assert.equal(data.nickname, 'App昵称'); assert.equal(data.id, user.id); assert.equal(data.role, 'user'); assert.equal(data.capabilities.profileWrite, true); assert.equal(data.scope, 'portfolio.read profile.write'); assert(!data.user); assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(row(user.id).username, before.username); assert.equal(row(user.id).email, before.email); assert.equal(auth.getUserByToken(browser).nickname, data.nickname); assert.deepEqual(row(other.id), foreign);
    const webResponse = await web.PUT(new Request(origin+'/api/auth/profile',{method:'PUT',headers:{cookie:'fire_session='+browser,origin,'content-type':'application/json'},body:JSON.stringify({username:'profile_renamed'})}));
    assert.equal(webResponse.status, 200); assert.equal((await webResponse.json()).user.role, 'admin');
    const appUser = (await (await me.GET(request('auth/me', undefined, token, 'GET'))).json()).data;
    assert.equal(appUser.username, 'profile_renamed'); assert.equal(appUser.nickname, 'App昵称');
    assert(!JSON.stringify(appUser).includes('password_hash')); assert(!JSON.stringify(appUser).includes('security_stamp'));
  });
  await test('field restrictions, conflicts and invalid input reject atomically', async () => {
    const before = row(user.id);
    for (const body of [[], {}, {role:'admin'}, {id:other.id,nickname:'bad'}, {uid:'2'}, {avatar:'/uploads/evil'}, {username:3}, {nickname:null}, {username:'a'}, {nickname:'x'.repeat(21)}, {email:'broken'}, {email:'x'.repeat(255)+'@x.test'}]) {
      const response = await profile.PUT(request('auth/profile', body, token)); assert.equal(response.status, 400, JSON.stringify(body)); assert.deepEqual(row(user.id), before);
    }
    for (const body of [{username:other.username,nickname:'bad'}, {email:'OTHER@example.test',nickname:'bad',currentPassword:'Profile-test-123'}]) {
      assert.equal((await profile.PUT(request('auth/profile', body, token))).status, 409); assert.deepEqual(row(user.id), before);
    }
  });
  await test('email needs current password, clears verification and never authenticates by cookie fallback', async () => {
    const before = row(user.id);
    for (const currentPassword of [undefined, 'wrong']) {
      const response = await profile.PUT(request('auth/profile',{nickname:'bad',email:'new@example.test',currentPassword},token));
      assert.equal(response.status, 403); assert.deepEqual(row(user.id), before);
    }
    const response = await profile.PUT(request('auth/profile',{email:'new@example.test',currentPassword:'Profile-test-123'},token));
    assert.equal(response.status, 200); const data = (await response.json()).data;
    assert.equal(data.email,'new@example.test'); assert.equal(data.emailVerified,false); assert.equal(auth.getUserByToken(browser).email,'new@example.test'); assert.equal(data.nickname,before.nickname);
    assert.equal((await profile.PUT(request('auth/profile',{email:'NEW@example.test'},token))).status,200,'case-only changes preserve Web rule');
  });
  await test('database profile failures roll back every field and return a private error envelope', async () => {
    const before=row(user.id);
    db.exec("CREATE TEMP TRIGGER fail_profile BEFORE UPDATE OF nickname ON users BEGIN SELECT RAISE(ABORT,'private database diagnostic'); END");
    try {
      const response=await profile.PUT(request('auth/profile',{nickname:'bad',email:'rollback@example.test',currentPassword:'Profile-test-123'},token));
      const body=await response.json(); assert.equal(response.status,500); assert.equal(body.code,50001); assert(!JSON.stringify(body).includes('private database')); assert.equal(body.data,undefined);
    } finally { db.exec('DROP TRIGGER fail_profile'); }
    assert.deepEqual(row(user.id),before); assert.equal((await me.GET(request('auth/me',undefined,token,'GET'))).status,200);
  });
  await test('a concurrent browser update is not overwritten by an App nickname patch', async () => {
    const bodies = load('lib/requestBody.ts'), read = bodies.readJsonBody;
    bodies.readJsonBody = async (...args) => { const body = await read(...args); auth.updateProfile(user.id,{username:'concurrent_owner'}); return body; };
    try { assert.equal((await profile.PUT(request('auth/profile',{nickname:'并发昵称'},token))).status,200); }
    finally { bodies.readJsonBody = read; }
    assert.equal(row(user.id).username,'concurrent_owner'); assert.equal(row(user.id).nickname,'并发昵称');
  });
  await test('profile identity revalidation catches revocation during body reads', async () => {
    const fresh = connect('portfolio.read profile.write'), before = row(user.id);
    const bodies = load('lib/requestBody.ts'), read = bodies.readJsonBody;
    bodies.readJsonBody = async (...args) => { const body = await read(...args); native.revokeAppGrant(fresh.grant_id); return body; };
    try { assert.equal((await profile.PUT(request('auth/profile',{nickname:'bad'},fresh.access_token))).status,401); }
    finally { bodies.readJsonBody = read; }
    assert.deepEqual(row(user.id),before);
  });
  let savedPath;
  await test('avatar uses shared naming, is owned by caller and syncs immediately to Web', async () => {
    const before = row(other.id);
    const response = await upload.POST(imageRequest(token,{fields:{userId:other.id,folder:'card'}}));
    assert.equal(response.status,200); const data = (await response.json()).data;
    assert.equal(data.kind,'avatar'); assert.equal(decodeURIComponent(data.url), `/uploads/avatar/concurrent_owner(UID${user.uid}).png`);
    savedPath = path.join(temp,'public',decodeURIComponent(data.url)); assert.deepEqual(fs.readFileSync(savedPath),png);
    assert.equal(auth.getUserByToken(browser).avatar,data.url); assert.equal((await (await me.GET(request('auth/me',undefined,token,'GET'))).json()).data.avatar,data.url); assert.deepEqual(row(other.id),before);
  });
  await test('App avatar upload forbids shared assets, SVG/mismatched formats and card limit bypass', async () => {
    const before = row(user.id);
    for (const options of [{kind:'asset'},{kind:'ico'},{kind:'logo'},{filename:'bad.svg',bytes:Buffer.from('<svg/>')},{bytes:Buffer.from('not a PNG')},{bytes:Buffer.alloc(5*1024*1024+1),fields:{folder:'card'}}]) {
      const response = await upload.POST(imageRequest(token,options)); assert.equal(response.status,options.kind ? 403 : 400); assert.deepEqual(row(user.id),before); assert.deepEqual(fs.readFileSync(savedPath),png);
    }
  });
  await test('avatar database failure restores existing bytes and leaves no temporary images', async () => {
    const before = row(user.id), bytes = fs.readFileSync(savedPath);
    db.exec("CREATE TEMP TRIGGER fail_avatar BEFORE UPDATE OF avatar ON users BEGIN SELECT RAISE(ABORT,'isolated rollback'); END");
    try { const response = await upload.POST(imageRequest(token,{bytes:Buffer.concat([png,Buffer.from('second')])})); assert.equal(response.status,500); assert.equal((await response.json()).code,50001); }
    finally { db.exec('DROP TRIGGER fail_avatar'); }
    assert.deepEqual(row(user.id),before); assert.deepEqual(fs.readFileSync(savedPath),bytes); assert.deepEqual(fs.readdirSync(path.dirname(savedPath)),[path.basename(savedPath)]);
  });
  await test('avatar revocation after multipart parsing cannot leave a file or change an identity', async () => {
    const fresh = connect('portfolio.read profile.write'), before = row(user.id), bytes = fs.readFileSync(savedPath);
    const bodies = load('lib/requestBody.ts'), read = bodies.readFormBody;
    bodies.readFormBody = async (...args) => { const form = await read(...args); native.revokeAppGrant(fresh.grant_id); return form; };
    try { assert.equal((await upload.POST(imageRequest(fresh.access_token))).status,401); }
    finally { bodies.readFormBody = read; }
    assert.deepEqual(row(user.id),before); assert.deepEqual(fs.readFileSync(savedPath),bytes);
  });
  await test('case-only avatar names never unlink the replacement on case-insensitive filesystems', async () => {
    auth.updateProfile(user.id,{username:'CONCURRENT_OWNER'});
    const response=await upload.POST(imageRequest(token)); assert.equal(response.status,200);
    const data=(await response.json()).data, nextPath=path.join(temp,'public',decodeURIComponent(data.url));
    assert(fs.existsSync(nextPath),'the new image must still exist after old-file cleanup'); assert.deepEqual(fs.readFileSync(nextPath),png); assert.equal(row(user.id).avatar,data.url);
  });
  console.log(`PASS ${count} shared profile suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
