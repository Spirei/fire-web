// Owner account actions use a disposable database; no real profiles or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const deliveries=[];
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-account-security-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://account.test.example:18520';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const next=load('node_modules/next/server.js'); next.after=fn=>{deliveries.push(fn);};
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
const api=load('lib/appSecurity.ts'), recovery=load('lib/appPasswordRecovery.ts'), emailVerify=load('lib/emailVerification.ts'), mail=load('lib/mail.ts'), mailBudget=load('lib/mailBudget.ts');
mail.mailConfigured=()=>true; mailBudget.reserveMailAttempt=()=>({});
const full='portfolio.read security.read security.write';
const secure=f=>{f.grant=connect(f.user,f.browser,full);return f;};
const call=(f,path,body,method='POST')=>req('auth/'+path,body,f?.grant.access_token,method);
const json=async response=>{const r=await response;const b=await r.json();return {...b,status:r.status};};
const run=(operation)=>json(api.securityResponse(operation));
(async()=>{
 await test('new security consent scopes remain explicit and cannot upgrade old grants',async()=>{
  const f=fixture(), g=secure(f), readonly=connect(g.user,g.browser,'portfolio.read security.read');
  assert.throws(()=>native.parseAppAuthorization({...g.grant.values,scope:'portfolio.read security.write'}));
  const configData=(await (await config.GET(new Request(origin+'/api/v1/auth/config'))).json()).data;
  assert(configData.scopes_supported.includes('security.write'));assert.equal(configData.scope,native.APP_SCOPE);assert.equal(configData.security.passkey_registration.supported,false);
  const profile=(await (await me.GET(req('auth/me',undefined,g.grant.access_token,'GET'))).json()).data;
  assert.equal(profile.capabilities.twoFactorWrite,true);assert.equal(profile.capabilities.passkeyRegistration,false);
  const denied=await run(()=>api.removeDevice(req('auth/security-devices',{id:'bad',currentPassword:oldPassword},readonly.access_token,'DELETE')));assert.equal(denied.code,40301);assert(identity(readonly.access_token));
  assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID,readonly.refresh_token).scope,'portfolio.read security.read');
  for(const headers of [{cookie:'fire_session='+g.browser},{authorization:'Bearer '+g.browser},{authorization:'Basic bad',cookie:'fire_session='+g.browser}]) {
   const r=await run(()=>api.readDevices(new Request(origin+'/api/v1/auth/security-devices',{headers})));assert.equal(r.status,401);
  }
  assert.equal(native.appIdentity(g.grant.access_token,new Request(origin+'/api/auth/passkeys',{headers:{authorization:'Bearer '+g.grant.access_token}})),null);
 });
 await test('device data is real, owner-only, safe, current-aware and credential-protected',async()=>{
  const f=secure(fixture()), listing=api.readDevices(call(f,'security-devices',undefined,'GET'));
  assert(listing.devices.some(d=>d.kind==='app'&&d.current&&d.id===f.grant.grant_id)); assert.equal(listing.devices.filter(d=>d.kind==='web').length,2);
  for(const device of listing.devices) assert(device.kind==='app'||(!device.current&&device.lastUsedAt===null));
  const encoded=JSON.stringify(listing); for(const token of [f.browser,native.appTokenHash(f.browser),f.otherGrant.grant_id])assert(!encoded.includes(token));
  const web=listing.devices.find(d=>d.kind==='web');
  assert.equal((await run(()=>api.removeDevice(call(f,'security-devices',{id:web.id,currentPassword:'wrong'},'DELETE')))).code,40103);assert(identity(f.grant.access_token));
  assert.equal((await run(()=>api.removeDevice(call(f,'security-devices',{id:f.otherGrant.grant_id,currentPassword:oldPassword},'DELETE')))).status,404);assert(identity(f.otherGrant.access_token));
  assert.equal((await run(()=>api.removeDevice(call(f,'security-devices',{id:web.id,currentPassword:oldPassword},'DELETE')))).data.reauthenticationRequired,false);
  assert.equal(api.readDevices(call(f,'security-devices',undefined,'GET')).devices.filter(d=>d.kind==='web').length,1);
  assert.equal((await run(()=>api.removeDevice(call(f,'security-devices',{id:f.grant.grant_id,currentPassword:oldPassword},'DELETE')))).data.reauthenticationRequired,true);assert.equal(identity(f.grant.access_token),null);
 });
 await test('TOTP setup is temporary, grant-bound, expiry-aware and activates with one-time backup disclosure',async()=>{
  const f=secure(fixture()), second=connect(f.user,f.browser,full);
  const setup=await api.mutateTotp(call(f,'totp/setup',{currentPassword:oldPassword}),'setup'); assert.equal(row(f.user.id).totp_enabled,0);assert(setup.qrPng.startsWith('data:image/png'));assert(setup.expiresAt>Date.now());
  const payload={challengeId:setup.challengeId,currentPassword:oldPassword,code:factors.totpCodeAt(setup.secret)};
  assert.equal((await run(()=>api.mutateTotp(req('auth/totp/confirm',payload,second.access_token),'confirm'))).code,40902);
  assert.equal((await run(()=>api.mutateTotp(call(f,'totp/confirm',{...payload,code:'bad'}),'confirm'))).code,40104);assert(identity(f.grant.access_token));
  assert.equal((await run(()=>api.mutateTotp(call(f,'totp/confirm',{...payload,name:'\u0000'}),'confirm'))).status,400);
  db.exec("CREATE TEMP TRIGGER native_fail_totp BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'private error'); END");
  try { assert.equal((await run(()=>api.mutateTotp(call(f,'totp/confirm',payload),'confirm'))).status,500); } finally {db.exec('DROP TRIGGER native_fail_totp');}
  assert.equal(row(f.user.id).totp_enabled,0);assert(identity(f.grant.access_token));
  const enabled=await api.mutateTotp(call(f,'totp/confirm',payload),'confirm');assert.equal(enabled.reauthenticationRequired,true);assert(enabled.backupCodes.length>0);assert.equal(row(f.user.id).totp_enabled,1);
  assert.equal(identity(f.grant.access_token),null);assert.equal(auth.getUserByToken(f.browser),null);assert.equal(identity(second.access_token),null);assert(identity(f.otherGrant.access_token));
  const freshBrowser=auth.createSession(f.user.id);f.grant=connect(f.user,freshBrowser,full);
  const state=api.readTotp(call(f,'totp',undefined,'GET'));assert.equal(state.backupCodesRemaining,enabled.backupCodes.length);assert(!JSON.stringify(state).includes(setup.secret));assert(!JSON.stringify(state).includes(enabled.backupCodes[0]));
 });
 await test('backup code replacement and disable require factors and roll back failures atomically',async()=>{
  const f=secure(fixture(true)), before=row(f.user.id);
  assert.equal((await run(()=>api.mutateTotp(call(f,'totp/backup-codes',{currentPassword:oldPassword,code:'bad'}),'backup-codes'))).code,40104);
  db.exec("CREATE TEMP TRIGGER native_fail_backup BEFORE UPDATE OF totp_backup_codes ON users BEGIN SELECT RAISE(ABORT,'private error'); END");
  try {assert.equal((await run(()=>api.mutateTotp(call(f,'totp/backup-codes',{currentPassword:oldPassword,code:f.backup}),'backup-codes'))).status,500);}finally{db.exec('DROP TRIGGER native_fail_backup');}
  assert.deepEqual(row(f.user.id),before);
  const codes=await api.mutateTotp(call(f,'totp/backup-codes',{currentPassword:oldPassword,code:f.backup}),'backup-codes');assert(identity(f.grant.access_token));
  assert.equal((await run(()=>api.mutateTotp(call(f,'totp/disable',{currentPassword:oldPassword,code:f.backup}),'disable'))).code,40104);
  db.exec("CREATE TEMP TRIGGER native_fail_disable BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'private error'); END");
  const disabling={currentPassword:oldPassword,code:codes.backupCodes[0]},snapshot=row(f.user.id);
  try{assert.equal((await run(()=>api.mutateTotp(call(f,'totp/disable',disabling),'disable'))).status,500);}finally{db.exec('DROP TRIGGER native_fail_disable');}
  assert.deepEqual(row(f.user.id),snapshot);assert(identity(f.grant.access_token));
  assert.equal((await api.mutateTotp(call(f,'totp/disable',disabling),'disable')).reauthenticationRequired,true);assert.equal(row(f.user.id).totp_enabled,0);assert.equal(identity(f.grant.access_token),null);
 });
 await test('passkey list/delete preserve owner separation and revoke credential-derived grants',async()=>{
  const f=secure(fixture()), id='credential-test-key';
  db.prepare('INSERT INTO passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,f.user.id,'handle','account.test.example',Buffer.from('test'),0,'[]','iPhone',1,Date.now());
  db.prepare('UPDATE app_grants SET passkey_id=? WHERE id=?').run(id,f.grant.grant_id);
  const other=secure(fixture());assert.equal(api.readPasskeys(call(other,'passkeys',undefined,'GET')).keys.length,0);
  const list=api.readPasskeys(call(f,'passkeys',undefined,'GET'));assert.equal(list.keys[0].id,id);assert.equal(list.registration.supported,false);assert(!JSON.stringify(list).includes('public_key'));
  assert.equal((await run(()=>api.removePasskey(call(other,'passkeys',{id,currentPassword:oldPassword},'DELETE')))).status,404);
  const result=await api.removePasskey(call(f,'passkeys',{id,currentPassword:oldPassword},'DELETE'));assert.equal(result.reauthenticationRequired,true);assert.equal(identity(f.grant.access_token),null);assert(identity(f.otherGrant.access_token));
  const unsupported=load('app/api/v1/auth/passkeys/register-options/route.ts'); assert.equal((await unsupported.POST(call(other,'passkeys/register-options',{}))).status,503);
 });
 await test('email confirmation binds owner, is one-time, and SMTP receipt never verifies ownership',async()=>{
  const f=secure(fixture()), other=secure(fixture());
  const settings=load('lib/settings.ts');settings.updateSiteSettings({emailLinkOrigin:origin});
  let captured;mail.sendEmailVerification=async(email,url,permit,token)=>{captured={email,url,token};};
  const sent=await api.requestEmailVerification(call(f,'email-verification/request',{}));assert.equal(sent.verified,false);assert.equal(emailVerify.emailVerified(f.user.id,row(f.user.id).email),false);assert(captured.url.includes('/verify-email?token='));assert.equal(captured.token.length,43);
  assert.equal((await run(()=>api.verifyEmail(call(other,'email-verification/confirm',{token:captured.token})))).code,40003);
  const confirmed=await api.verifyEmail(call(f,'email-verification/confirm',{token:captured.token}));assert.equal(confirmed.user.emailVerified,true);assert.equal(confirmed.user.id,f.user.id);assert(!JSON.stringify(confirmed).includes('password_hash'));
  assert.equal((await run(()=>api.verifyEmail(call(f,'email-verification/confirm',{token:captured.token})))).code,40003);
  const g=secure(fixture());let failedToken;mail.sendEmailVerification=async(email,url,permit,token)=>{failedToken=token;throw new Error('private SMTP');};
  assert.equal((await run(()=>api.requestEmailVerification(call(g,'email-verification/request',{})))).status,502);assert.equal(emailVerify.confirmEmailVerification(failedToken),false);
 });
 await test('public recovery responses hide account existence and use verified email, expiring single-use factors',async()=>{
  const f=fixture();db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,row(f.user.id).email,Date.now());
  let delivered;mail.sendPasswordResetEmail=async(data)=>{delivered=data;};
  const known=await recovery.passwordRecovery(call(null,'password-reset/request',{login:f.user.username}),'request');
  const unknown=await recovery.passwordRecovery(call(null,'password-reset/request',{login:'nonexistent-user'}),'request');
  const unverified=await recovery.passwordRecovery(call(null,'password-reset/request',{login:f.other.username}),'request');
  for(const item of [known,unknown,unverified]){assert.equal(item.ok,true);assert.equal(item.challenge.length,43);assert.equal(item.message,known.message);assert.equal(item.retryAfter,60);}
  assert.equal(delivered,undefined);for(const job of deliveries.splice(0))await job();assert.equal(delivered.to,row(f.user.id).email);
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/verify',{challenge:unknown.challenge,code:delivered.code}),'verify'))).code,40003);
  const verified=await recovery.passwordRecovery(call(null,'password-reset/verify',{challenge:known.challenge,code:delivered.code}),'verify');assert.equal(verified.token.length,43);assert(verified.expiresAt>Date.now());
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/verify',{challenge:known.challenge,code:delivered.code}),'verify'))).code,40003);
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/confirm',{token:verified.token,newPassword:'weak'}),'confirm'))).status,400);
  db.exec("CREATE TEMP TRIGGER native_fail_reset BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'private error'); END");
  try{assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/confirm',{token:verified.token,newPassword}),'confirm'))).status,500);}finally{db.exec('DROP TRIGGER native_fail_reset');}
  assert(identity(f.grant.access_token));assert(auth.authenticateUser(f.user.username,oldPassword));
  assert.equal((await recovery.passwordRecovery(call(null,'password-reset/confirm',{token:verified.token,newPassword}),'confirm')).reauthenticationRequired,true);
  assert.equal(identity(f.grant.access_token),null);assert.equal(auth.getUserByToken(f.browser),null);assert(auth.authenticateUser(f.user.username,newPassword));assert(identity(f.otherGrant.access_token));
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/confirm',{token:verified.token,newPassword}),'confirm'))).code,40003);
 });
 await test('body-read revocation, expired challenges and malformed inputs cannot write security data',async()=>{
  for(const path of ['security-devices','passkeys','totp/setup','email-verification/confirm']){
   const f=secure(fixture()), before=row(f.user.id), read=bodies.readJsonBody;
   bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(f.grant.grant_id);return body;};
   try{const r=await run(()=>path==='security-devices'?api.removeDevice(call(f,path,{id:f.grant.grant_id,currentPassword:oldPassword},'DELETE')):path==='passkeys'?api.removePasskey(call(f,path,{id:'none',currentPassword:oldPassword},'DELETE')):path==='totp/setup'?api.mutateTotp(call(f,path,{currentPassword:oldPassword}),'setup'):api.verifyEmail(call(f,path,{token:'bad'})));assert.equal(r.status,401);}finally{bodies.readJsonBody=read;}
   assert.deepEqual(row(f.user.id),before);
  }
  const f=secure(fixture()), setup=await api.mutateTotp(call(f,'totp/setup',{currentPassword:oldPassword}),'setup');db.prepare('UPDATE app_security_challenges SET expires_at=0 WHERE id=?').run(setup.challengeId);
  assert.equal((await run(()=>api.mutateTotp(call(f,'totp/confirm',{challengeId:setup.challengeId,currentPassword:oldPassword,code:factors.totpCodeAt(setup.secret)}),'confirm'))).code,40902);
  for(const body of [[],{userId:f.other.id},{currentPassword:'x'.repeat(17*1024)}])assert.equal((await run(()=>api.mutateTotp(call(f,'totp/setup',body),'setup'))).status,400);
  const audit=JSON.stringify(db.prepare('SELECT event,detail FROM security_audit').all());for(const secret of [oldPassword,newPassword,setup.secret,f.backup,f.grant.access_token])assert(!audit.includes(secret));
 });
 await test('QR generation cannot commit after revocation and Web replacement invalidates native setup',async()=>{
  const f=secure(fixture()), totp=load('lib/totp.ts'), qr=totp.totpQrPng;
  totp.totpQrPng=async(...args)=>{native.revokeAppGrant(f.grant.grant_id);return qr(...args);};
  try{assert.equal((await run(()=>api.mutateTotp(call(f,'totp/setup',{currentPassword:oldPassword}),'setup'))).status,401);}finally{totp.totpQrPng=qr;}
  assert.equal(db.prepare('SELECT 1 FROM totp_setup WHERE user_id=?').get(f.user.id),undefined);
  const g=secure(fixture()), setup=await api.mutateTotp(call(g,'totp/setup',{currentPassword:oldPassword}),'setup');
  await load('lib/totpAuth.ts').beginTotpSetup(g.user.id,g.user.username);
  assert.equal((await run(()=>api.mutateTotp(call(g,'totp/confirm',{challengeId:setup.challengeId,currentPassword:oldPassword,code:factors.totpCodeAt(setup.secret)}),'confirm'))).code,40902);assert.equal(row(g.user.id).totp_enabled,0);
 });
 await test('recovery rejects expired and exhausted challenges and stays neutral for mail budget denial',async()=>{
  const f=fixture();db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,row(f.user.id).email,Date.now());
  const issued=reset.issuePasswordResetCode(f.user.id);
  for(let i=0;i<5;i++)assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/verify',{challenge:issued.challenge,code:'bad'}),'verify'))).code,40003);
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/verify',{challenge:issued.challenge,code:issued.code}),'verify'))).code,40003);
  const token=reset.issuePasswordResetToken(f.user.id).token;db.prepare('UPDATE password_reset_tokens SET expires_at=0 WHERE user_id=?').run(f.user.id);
  assert.equal((await run(()=>recovery.passwordRecovery(call(null,'password-reset/confirm',{token,newPassword}),'confirm'))).code,40003);assert(auth.authenticateUser(f.user.username,oldPassword));
  const g=fixture();db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(g.user.id,row(g.user.id).email,Date.now());
  const reserve=mailBudget.reserveMailAttempt;mailBudget.reserveMailAttempt=()=>{throw new Error('private mail budget');};
  try{const denied=await recovery.passwordRecovery(call(null,'password-reset/request',{login:g.user.username}),'request'),unknown=await recovery.passwordRecovery(call(null,'password-reset/request',{login:'missing'}),'request');assert.equal(denied.message,unknown.message);assert.equal(denied.challenge.length,unknown.challenge.length);}finally{mailBudget.reserveMailAttempt=reserve;}
 });
 await test('v1 email credential errors are distinct from session errors and do not revoke grants',async()=>{
  const f=fixture(true);
  assert.equal((await json(email.PUT(req('auth/email',{email:'changed@example.test',currentPassword:'bad',code:f.backup},f.grant.access_token)))).code,40103);
  assert.equal((await json(email.PUT(req('auth/email',{email:'changed@example.test',currentPassword:oldPassword,code:'bad'},f.grant.access_token)))).code,40104);assert(identity(f.grant.access_token));
 });
 await test('legacy factor migration reports the actual connection invalidation',async()=>{
  const f=fixture(true);db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(f.secret,f.user.id);secure(f);
  const result=await api.mutateTotp(call(f,'totp/backup-codes',{currentPassword:oldPassword,code:f.backup}),'backup-codes');
  assert.equal(result.reauthenticationRequired,true);assert.equal(identity(f.grant.access_token),null);assert(row(f.user.id).totp_secret.startsWith('enc:v1:'));
 });
 console.log(`PASS ${count} native security suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
