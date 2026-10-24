// Password login and explicit scope upgrades use a disposable shared users/grant database.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-native-login-'));process.chdir(temp);
process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://login.example.test:18520';global.fetch=async()=>{throw Error('Network disabled');};
const load=file=>require(path.join(root,file)),auth=load('lib/auth.ts'),native=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),factors=load('lib/totp.ts');
const origin=process.env.FIRE_APP_ORIGIN,password='Native-test-Password-123',routes={login:load('app/api/v2/auth/login/route.ts'),factor:load('app/api/v2/auth/login/totp/route.ts'),permissions:load('app/api/v2/auth/permissions/route.ts')};
let serial=0,count=0;
const row=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id);
function fixture(two=false,legacy=false){
 const user=auth.createUser('native_'+(++serial),password),secret=factors.generateTotpSecret(),backup=factors.generateBackupCodes(1)[0];
 auth.updateProfile(user.id,{email:`native${serial}@example.test`});
 auth.updateUserAvatar(user.id,'/uploads/avatar/test.svg');
 if(two)db.prepare('UPDATE users SET totp_enabled=1,totp_secret=?,totp_backup_codes=? WHERE id=?').run(legacy?secret:load('lib/secretStorage.ts').encryptSecret(secret),JSON.stringify([factors.hashBackupCode(backup)]),user.id);
 const old=db.transaction(()=>native.createNativeAppGrant(user.id,native.APP_SCOPE,'旧 iPhone')).immediate();
 return {user,secret,backup,old};
}
function req(path,body,token,headers={}){return new Request(origin+'/api/v2/auth/'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify(body)});}
const loginBody=f=>({client_id:'fire-ios',username:f.user.username,password,device_name:'测试 iPhone'});
const valid=token=>native.authenticateAppAccess(token,new Request(origin+'/api/v2/auth/me'));
const call=async(route,path,body,token,headers)=>{const res=await routes[route].POST(req(path,body,token,headers));return {status:res.status,headers:res.headers,...await res.json()};};
const login=(f,changes={},headers={})=>call('login','login',{...loginBody(f),...changes},undefined,headers);
const factor=(challenge,code,token)=>call('factor','login/totp',{client_id:'fire-ios',challenge_token:challenge,code},token);
const permissions=(f,scope,currentPassword=undefined)=>call('permissions','permissions',{client_id:'fire-ios',scope,currentPassword},f.old.access_token);
const pending=token=>db.prepare('SELECT * FROM app_login_challenges WHERE token_hash=?').get(native.appTokenHash(token));
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();console.log('PASS '+name);count++;}

