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
mail.mailConfigured=()=>true;
const mailSent=[]; mail.sendAccountEmailChangeCode=async (email,code)=>{mailSent.push({email,code});};
const full='portfolio.read security.read security.write';
const secure=f=>{f.grant=connect(f.user,f.browser,full);return f;};
const call=(f,path,body,method='POST')=>req('auth/'+path,body,f?.grant.access_token,method);
const json=async response=>{const r=await response;const b=await r.json();return {...b,status:r.status};};
const run=(operation)=>json(api.securityResponse(operation));

const step=async(f,purpose,action,body={},version=1,token)=>json(load(`app/api/v${version}/auth/${purpose}-change/${action}/route.ts`).POST(new Request(origin+`/api/v${version}/auth/${purpose}-change/${action}`,{method:'POST',headers:{'content-type':'application/json',...(token===null?{cookie:'fire_session='+f.browser}:{authorization:'Bearer '+(token||f.grant.access_token)})},body:JSON.stringify(body)})));
const proof=async(f,purpose='password',version=1)=>{
 if(purpose==='password'){const r=await step(f,purpose,'verify',{currentPassword:oldPassword},version);assert.equal(r.status,200,JSON.stringify(r));return r.data.proof;}
 const r=await step(f,'email','request',{},version);assert.equal(r.status,200,JSON.stringify(r)); const delivered=mailSent.at(-1);assert.equal(delivered.email,row(f.user.id).email);
 const v=await step(f,'email','verify',{challenge:r.data.challenge,code:delivered.code},version);assert.equal(v.status,200,JSON.stringify(v));return v.data.proof;
};
(async()=>{
 await test('both versions discover fixed paths and enforce native security.write',async()=>{
  for(const version of [1,2]){
   const data=(await (await load(`app/api/v${version}/auth/config/route.ts`).GET(new Request(origin+`/api/v${version}/auth/config`))).json()).data.security.account_change;
   assert.equal(data.version,1);assert.equal(data.password.requires_totp,false);assert.equal(data.email.requires_password,false);assert.equal(data.email.confirm_path,`/api/v${version}/auth/email-change/confirm`);
   const f=fixture();assert.equal((await step(f,'password','verify',{currentPassword:oldPassword},version)).status,403);
   assert.equal((await step(f,'password','verify',{currentPassword:oldPassword},version,null)).status,401);
   assert.equal((await step(secure(f),'password','verify',{currentPassword:oldPassword,userId:f.user.id},version)).status,400);
  }
 });
 await test('password proof uses original password only, binds grant and purpose, then revokes every session',async()=>{
  for(const version of [1,2]){
   const f=secure(fixture(true)), backupBefore=row(f.user.id).totp_backup_codes;
   assert.equal((await step(f,'password','verify',{currentPassword:'wrong'},version)).code,40103);
   const p=await proof(f,'password',version), second=connect(f.user,f.browser,full);
   assert.equal((await step(f,'password','confirm',{proof:p,newPassword},version,second.access_token)).code,40003);
   assert.equal((await step(f,'email','confirm',{proof:p,email:'new@example.test'},version)).code,40003);
   assert.equal((await step(f,'password','confirm',{proof:p,newPassword:'short'},version)).status,400);
   assert.equal((await step(f,'password','confirm',{proof:p,newPassword},version)).data.reauthenticationRequired,true);
   assert(passwords.verifyPassword(newPassword,row(f.user.id).password_hash));assert.equal(row(f.user.id).totp_backup_codes,backupBefore);
   assert(!identity(f.grant.access_token));assert(!identity(second.access_token));assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(f.user.id).n,0);
   assert.equal(db.prepare('SELECT COUNT(*) n FROM app_account_changes WHERE user_id=?').get(f.user.id).n,0);
  }
 });
 await test('email code is single-use, attempts persist and resend cooldown survives consumption',async()=>{
  const f=secure(fixture(true));const r=await step(f,'email','request');assert.equal(r.status,200); assert(Math.abs(r.data.expiresAt-Date.now()-30*60_000)<2000);const c=r.data.challenge, code=mailSent.at(-1).code;
  const second=connect(f.user,f.browser,full);
  assert.equal((await step(f,'email','verify',{challenge:c,code},1,second.access_token)).code,40003);
  assert.equal((await step(f,'email','request')).status,429);
  for(let i=0;i<5;i++)assert.equal((await step(f,'email','verify',{challenge:c,code:'not-six'})).code,40003);
  assert.equal(db.prepare('SELECT attempts FROM app_account_changes WHERE token_hash=?').get(native.appTokenHash(c)).attempts,5);
  assert.equal((await step(f,'email','verify',{challenge:c,code})).code,40003);
  db.prepare('UPDATE app_account_changes SET attempts=0 WHERE token_hash=?').run(native.appTokenHash(c));
  const v=await step(f,'email','verify',{challenge:c,code});assert.equal(v.status,200);
  assert.equal((await step(f,'email','verify',{challenge:c,code})).code,40003);
  assert.equal((await step(f,'email','request')).status,429);
  const p=v.data.proof;assert.equal((await step(f,'email','confirm',{proof:p,email:row(f.other.id).email})).status,409);
  assert.equal((await step(f,'email','confirm',{proof:p,email:''})).status,400);
  const backups=row(f.user.id).totp_backup_codes;
  db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,row(f.user.id).email,Date.now());
  assert.equal((await step(f,'email','confirm',{proof:p,email:'Next@Example.Test'})).status,200);
  assert.equal(row(f.user.id).email,'next@example.test');assert.equal(row(f.user.id).totp_backup_codes,backups);assert(!emailVerify.emailVerified(f.user.id,'next@example.test'));assert(!identity(f.grant.access_token));
 });
 await test('expiry, fresh proof replacement, revoked grants and email ABA all fail closed',async()=>{
  const f=secure(fixture());const first=await proof(f), latest=await proof(f);
  assert.equal((await step(f,'password','confirm',{proof:first,newPassword})).code,40003);
  db.prepare('UPDATE app_account_changes SET expires_at=? WHERE token_hash=?').run(Date.now()-1,native.appTokenHash(latest));
  assert.equal((await step(f,'password','confirm',{proof:latest,newPassword})).code,40003);
  const p=await proof(f), oldEmail=row(f.user.id).email;auth.updateProfile(f.user.id,{email:'temporary@example.test'});auth.updateProfile(f.user.id,{email:oldEmail});
  assert.equal((await step(f,'password','confirm',{proof:p,newPassword})).code,40003);
  const revoked=await proof(f);native.revokeAppGrant(f.grant.grant_id);
  assert.equal((await step(f,'password','confirm',{proof:revoked,newPassword})).status,401);
 });
 await test('SMTP failure retains persistent cooldown and clears challenge',async()=>{
  const f=secure(fixture()); const original=mail.sendAccountEmailChangeCode;
  mail.sendAccountEmailChangeCode=async()=>{throw Error('SMTP failure');};
  assert.equal((await step(f,'email','request')).status,502);
  mail.sendAccountEmailChangeCode=original;
  assert.equal((await step(f,'email','request')).status,429);
  assert.equal(db.prepare("SELECT expires_at,code_hash FROM app_account_changes WHERE user_id=?").get(f.user.id).expires_at,0);
 });
 await test('resend invalidates earlier proof, and account mutation during body reads cannot proceed',async()=>{
  const f=secure(fixture()), p=await proof(f,'email');
  db.prepare('UPDATE app_account_changes SET created_at=? WHERE user_id=?').run(Date.now()-61_000,f.user.id);db.prepare('DELETE FROM mail_send_attempts').run();
  assert.equal((await step(f,'email','request')).status,200);assert.equal((await step(f,'email','confirm',{proof:p,email:'new@example.test'})).code,40003);
  const original=bodies.readJsonBody;bodies.readJsonBody=async(request,...args)=>{const b=await original(request,...args);native.revokeAppGrant(f.grant.grant_id);return b;};
  try{assert.equal((await step(f,'password','verify',{currentPassword:oldPassword})).status,401);}finally{bodies.readJsonBody=original;}
 });
 await test('v2 email and token refresh preserve grant binding; transport responses never cache proofs',async()=>{
  const f=secure(fixture()), p=await proof(f,'email',2), refreshed=native.refreshAppTokens(native.APP_CLIENT_ID,f.grant.refresh_token);
  const response=await load('app/api/v2/auth/email-change/confirm/route.ts').POST(new Request(origin+'/api/v2/auth/email-change/confirm',{method:'POST',headers:{authorization:'Bearer '+refreshed.access_token,'content-type':'application/json'},body:JSON.stringify({proof:p,email:'v2-new@example.test'})}));
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('X-Alcor-API-Version'),'2');assert.equal(row(f.user.id).email,'v2-new@example.test');assert(!identity(refreshed.access_token));
 });
 await test('SMTP-time grant revocation and mailbox changes cannot issue a usable proof',async()=>{
  const f=secure(fixture());const original=mail.sendAccountEmailChangeCode;
  mail.sendAccountEmailChangeCode=async()=>{native.revokeAppGrant(f.grant.grant_id);};
  try{assert.equal((await step(f,'email','request')).status,401);}finally{mail.sendAccountEmailChangeCode=original;}
  const codeState=db.prepare("SELECT token_hash FROM app_account_changes WHERE user_id=?").get(f.user.id);assert(codeState);
  const g=secure(fixture()), r=await step(g,'email','request'), code=mailSent.at(-1).code;
  db.prepare('UPDATE app_account_changes SET expires_at=? WHERE token_hash=?').run(Date.now()-1,native.appTokenHash(r.data.challenge));
  assert.equal((await step(g,'email','verify',{challenge:r.data.challenge,code})).code,40003);
 });
 console.log(`PASS ${count} account-change groups`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
