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
(async()=>{
 await test('both config versions explicitly discover fixed v2 native paths and base scope',async()=>{
  for(const v of [1,2]){
   const route=load(`app/api/v${v}/auth/config/route.ts`),body=await(await route.GET(new Request(origin+`/api/v${v}/auth/config`))).json(),c=body.data.native_login;
   assert(c.supported);assert.equal(c.api_version,2);assert.equal(c.version,2);assert.equal(c.permissions_authentication,"current_grant");assert.equal(c.permissions_requires_password,false);assert.equal(c.permissions_requires_2fa,false);assert.equal(c.client_id,'fire-ios');assert.equal(c.scope,native.APP_SCOPE);
   assert.equal(c.login_path,'/api/v2/auth/login');assert.equal(c.two_factor_path,'/api/v2/auth/login/totp');assert.equal(c.permissions_path,'/api/v2/auth/permissions');assert.equal(c.challenge_expires_in,300);
  }
 });
 await test('native login creates only App tokens, returns exact me identity, and never inherits administrator Cookies',async()=>{
  const f=fixture(),browser=auth.createSession(f.user.id),before=db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.user.id);
  const result=await login(f,{}, {cookie:'fire_session='+browser});assert.equal(result.status,200);assert.equal(result.data.apiVersion,2);assert.equal(result.data.status,'authenticated');
  const g=result.data;assert.match(g.access_token,/^fat_[\w-]{43}$/);assert.match(g.refresh_token,/^frt_[\w-]{43}$/);assert.equal(g.expires_in,900);assert.equal(g.token_type,'Bearer');assert.equal(g.scope,native.APP_SCOPE);
  assert.equal(g.user.id,f.user.id);assert.equal(g.user.role,'user');assert.equal(g.user.avatar,'/uploads/avatar/test.svg');assert.equal(g.user.capabilities.profileWrite,false);assert.equal(g.user.capabilities.twoFactorWrite,false);
  const me=await(await load('app/api/v2/auth/me/route.ts').GET(new Request(origin+'/api/v2/auth/me',{headers:{authorization:'Bearer '+g.access_token}}))).json();assert.deepEqual(me.data,g.user);
  assert.equal(result.headers.get('set-cookie'),null);assert(result.headers.get('cache-control').includes('no-store'));assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,before);assert.equal(g.token,undefined);assert(valid(f.old.access_token));
  assert.equal((await login(f,{username:`NATIVE${serial}@EXAMPLE.TEST`})).status,200);
 });
 await test('strict credentials, scopes, origins, and rate limits do not clear an existing grant',async()=>{
  const f=fixture();
  assert.throws(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE,'outside transaction'));
  for(const change of [{client_id:'other'},{username:[]},{scope:'profile.write'},{userId:f.user.id}])assert.equal((await login(f,change)).code,40002);
  for(const change of [{password:'wrong'},{username:'missing-user'},{password:'x'.repeat(129)}]){const r=await login(f,change);assert.equal(r.code,40103);assert.equal(r.status,403);}
  assert.equal((await login(f,{}, {origin:'https://evil.example'})).status,403);
  for (const text of ['null','{bad json}',JSON.stringify({client_id:'fire-ios',password:'文'.repeat(17000)})]) {
   const r=await routes.login.POST(new Request(origin+'/api/v2/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:text}));
   assert.equal(r.status,400);assert.equal((await r.json()).code,40002);
  }
  db.prepare('INSERT INTO rate_limit(key,count,reset_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at').run('login-account:'+load('lib/rateLimit.ts').loginIdentityKey(f.user.username),20,Date.now()+900_000);
  assert.equal((await login(f)).code,42901);assert(valid(f.old.access_token));assert.equal(valid(f.old.access_token).scope,native.APP_SCOPE);
 });
 await test('TOTP challenges disclose no user/token and succeed once without Web ticket interchange',async()=>{
  const f=fixture(true),before=db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,start=await login(f),c=start.data.challenge_token;
  assert.equal(start.data.status,'requires_2fa');assert.equal(start.data.purpose,'login');assert.equal(start.data.user,undefined);assert.equal(start.data.access_token,undefined);assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,before);
  assert(!JSON.stringify(pending(c)).includes(c));assert.equal(pending(c).scope,native.APP_SCOPE);
  const webTicket=load('lib/totpAuth.ts').createLoginTicket(f.user.id);assert.equal((await factor(webTicket,f.backup)).code,40105);
  assert.equal(load('lib/totpAuth.ts').completeLoginTicket(c,f.backup).ok,false);
  const finish=await factor(c,factors.totpCodeAt(f.secret));assert.equal(finish.status,200);assert.equal(finish.data.user.id,f.user.id);assert.equal(pending(c),undefined);
  assert.equal((await factor(c,f.backup)).code,40105);assert(valid(f.old.access_token));
  const second=(await login(f)).data.challenge_token;assert.equal((await factor(second,factors.totpCodeAt(f.secret))).code,40104);assert.equal((await factor(second,f.backup)).status,200);
 });
 await test('challenge expiry, security changes, attempt exhaustion and wrong origins are isolated',async()=>{
  const f=fixture(true),c=(await login(f)).data.challenge_token;
  const wrongOrigin=await call('factor','login/totp',{client_id:'fire-ios',challenge_token:c,code:f.backup},undefined,{origin:'https://evil.example'});assert.equal(wrongOrigin.code,40301);assert(pending(c));
  for(let i=0;i<8;i++)assert.equal((await factor(c,'bad')).code,i===7?42901:40104);
  assert.equal(pending(c),undefined);assert(valid(f.old.access_token));assert.equal(row(f.user.id).totp_backup_codes,JSON.stringify([factors.hashBackupCode(f.backup)]));
  const expired=(await login(f)).data.challenge_token;db.prepare('UPDATE app_login_challenges SET expires_at=? WHERE token_hash=?').run(Date.now()-1,native.appTokenHash(expired));assert.equal((await factor(expired,f.backup)).code,40105);assert(valid(f.old.access_token));
  const changed=(await login(f)).data.challenge_token;auth.updatePassword(f.user.id,'New-native-password-123');assert.equal((await factor(changed,f.backup)).code,40105);
 });
 await test('rejected factors roll back legacy secret migration so old connections remain valid',async()=>{
  const f=fixture(true,true),c=(await login(f)).data.challenge_token;
  assert.equal((await factor(c,'bad-code')).code,40104);assert.equal(row(f.user.id).totp_secret,f.secret);assert(valid(f.old.access_token));assert.equal(pending(c).attempts,1);
 });
 await test('successful legacy factor migration preserves existing grants and pending challenges without reviving invalid ones',async()=>{
  const f=fixture(true,true),c=(await login(f)).data.challenge_token,other=(await login(f)).data.challenge_token;
  const invalid=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE,'stale')).immediate();
  db.prepare("UPDATE app_grants SET security_stamp='older-state' WHERE id=?").run(invalid.grant_id);
  const revoked=db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE,'revoked')).immediate();native.revokeAppGrant(revoked.grant_id);
  const r=await factor(c,factors.totpCodeAt(f.secret),f.old.access_token);assert.equal(r.status,200);assert(row(f.user.id).totp_secret.startsWith('enc:v1:'));
  assert.equal(valid(f.old.access_token).scope,native.APP_SCOPE);assert.equal(valid(invalid.access_token),null);assert.equal(valid(revoked.access_token),null);
  assert.equal((await factor(other,f.backup)).status,200);assert(valid(f.old.access_token));
 });
 await test('grant creation failure rolls back backup consumption and leaves the challenge retryable',async()=>{
  const f=fixture(true),c=(await login(f)).data.challenge_token,before=row(f.user.id);
  db.exec("CREATE TEMP TRIGGER native_login_fail BEFORE INSERT ON app_grants BEGIN SELECT RAISE(ABORT,'internal detail'); END");
  try{const r=await factor(c,f.backup);assert.equal(r.status,500);assert(!JSON.stringify(r).includes('internal detail'));}finally{db.exec('DROP TRIGGER native_login_fail');}
  assert.deepEqual(row(f.user.id),before);assert.equal(pending(c).attempts,0);assert(valid(f.old.access_token));assert.equal((await factor(c,f.backup)).status,200);
 });
 await test('explicit permissions create a separate grant while old scopes remain unchanged',async()=>{
  const f=fixture();assert.equal((await permissions(f,'admin')).code,40301);assert.equal((await permissions(f,'security.write')).code,40301);assert.equal((await permissions(f,'profile.write','wrong')).status,200);
  const r=await permissions(f,'profile.write');assert.equal(r.status,200);assert.equal(r.data.replaces_grant_id,f.old.grant_id);assert.notEqual(r.data.grant_id,f.old.grant_id);assert.equal(r.data.user.capabilities.profileWrite,true);assert.equal(r.data.user.capabilities.twoFactorWrite,false);assert.equal(valid(f.old.access_token).scope,native.APP_SCOPE);
  const browser=auth.createSession(f.user.id),denied=await call('permissions','permissions',{client_id:'fire-ios',scope:'security.read',currentPassword:password},undefined,{cookie:'fire_session='+browser});assert.equal(denied.status,401);
 });
 await test('explicit permissions require no password or factor and leave sensitive mutations protected',async()=>{
  const f=fixture(true),before=row(f.user.id),challenges=db.prepare('SELECT COUNT(*) n FROM app_login_challenges').get().n;
  const rotated=native.refreshAppTokens('fire-ios',f.old.refresh_token);
  const r=await call('permissions','permissions',{client_id:'fire-ios',scope:'security.read security.write'},rotated.access_token);
  assert.equal(r.status,200);assert.equal(r.data.status,'authenticated');assert.equal(r.data.challenge_token,undefined);assert.equal(r.data.replaces_grant_id,f.old.grant_id);assert.equal(r.data.user.capabilities.twoFactorWrite,true);
  assert.deepEqual(row(f.user.id),before);assert.equal(db.prepare('SELECT COUNT(*) n FROM app_login_challenges').get().n,challenges);assert.equal(valid(rotated.access_token).scope,native.APP_SCOPE);
  const security=load('lib/appSecurity.ts');
  const denied=await security.securityResponse(()=>security.mutateTotp(req('totp/disable',{},r.data.access_token),'disable'));
  assert.equal(denied.status,403);assert.equal((await denied.json()).code,40103);assert.deepEqual(row(f.user.id),before);
 });
 await test('revocation during permission body reading blocks upgrade without a Cookie fallback',async()=>{
  const f=fixture(),body=load('lib/requestBody.ts'),read=body.readJsonBody,browser=auth.createSession(f.user.id),before=db.prepare('SELECT COUNT(*) n FROM app_grants').get().n;
  body.readJsonBody=async(...args)=>{const result=await read(...args);native.revokeAppGrant(f.old.grant_id);return result;};
  try{const r=await call('permissions','permissions',{client_id:'fire-ios',scope:'profile.write',currentPassword:password},f.old.access_token,{cookie:'fire_session='+browser});assert.equal(r.code,40102);}finally{body.readJsonBody=read;}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,before);assert(auth.getUserByToken(browser));
 });
 await test('permission grant failure preserves the source connection and credentials',async()=>{
  const f=fixture(true),before=row(f.user.id),count=db.prepare('SELECT COUNT(*) n FROM app_grants').get().n;
  db.exec("CREATE TEMP TRIGGER permissions_fail BEFORE INSERT ON app_grants BEGIN SELECT RAISE(ABORT,'internal detail'); END");
  try{const r=await permissions(f,'security.read security.write');assert.equal(r.status,500);assert(!JSON.stringify(r).includes('internal detail'));}finally{db.exec('DROP TRIGGER permissions_fail');}
  assert.deepEqual(row(f.user.id),before);assert(valid(f.old.access_token));assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants').get().n,count);
 });
 await test('device cap retains the grant being explicitly upgraded even when it is oldest',async()=>{
  const f=fixture();db.prepare('UPDATE app_grants SET created_at=? WHERE id=?').run(Date.now()-1000,f.old.grant_id);
  for(let i=0;i<19;i++)db.transaction(()=>native.createNativeAppGrant(f.user.id,native.APP_SCOPE,'device '+i)).immediate();
  const r=await permissions(f,'profile.write');assert.equal(r.status,200);assert(valid(f.old.access_token));assert.equal(db.prepare('SELECT COUNT(*) n FROM app_grants WHERE user_id=?').get(f.user.id).n,20);
 });
 await test('native token families keep refresh rotation and revoke behavior across v1/v2',async()=>{
  const f=fixture(),g=(await login(f)).data,refresh=load('app/api/v2/auth/token/route.ts');
  const r=await(await refresh.POST(req('token',{grant_type:'refresh_token',client_id:'fire-ios',refresh_token:g.refresh_token}))).json();assert.equal(r.data.grant_id,g.grant_id);assert.equal(r.data.scope,g.scope);assert(valid(r.data.access_token));
  const replay=await load('app/api/v1/auth/token/route.ts').POST(new Request(origin+'/api/v1/auth/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',client_id:'fire-ios',refresh_token:g.refresh_token})}));assert.equal(replay.status,401);assert.equal(valid(r.data.access_token),null);assert(valid(f.old.access_token));
  const second=(await login(f)).data;native.revokeAppToken(second.refresh_token);assert.equal(valid(second.access_token),null);
 });
 await test('security audit never records submitted passwords, factors or raw token credentials',async()=>{
  const f=fixture(true),c=(await login(f)).data.challenge_token;
  await factor(c,'private-rejected-factor');const result=await factor(c,f.backup);
  const rows=db.prepare('SELECT event,detail FROM security_audit WHERE user_id=?').all(f.user.id),text=JSON.stringify(rows);
  assert(rows.some(r=>r.event==='app_native_factor_rejected'));assert(rows.some(r=>r.event==='app_native_login_success'));
  for(const secret of [password,f.secret,f.backup,c,'private-rejected-factor',result.data.access_token,result.data.refresh_token])assert(!text.includes(secret));
 });
 console.log(`${count} native App login suites passed (isolated users and token database)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{db.close();}catch{}fs.rmSync(temp,{recursive:true,force:true});});