routes.consent=load('app/api/v2/auth/consent/route.ts');
const read=async token=>{const res=await routes.consent.GET(new Request(origin+'/api/v2/auth/consent',{headers:token?{authorization:'Bearer '+token}:{}}));return {status:res.status,headers:res.headers,...await res.json()};};
const restore=(token,revision,extra={})=>call('consent','consent',{client_id:'fire-ios',revision,...extra},token);
const sameScopes=(a,b)=>assert.deepEqual(a.split(' ').sort(),b.split(' ').sort());
(async()=>{
 await test('new-device login restores phone-approved reads and writes with an independent grant',async()=>{
  const f=fixture(),phone=(await permissions(f,native.APP_SUPPORTED_SCOPES.join(' '))).data;
  const simulator=(await login(f)).data;sameScopes(simulator.scope,native.APP_SCOPE);
  const descriptor=await read(simulator.access_token);assert.equal(descriptor.status,200);sameScopes(descriptor.data.scope,phone.scope);
  const result=await restore(simulator.access_token,descriptor.data.revision);assert.equal(result.status,200);
  sameScopes(result.data.scope,phone.scope);assert.equal(result.data.replaces_grant_id,simulator.grant_id);assert.notEqual(result.data.grant_id,phone.grant_id);
  assert(valid(phone.access_token));assert(valid(simulator.access_token));assert(valid(result.data.access_token));
  native.revokeAppToken(simulator.refresh_token);assert(valid(phone.access_token));assert(valid(result.data.access_token));
  const unchanged=await restore(result.data.access_token,(await read(result.data.access_token)).data.revision);assert.equal(unchanged.data.status,'unchanged');
 });
 await test('account consent persists after all ordinary device logouts and server-module restart',async()=>{
  const f=fixture(),phone=(await permissions(f,'security.read security.write feed.read feed.write')).data;
  native.revokeAppToken(phone.refresh_token);native.revokeAppToken(f.old.refresh_token);
  const simulator=(await login(f)).data;delete require.cache[require.resolve(path.join(root,'lib/appNativeLogin.ts'))];
  sameScopes((await read(simulator.access_token)).data.scope,phone.scope);
  assert.equal((await restore(simulator.access_token,(await read(simulator.access_token)).data.revision)).status,200);
 });
 await test('legacy migration selects latest live expanded approval, not base logins or a union',async()=>{
  const f=fixture();const older=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE+' feed.read','old')).immediate();
  const phone=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE+' security.read','phone')).immediate();
  const revoked=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE+' profile.write','revoked')).immediate();native.revokeAppToken(revoked.refresh_token);
  const expired=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE+' resources.read','expired')).immediate();db.prepare('UPDATE app_grants SET expires_at=0 WHERE id=?').run(expired.grant_id);
  db.prepare('DELETE FROM app_account_consents WHERE user_id=?').run(f.user.id);
  const simulator=(await login(f)).data;sameScopes((await read(simulator.access_token)).data.scope,phone.scope);
  assert(!((await read(simulator.access_token)).data.scope.includes('feed.read')));assert(valid(older.access_token));
 });
 await test('same username on another identity, wrong revision, arbitrary scopes and Cookie cannot borrow approval',async()=>{
  const f=fixture(),other=fixture();await permissions(f,'security.read security.write');
  sameScopes((await read(other.old.access_token)).data.scope,native.APP_SCOPE);
  const descriptor=(await read(f.old.access_token)).data;
  assert.equal((await restore(other.old.access_token,descriptor.revision)).status,409);
  assert.equal((await restore(f.old.access_token,descriptor.revision,{scope:native.APP_SUPPORTED_SCOPES.join(' ')})).status,400);
  assert.equal((await read()).status,401);
  const cookie=await routes.consent.GET(new Request(origin+'/api/v2/auth/consent',{headers:{cookie:'fire_session='+auth.createSession(f.user.id)}}));assert.equal(cookie.status,401);
  const wrong=await routes.consent.GET(new Request(origin+'/api/v2/auth/consent',{headers:{authorization:'Bearer '+f.old.access_token,origin:'https://evil.test'}}));assert.equal(wrong.status,403);
 });
 await test('foreign client cannot seed or restore account approval, and legacy factor representation stays valid',async()=>{
  const f=fixture();const foreign=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE+' resources.read','foreign')).immediate();
  db.prepare("UPDATE app_grants SET client_id='other-client' WHERE id=?").run(foreign.grant_id);
  db.prepare('DELETE FROM app_account_consents WHERE user_id=?').run(f.user.id);
  sameScopes((await read(f.old.access_token)).data.scope,native.APP_SCOPE);assert.equal((await read(foreign.access_token)).status,401);
  const legacy=fixture(true,true);await permissions(legacy,'feed.read feed.write');
  const challenge=(await login(legacy)).data.challenge_token;const verified=(await factor(challenge,legacy.backup)).data;
  sameScopes((await read(verified.access_token)).data.scope,native.APP_SCOPE+' feed.read feed.write');
 });
 await test('approval changed between read and restore fails once without tokens or stale escalation',async()=>{
  const f=fixture();await permissions(f,'feed.read');const descriptor=(await read(f.old.access_token)).data;
  db.transaction(()=>native.rememberAppConsent(f.user.id,native.APP_SCOPE)).immediate();
  const before=db.prepare('SELECT COUNT(*) n FROM app_grants').get().n;
  assert.equal((await restore(f.old.access_token,descriptor.revision)).status,409);assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,before);assert(valid(f.old.access_token));
  sameScopes((await read(f.old.access_token)).data.scope,native.APP_SCOPE);
 });
 await test('account-wide revocation and password changes cannot revive approval from old grants',async()=>{
  const f=fixture();await permissions(f,'security.read security.write');native.revokeUserAppGrants(f.user.id);
  assert.equal((await read(f.old.access_token)).status,401);
  const next=(await login(f)).data;sameScopes((await read(next.access_token)).data.scope,native.APP_SCOPE);
  await call('permissions','permissions',{client_id:'fire-ios',scope:'feed.read feed.write'},next.access_token);
  auth.updatePassword(f.user.id,'New-owner-password-123');assert.equal((await read(next.access_token)).status,401);
  const fresh=(await login(f,{password:'New-owner-password-123'})).data;sameScopes((await read(fresh.access_token)).data.scope,native.APP_SCOPE);
 });
 await test('consent and explicit permission issue roll back together on storage failure',async()=>{
  const f=fixture(),before=(await read(f.old.access_token)).data;
  db.exec("CREATE TEMP TRIGGER consent_fail BEFORE UPDATE ON app_account_consents BEGIN SELECT RAISE(ABORT,'private detail'); END");
  const count=db.prepare('SELECT COUNT(*) n FROM app_grants').get().n;
  try {const result=await permissions(f,'profile.write');assert.equal(result.status,500);assert(!JSON.stringify(result).includes('private detail'));}finally{db.exec('DROP TRIGGER consent_fail');}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,count);assert.equal((await read(f.old.access_token)).data.revision,before.revision);assert(valid(f.old.access_token));
 });
 await test('restore failure and revoked or expired connection preserve other devices',async()=>{
  const f=fixture(),phone=(await permissions(f,'feed.read')).data,sim=(await login(f)).data,descriptor=(await read(sim.access_token)).data;
  db.exec("CREATE TEMP TRIGGER restore_fail BEFORE INSERT ON app_grants BEGIN SELECT RAISE(ABORT,'private restore'); END");
  try {assert.equal((await restore(sim.access_token,descriptor.revision)).status,500);}finally{db.exec('DROP TRIGGER restore_fail');}
  assert(valid(phone.access_token));assert(valid(sim.access_token));native.revokeAppToken(sim.refresh_token);
  assert.equal((await restore(sim.access_token,descriptor.revision)).status,401);assert(valid(phone.access_token));
 });
 console.log(`${count} account-client cross-device consent suites passed (isolated database)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{db.close();}catch{}fs.rmSync(temp,{recursive:true,force:true});});
