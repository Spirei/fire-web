// Owner account actions use a disposable database; no real profiles or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-account-security-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://account.test.example:18520';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const auth = load('lib/auth.ts'), native = load('lib/appAuth.ts'), db = load('lib/db.ts').getDb();
const email = load('app/api/v1/auth/email/route.ts'), password = load('app/api/v1/auth/password/route.ts');
const webPassword = load('app/api/auth/password/route.ts'), me = load('app/api/v1/auth/me/route.ts'), config = load('app/api/v1/auth/config/route.ts');
const bodies = load('lib/requestBody.ts'), factors = load('lib/totp.ts'), passwords = load('lib/password.ts'), reset = load('lib/passwordReset.ts');
const origin = process.env.FIRE_APP_ORIGIN, oldPassword = 'Owner-old-123', newPassword = 'Owner-new-456';
const row = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
let fixtureIndex = 0, count = 0;
function connect(user, browser, scope = 'portfolio.read') {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const values = { client_id:native.APP_CLIENT_ID, redirect_uri:native.APP_REDIRECT_URI, response_type:'code', code_challenge_method:'S256', code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'), state:crypto.randomBytes(32).toString('base64url'), scope };
  const normalized = native.parseAppAuthorization(values);
  const code = native.issueAppCode(normalized, user.id, browser);
  return { ...native.exchangeAppCode({...values,code,code_verifier:verifier}), values: normalized, code };
}
function fixture(totp = false, admin = false) {
  fixtureIndex++;
  const user = auth.createUser('account_owner_'+fixtureIndex,oldPassword), other = auth.createUser('account_other_'+fixtureIndex,oldPassword);
  auth.updateProfile(user.id,{email:`owner${fixtureIndex}@example.test`}); auth.updateProfile(other.id,{email:`other${fixtureIndex}@example.test`});
  db.prepare('UPDATE users SET role=? WHERE id=?').run(admin?'admin':'user',user.id);
  const secret = factors.generateTotpSecret(), backup = factors.generateBackupCodes(1)[0];
  if(totp) db.prepare('UPDATE users SET totp_enabled=1,totp_secret=?,totp_backup_codes=? WHERE id=?').run(load('lib/secretStorage.ts').encryptSecret(secret),JSON.stringify([factors.hashBackupCode(backup)]),user.id);
  const browser = auth.createSession(user.id), secondBrowser = auth.createSession(user.id), otherBrowser = auth.createSession(other.id);
  return { user, other, browser, secondBrowser, otherBrowser, grant:connect(user,browser), otherGrant:connect(other,otherBrowser), secret, backup };
}
function req(endpoint, body, token, method = endpoint==='auth/email'?'PUT':'POST', extra = {}) {
  return new Request(origin+'/api/v1/'+endpoint,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...extra},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
const identity = token => auth.getAuthUser(req('auth/me',undefined,token,'GET'));
const change = (f, body = {}) => password.POST(req('auth/password',{currentPassword:oldPassword,newPassword,...body},f.grant.access_token));
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); count++; console.log('PASS '+name); }
(async()=>{
  await test('discovery and capabilities enable owner email/password for default and readonly connections without scope escalation',async()=>{
    const data=(await (await config.GET(new Request(origin+'/api/v1/auth/config'))).json()).data;
    assert.equal(data.email_path,'/api/v1/auth/email'); assert.equal(data.password_path,'/api/v1/auth/password'); assert.equal(data.scope,native.APP_SCOPE);
    for(const scope of ['portfolio.read',native.APP_SCOPE]) {
      const f=fixture(false,true), grant=connect(f.user,f.browser,scope);
      const user=(await (await me.GET(req('auth/me',undefined,grant.access_token,'GET'))).json()).data;
      assert.equal(user.role,'user'); assert.equal(user.scope,scope); assert.equal(user.capabilities.emailWrite,true); assert.equal(user.capabilities.passwordWrite,true); assert.equal(user.capabilities.profileWrite,false); assert.equal(user.security.twoFactorEnabled,false);
      assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID,grant.refresh_token).scope,scope);
    }
  });
  await test('email edits sync Web/current identity and invalidate all old-email verification and recovery credentials',async()=>{
    const f=fixture(), before=row(f.user.id), foreign=row(f.other.id);
    db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,before.email,Date.now());
    const token=reset.issuePasswordResetToken(f.user.id).token;
    const response=await email.PUT(req('auth/email',{email:'  changed@example.test  ',currentPassword:oldPassword},f.grant.access_token));
    assert.equal(response.status,200); const data=(await response.json()).data;
    assert.equal(data.id,f.user.id); assert.equal(data.email,'changed@example.test'); assert.equal(data.emailVerified,false); assert.equal(data.role,'user'); assert(!data.user); assert.equal(data.capabilities.emailWrite,true);
    assert.equal(auth.getUserByToken(f.browser).email,data.email); assert.equal(identity(f.grant.access_token).email,data.email); assert.equal(row(f.user.id).nickname,before.nickname); assert.deepEqual(row(f.other.id),foreign);
    for(const table of ['verified_emails','email_verification_tokens','password_reset_tokens','password_reset_codes','password_reset_totp']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(f.user.id).n,0);
    assert.equal(reset.consumePasswordResetToken(token,()=>assert.fail('old recovery cannot run')),null);
    assert.match(response.headers.get('cache-control'),/no-store/);
  });
  await test('email permits owner unbinding, requires credentials even for unchanged email, and rejects foreign fields/conflicts',async()=>{
    const f=fixture(), before=row(f.user.id);
    for(const currentPassword of [undefined,'wrong']) {
      assert.equal((await email.PUT(req('auth/email',{email:before.email,currentPassword},f.grant.access_token))).status,403); assert.deepEqual(row(f.user.id),before);
    }
    for(const body of [[],{}, {email:4,currentPassword:oldPassword},{email:'bad',currentPassword:oldPassword},{email:'x'.repeat(255)+'@a.test',currentPassword:oldPassword},{email:'new@example.test',currentPassword:oldPassword,id:f.other.id},{email:'new@example.test',currentPassword:oldPassword,nickname:'bypass'},{email:'new@example.test',currentPassword:oldPassword,role:'admin'}]) {
      assert.equal((await email.PUT(req('auth/email',body,f.grant.access_token))).status,400); assert.deepEqual(row(f.user.id),before);
    }
    assert.equal((await email.PUT(req('auth/email',{email:row(f.other.id).email.toUpperCase(),currentPassword:oldPassword},f.grant.access_token))).status,409); assert.deepEqual(row(f.user.id),before);
    assert.equal((await email.PUT(req('auth/email',{email:'',currentPassword:oldPassword},f.grant.access_token))).status,200); assert.equal(row(f.user.id).email,'');
  });
  await test('self-service route/method, bearer priority, origin and cross-account boundaries remain enforced',async()=>{
    const f=fixture(), before=row(f.user.id);
    for(const [endpoint,method] of [['auth/email','POST'],['auth/password','PUT'],['auth/email/other','PUT'],['users/'+f.other.id+'/password','POST']]) assert.equal(auth.getAuthUser(req(endpoint,undefined,f.grant.access_token,method)),null);
    for(const endpoint of ['auth/email','auth/password']) {
      const response=await (endpoint==='auth/email'?email.PUT:password.POST)(req(endpoint,{email:'evil@example.test',currentPassword:oldPassword,newPassword},'fat_'+'x'.repeat(43),undefined,{cookie:'fire_session='+f.browser})); assert.equal(response.status,401);
      const cross=await (endpoint==='auth/email'?email.PUT:password.POST)(req(endpoint,{},f.grant.access_token,undefined,{origin:'https://evil.example'})); assert.equal(cross.status,401);
    }
    const response=await email.PUT(req('auth/email',{email:'owner-only@example.test',currentPassword:oldPassword},f.grant.access_token,undefined,{cookie:'fire_session='+f.otherBrowser})); assert.equal(response.status,200); assert.equal(row(f.other.id).email,`other${fixtureIndex}@example.test`); assert.equal(row(f.user.id).password_hash,before.password_hash);
  });
  await test('password rejects wrong credentials, weak/typed inputs and arbitrary identity/security options without mutations',async()=>{
    const f=fixture(), before=row(f.user.id);
    for(const body of [{currentPassword:'wrong'}, {currentPassword:4}, {newPassword:'short'}, {newPassword:'lettersOnly'}, {newPassword:'x'.repeat(129)}, {newPassword:4}, {code:4}, {code:'x'.repeat(65)}, {id:f.other.id}, {role:'admin'}, {signOutOthers:false}, {oldPassword}]) {
      const response=await change(f,body); assert.equal(response.status,body.currentPassword==='wrong'?403:400,JSON.stringify(body)); assert.deepEqual(row(f.user.id),before); assert(identity(f.grant.access_token));
    }
  });
  await test('ordinary readonly owner changes password and receives safe success before every own old credential expires',async()=>{
    const f=fixture(), foreign=row(f.other.id), another=connect(f.user,f.browser,native.APP_SCOPE);
    const pending=native.issueAppCode(f.grant.values,f.user.id,f.browser);
    const recovery=reset.issuePasswordResetToken(f.user.id).token;
    const response=await change(f); assert.equal(response.status,200); const data=(await response.json()).data;
    assert.equal(data.ok,true); assert.equal(data.signedOutOthers,true); assert.equal(data.reauthenticationRequired,true); assert.equal(data.user.id,f.user.id); assert.equal(data.user.role,'user'); assert(!JSON.stringify(data).includes('password_hash')); assert(!JSON.stringify(data).includes(newPassword)); assert(!data.access_token); assert(!response.headers.get('set-cookie')); assert.match(response.headers.get('cache-control'),/no-store/);
    assert.equal(identity(f.grant.access_token),null); assert.equal(identity(another.access_token),null); assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID,f.grant.refresh_token),null); assert.equal(auth.getUserByToken(f.browser),null); assert.equal(auth.getUserByToken(f.secondBrowser),null);
    assert.equal(db.prepare('SELECT 1 FROM app_codes WHERE code_hash=?').get(native.appTokenHash(pending)),undefined);
    assert.equal(reset.consumePasswordResetToken(recovery,()=>assert.fail('pre-change recovery')),null);
    assert.equal(auth.authenticateUser(f.user.username,oldPassword),null); assert.equal(auth.authenticateUser(f.user.username,newPassword).id,f.user.id);
    assert.deepEqual(row(f.other.id),foreign); assert(identity(f.otherGrant.access_token)); assert(auth.getUserByToken(f.otherBrowser));
    assert.equal((await change(f)).status,401);
  });
  await test('TOTP and one-time backup factors are required; validation does not consume a valid factor',async()=>{
    const f=fixture(true), before=row(f.user.id);
    const user=(await (await me.GET(req('auth/me',undefined,f.grant.access_token,'GET'))).json()).data; assert.equal(user.security.twoFactorEnabled,true);
    for(const code of [undefined,'000-invalid']) { const response=await change(f,{code}); assert.equal(response.status,403); assert.equal((await response.json()).code,40104); assert.deepEqual(row(f.user.id),before); }
    assert.equal((await change(f,{newPassword:'weak',code:f.backup})).status,400); assert.deepEqual(row(f.user.id),before);
    assert.equal((await change(f,{currentPassword:'wrong',code:f.backup})).status,403); assert.deepEqual(row(f.user.id),before);
    assert.equal((await change(f,{code:factors.totpCodeAt(f.secret)})).status,200); assert(row(f.user.id).totp_last_step>=0);
    const backupFixture=fixture(true); assert.equal((await change(backupFixture,{code:backupFixture.backup})).status,200); assert.deepEqual(JSON.parse(row(backupFixture.user.id).totp_backup_codes),[]);
  });
  await test('database failure rolls back password, factor consumption, grants, codes and sessions with a private error',async()=>{
    const f=fixture(true), before=row(f.user.id), grantBefore=db.prepare('SELECT * FROM app_grants WHERE id=?').get(f.grant.grant_id);
    db.exec("CREATE TEMP TRIGGER fail_sessions BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'private database diagnostic'); END");
    try { const response=await change(f,{code:f.backup}); assert.equal(response.status,500); const body=await response.json(); assert.equal(body.code,50001); assert(!JSON.stringify(body).includes('private database')); }
    finally { db.exec('DROP TRIGGER fail_sessions'); }
    assert.deepEqual(row(f.user.id),before); assert.deepEqual(db.prepare('SELECT * FROM app_grants WHERE id=?').get(f.grant.grant_id),grantBefore); assert(identity(f.grant.access_token)); assert(auth.getUserByToken(f.browser));
    assert.equal((await change(f,{code:f.backup})).status,200);
  });
  await test('email database failure is atomic and hides diagnostics',async()=>{
    const f=fixture(), before=row(f.user.id);
    db.exec("CREATE TEMP TRIGGER fail_email BEFORE UPDATE OF email ON users BEGIN SELECT RAISE(ABORT,'private diagnostic'); END");
    try { const response=await email.PUT(req('auth/email',{email:'rollback@example.test',currentPassword:oldPassword},f.grant.access_token)); assert.equal(response.status,500); assert.equal((await response.json()).code,50001); }
    finally { db.exec('DROP TRIGGER fail_email'); }
    assert.deepEqual(row(f.user.id),before);
  });
  await test('TOTP protects both App email entry points and a failed email save never consumes a backup code',async()=>{
    const f=fixture(true), before=row(f.user.id), profile=load('app/api/v1/auth/profile/route.ts'), profileGrant=connect(f.user,f.browser,'portfolio.read profile.write');
    for(const [handler,endpoint,token] of [[email.PUT,'auth/email',f.grant.access_token],[profile.PUT,'auth/profile',profileGrant.access_token]]) {
      for(const code of [undefined,'bad-code']) {
        assert.equal((await handler(req(endpoint,{email:'factor-required@example.test',currentPassword:oldPassword,code},token,'PUT'))).status,403); assert.deepEqual(row(f.user.id),before);
      }
    }
    db.exec("CREATE TEMP TRIGGER fail_factor_email BEFORE UPDATE OF email ON users BEGIN SELECT RAISE(ABORT,'private diagnostic'); END");
    try { assert.equal((await email.PUT(req('auth/email',{email:'factor-required@example.test',currentPassword:oldPassword,code:f.backup},f.grant.access_token))).status,500); }
    finally { db.exec('DROP TRIGGER fail_factor_email'); }
    assert.deepEqual(row(f.user.id),before);
    const response=await email.PUT(req('auth/email',{email:'factor-required@example.test',currentPassword:oldPassword,code:f.backup},f.grant.access_token)); assert.equal(response.status,200); assert.equal((await response.json()).data.security.twoFactorEnabled,true); assert.equal(row(f.user.id).email,'factor-required@example.test'); assert.deepEqual(JSON.parse(row(f.user.id).totp_backup_codes),[]);
    assert.equal((await profile.PUT(req('auth/profile',{email:'replay@example.test',currentPassword:oldPassword,code:f.backup},profileGrant.access_token,'PUT'))).status,403);
  });
  await test('revocation during asynchronous request reads cannot change email/password',async()=>{
    for(const endpoint of ['auth/email','auth/password']) {
      const f=fixture(), before=row(f.user.id), read=bodies.readJsonBody;
      bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(f.grant.grant_id);return body;};
      try { const response=await (endpoint==='auth/email'?email.PUT:password.POST)(req(endpoint,{...(endpoint==='auth/email'?{email:'late@example.test'}:{newPassword}),currentPassword:oldPassword},f.grant.access_token)); assert.equal(response.status,401); }
      finally { bodies.readJsonBody=read; }
      assert.deepEqual(row(f.user.id),before);
    }
  });
  await test('concurrent Web password changes invalidate stale App operations and cannot be overwritten',async()=>{
    const f=fixture(), read=bodies.readJsonBody;
    bodies.readJsonBody=async(...args)=>{const body=await read(...args);auth.updatePassword(f.user.id,'Concurrent-789');return body;};
    try { assert.equal((await change(f)).status,401); } finally { bodies.readJsonBody=read; }
    assert(passwords.verifyPassword('Concurrent-789',row(f.user.id).password_hash)); assert(!passwords.verifyPassword(newPassword,row(f.user.id).password_hash));
  });
  await test('Web retains legacy request/response and optional other-session behavior while sharing safety rules',async()=>{
    const f=fixture();
    const response=await webPassword.POST(new Request(origin+'/api/auth/password',{method:'POST',headers:{cookie:'fire_session='+f.browser,origin,'content-type':'application/json'},body:JSON.stringify({oldPassword,newPassword,signOutOthers:false})}));
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true,signedOutOthers:false}); assert(auth.getUserByToken(f.browser)); assert(auth.getUserByToken(f.secondBrowser)); assert.equal(identity(f.grant.access_token),null);
    const g=fixture(), read=bodies.readJsonBody;
    bodies.readJsonBody=async(...args)=>{const body=await read(...args);auth.deleteSession(g.browser);return body;};
    try { assert.equal((await webPassword.POST(new Request(origin+'/api/auth/password',{method:'POST',headers:{cookie:'fire_session='+g.browser,origin,'content-type':'application/json'},body:JSON.stringify({oldPassword,newPassword})}))).status,401); }
    finally { bodies.readJsonBody=read; }
    assert(passwords.verifyPassword(oldPassword,row(g.user.id).password_hash));
  });
  await test('bounded JSON rejects arrays, malformed and oversized streamed bodies',async()=>{
    const f=fixture(), before=row(f.user.id);
    for(const endpoint of ['auth/email','auth/password']) {
      const method=endpoint==='auth/email'?'PUT':'POST';
      for(const raw of ['[]','{bad',JSON.stringify({currentPassword:'x'.repeat(17*1024)})]) {
        const response=await (endpoint==='auth/email'?email.PUT:password.POST)(new Request(origin+'/api/v1/'+endpoint,{method,headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json'},body:raw})); assert.equal(response.status,400); assert.deepEqual(row(f.user.id),before);
      }
    }
  });
  await test('per-account limits survive source-IP changes and audit records never contain credentials',async()=>{
    const f=fixture(), limiter=load('lib/rateLimit.ts'), original=limiter.clientIp;
    let ip=0; limiter.clientIp=()=>`192.0.2.${++ip}`;
    try { for(let i=0;i<20;i++) assert.equal((await change(f,{currentPassword:'wrong'})).status,403); assert.equal((await change(f,{currentPassword:'wrong'})).status,429); }
    finally { limiter.clientIp=original; }
    const details=JSON.stringify(db.prepare('SELECT event,detail FROM security_audit').all());
    for(const value of [oldPassword,newPassword,f.backup,f.secret,'currentPassword','access_token','refresh_token']) assert(!details.includes(value),value);
  });
  console.log(`PASS ${count} owner account security suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
