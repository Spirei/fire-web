// Cross-version App protocol and identity tests use only a disposable database.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const deliveries=[];
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-app-v2-')); process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://account.test.example:18520';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const next=load('node_modules/next/server.js'); next.after=fn=>{deliveries.push(fn);};
const auth = load('lib/auth.ts'), native = load('lib/appAuth.ts'), db = load('lib/db.ts').getDb();
const me = load('app/api/v1/auth/me/route.ts'), config = load('app/api/v1/auth/config/route.ts');
const bodies = load('lib/requestBody.ts'), factors = load('lib/totp.ts');
const origin = process.env.FIRE_APP_ORIGIN, oldPassword = 'Owner-old-123';
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
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); count++; console.log('PASS '+name); }
const policy=load('lib/appApiV2Policy.ts'), v2Gate=load('lib/appApiV2.ts');
const full='portfolio.read portfolio.write profile.write feed.read feed.write security.read security.write';
const pathFor=path=>path.replace('[recordId]','test-id').replace('[id]','test-id').replace('[jobId]','fj-'+ 'a'.repeat(24)).replace('[postId]','fp-'+ 'a'.repeat(24)).replace('[groupId]','default').replace('[folderId]','rld_'+'a'.repeat(32)).replace('[fileId]','rlf_'+'a'.repeat(32)).replace('[requestId]','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
function r2(path,body,token,method='GET',headers={}){return new Request(origin+'/api/v2/'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),'content-type':'application/json',...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
const route2=path=>load('app/api/v2/'+(path.startsWith('resource-library')?'resource-library/[[...action]]':path.startsWith('feed')?'feed/[[...action]]':path)+'/route.ts');
const execute=(path,method,request)=>route2(path)[method](request,{params:Promise.resolve((path.startsWith('feed')||path.startsWith('resource-library'))?{action:pathFor(path).split('/').slice(1)}:{id:'test-id'})});
const data=async promise=>{const res=await promise;return {status:res.status,headers:res.headers,body:await res.json()};};
(async()=>{
 await test('v1 discovery stays compatible and v2 returns fixed same-origin paths with consistent versions',async()=>{
  const one=(await data(config.GET(new Request(origin+'/api/v1/auth/config')))).body.data;
  const two=(await data(route2('auth/config').GET(r2('auth/config')))).body.data;
  assert.equal(one.version,1);assert.equal(two.version,2);assert.deepEqual(one.api_versions_supported,[1,2]);assert.equal(one.token_path,'/api/v1/auth/token');assert.equal(two.token_path,'/api/v2/auth/token');
  for(const key of ['profile_path','upload_path','email_path','password_path','feed_path','revoke_path'])assert.equal(two[key],one[key].replace('/api/v1/','/api/v2/'));
  for(const key of ['email_verification_path','totp_path','passkeys_path','devices_path','password_reset_path'])assert.equal(two.security[key],one.security[key].replace('/api/v1/','/api/v2/'));
  assert.equal(two.security.version,2);assert.equal(two.authorization_path,'/app/authorize');assert.equal(two.authorization_submit_path,'/api/v1/auth/authorize');assert.equal(two.devices_path,'/app/devices');assert.equal(two.scope,native.APP_SCOPE);assert.equal(two.security.passkey_registration.supported,false);
 });
 await test('every published private method rejects Cookie and legacy Web Bearer before business execution',async()=>{
  const f=fixture(false,true), before=row(f.user.id);
  for(const entry of policy.APP_V2_ROUTES)for(const method of entry.methods){
   const path=pathFor(entry.path),access=policy.appV2Access('/api/v2/'+path,method);
   if(['public','credential'].includes(access))continue;
   for(const headers of [{cookie:'fire_session='+f.browser},{authorization:'Bearer '+f.browser,cookie:'fire_session='+f.browser}]){
    const response=await data(execute(entry.path,method,r2(path,method==='GET'?undefined:{},undefined,method,headers)));assert.equal(response.status,401,method+' '+path);
   }
   assert.equal(auth.getAuthUser(r2(path,undefined,undefined,method,{cookie:'fire_session='+f.browser})),null);
  }
  assert.deepEqual(row(f.user.id),before);assert(auth.getUserByToken(f.browser));assert.equal(db.prepare('SELECT COUNT(*) n FROM records WHERE user_id=?').get(f.user.id).n,0);
 });
 await test('v2 scope failures are 403 and leave old readonly grants valid without scope escalation',async()=>{
  const f=fixture(), grant=f.grant;
  for(const [path,method] of [['records','POST'],['auth/profile','PUT'],['auth/totp/setup','POST'],['feed/preferences','PUT'],['watch-groups/reorder','POST']]){
   const reply=await data(execute(path,method,r2(path,{},grant.access_token,method)));assert.equal(reply.status,403);assert.equal(reply.body.code,40301);
  }
  const me2=(await data(route2('auth/me').GET(r2('auth/me',undefined,grant.access_token)))).body.data;
  assert.equal(me2.id,f.user.id);assert.equal(me2.scope,'portfolio.read');assert.equal(me2.capabilities.twoFactorWrite,false);assert.equal(me2.capabilities.profileWrite,false);assert(identity(grant.access_token));
  assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID,grant.refresh_token).scope,'portfolio.read');
 });
 await test('v2 portfolio shares storage and owner isolation with v1, with no cookie role inheritance',async()=>{
  const f=fixture(false,true), grant=connect(f.user,f.browser,full);
  const created=await data(route2('records').POST(r2('records',{name:'V2 test',code:'TEST',market:'US',price:10,cost:8,qty:2},grant.access_token,'POST')));assert.equal(created.status,200);const id=created.body.data.id;
  const v1=(await data(load('app/api/v1/records/route.ts').GET(req('records',undefined,grant.access_token,'GET')))).body.data;
  const v2=(await data(route2('records').GET(r2('records',undefined,grant.access_token)))).body.data;
  assert.deepEqual(v2,v1);assert(v2.some(x=>x.id===id));
  const other=(await data(route2('records').GET(r2('records',undefined,f.otherGrant.access_token)))).body.data;assert(!other.some(x=>x.id===id));
  const user=(await data(route2('auth/me').GET(r2('auth/me',undefined,grant.access_token,'GET',{cookie:'fire_session='+f.browser})))).body.data;assert.equal(user.role,'user');
  const denied=await v2Gate.appV2Response(r2('assets',{},grant.access_token,'POST'),()=>assert.fail('admin handler must not execute'));assert.equal(denied.status,405);
 });
 await test('public market/image reads support local App use and never accept Web identity as an App grant',async()=>{
  const f=fixture();
  for(const headers of [{},{cookie:'fire_session='+f.browser}]){
   const quote=await data(route2('quotes').POST(r2('quotes',{items:[]},undefined,'POST',headers)));assert.equal(quote.status,200);assert.deepEqual(quote.body.data,{quotes:{}});
   const asset=await data(route2('assets').GET(r2('assets',undefined,undefined,'GET',headers)));assert.equal(asset.status,200);assert(Array.isArray(asset.body.data));
  }
  const bad=await data(route2('quotes').POST(r2('quotes',{items:[]},f.browser,'POST')));assert.equal(bad.status,401);
  assert.equal((await data(route2('brokers').GET(r2('brokers',undefined,undefined,'GET',{cookie:'fire_session='+f.browser})))).status,401);
  assert.equal((await data(route2('brokers').GET(r2('brokers',undefined,f.grant.access_token)))).status,200);
 });
 await test('PKCE codes and refresh families remain single-use across v1/v2 with identical identity',async()=>{
  const f=fixture(),verifier=crypto.randomBytes(32).toString('base64url'),values={...f.grant.values,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url')};
  const code=native.issueAppCode(values,f.user.id,f.browser),body={grant_type:'authorization_code',client_id:native.APP_CLIENT_ID,redirect_uri:native.APP_REDIRECT_URI,code,code_verifier:verifier};
  const exchanged=await data(route2('auth/token').POST(r2('auth/token',body,undefined,'POST')));assert.equal(exchanged.status,200);const token=exchanged.body.data;
  const replay=await data(load('app/api/v1/auth/token/route.ts').POST(req('auth/token',body,undefined)));assert.equal(replay.status,401);
  const v1Me=(await data(me.GET(req('auth/me',undefined,token.access_token,'GET')))).body.data;
  const v2Me=(await data(route2('auth/me').GET(r2('auth/me',undefined,token.access_token)))).body.data;assert.deepEqual(v2Me,v1Me);
  const rotated=(await data(route2('auth/token').POST(r2('auth/token',{grant_type:'refresh_token',client_id:native.APP_CLIENT_ID,refresh_token:token.refresh_token},undefined,'POST')))).body.data;assert.equal(rotated.grant_id,token.grant_id);
  assert.equal((await data(load('app/api/v1/auth/token/route.ts').POST(req('auth/token',{grant_type:'refresh_token',client_id:native.APP_CLIENT_ID,refresh_token:token.refresh_token},undefined)))).status,401);
  assert.equal((await data(route2('auth/me').GET(r2('auth/me',undefined,rotated.access_token)))).body.code,40102);assert(auth.getUserByToken(f.browser));assert(identity(f.otherGrant.access_token));
 });
 await test('v2 native security keeps credential errors, atomic rollback, challenge binding and success response',async()=>{
  const f=fixture(),grant=connect(f.user,f.browser,full);
  const bad=await data(route2('auth/totp/setup').POST(r2('auth/totp/setup',{currentPassword:'bad'},grant.access_token,'POST')));assert.equal(bad.status,403);assert.equal(bad.body.code,40103);assert(identity(grant.access_token));
  const setup=(await data(route2('auth/totp/setup').POST(r2('auth/totp/setup',{currentPassword:oldPassword},grant.access_token,'POST')))).body.data;assert(setup.qrPng.startsWith('data:image/png;base64,'));assert(setup.expiresAt>Date.now());
  const body={challengeId:setup.challengeId,currentPassword:oldPassword,code:factors.totpCodeAt(setup.secret)};
  db.exec("CREATE TEMP TRIGGER v2_fail BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'private database error'); END");
  try{const failed=await data(route2('auth/totp/confirm').POST(r2('auth/totp/confirm',body,grant.access_token,'POST')));assert.equal(failed.status,500);assert(!JSON.stringify(failed.body).includes('private database'));}finally{db.exec('DROP TRIGGER v2_fail');}
  assert.equal(row(f.user.id).totp_enabled,0);assert(identity(grant.access_token));
  const confirmed=(await data(route2('auth/totp/confirm').POST(r2('auth/totp/confirm',body,grant.access_token,'POST')))).body.data;
  assert.equal(confirmed.reauthenticationRequired,true);assert(confirmed.backupCodes.length>0);assert.equal(identity(grant.access_token),null);
 });
 await test('revocation during v2 input cannot fall back to a valid Cookie or execute a security write',async()=>{
  const f=fixture(),grant=connect(f.user,f.browser,full),before=row(f.user.id),read=bodies.readJsonBody;
  bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(grant.grant_id);return body;};
  try{const response=await data(route2('auth/email').PUT(r2('auth/email',{email:'never@example.test',currentPassword:oldPassword},grant.access_token,'PUT',{cookie:'fire_session='+f.browser})));assert.equal(response.status,401);}finally{bodies.readJsonBody=read;}
  assert.deepEqual(row(f.user.id),before);assert(auth.getUserByToken(f.browser));
 });
 await test('feed paths and method restrictions cannot use dynamic IDs to bypass optional scopes',async()=>{
  const f=fixture(),grant=connect(f.user,f.browser,'portfolio.read feed.read feed.write');
  const response=await data(execute('feed','GET',r2('feed',undefined,grant.access_token)));assert.equal(response.status,200);
  assert.equal(policy.appV2Access('/api/v2/feed/jobs/bad','GET'),null);assert.equal(policy.appV2Access('/api/v2/feed/posts/fp-'+ 'a'.repeat(24)+'/discussion','DELETE'),null);
  assert.equal(policy.appV2Access('/api/v2/watch-groups/reorder','DELETE'),null);
  for(const path of ['auth/login','auth/authorize','auth/devices','auth/delete-account','data/export','orders/export','portfolio-series','users','financial-reports'])assert.equal(policy.appV2Access('/api/v2/'+path,'GET'),null);
  const v2=await v2Gate.appV2Response(r2('auth/authorize',{},grant.access_token,'POST'),()=>assert.fail('Cookie consent is not published in v2'));assert.equal(v2.status,404);
 });
 await test('v2 FIRE uses an envelope while v1 stays bare and revocation during input cannot save',async()=>{
  const f=fixture(),grant=connect(f.user,f.browser,full);
  const old=await data(load('app/api/v1/fire-settings/route.ts').GET(req('fire-settings',undefined,grant.access_token,'GET')));
  assert.equal(old.body.code,undefined);assert(old.body.fire);
  const get=await data(route2('fire-settings').GET(r2('fire-settings',undefined,grant.access_token)));
  assert.equal(get.body.code,0);assert.deepEqual(get.body.data,old.body);
  const invalid=await data(route2('fire-settings').PUT(r2('fire-settings',{},grant.access_token,'PUT')));assert.equal(invalid.status,400);assert.equal(invalid.body.code,40001);
  const saved=await data(route2('fire-settings').PUT(r2('fire-settings',{fire:{targetAmount:123}},grant.access_token,'PUT')));assert.equal(saved.body.code,0);assert.equal(saved.body.data.ok,true);
  const before=(await data(route2('fire-settings').GET(r2('fire-settings',undefined,grant.access_token)))).body.data;
  const read=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(grant.grant_id);return body;};
  try { const denied=await data(route2('fire-settings').PUT(r2('fire-settings',{fire:{targetAmount:456}},grant.access_token,'PUT')));assert.equal(denied.status,401);assert.equal(denied.body.code,40101); }finally{bodies.readJsonBody=read;}
  const latest=connect(f.user,f.browser,full);
  assert.deepEqual((await data(route2('fire-settings').GET(r2('fire-settings',undefined,latest.access_token)))).body.data,before);
 });
 console.log(`PASS ${count} App v2 migration suites`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
