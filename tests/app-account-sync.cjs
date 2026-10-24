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

const {randomUUID}=require('node:crypto'),state=load('app/api/v2/app-state/route.ts'),sync=load('app/api/v2/account-sync/route.ts'),receipt=load('app/api/v2/app-state/operations/[requestId]/route.ts');
const key=(...parts)=>JSON.stringify(parts),id=()=>randomUUID(),changes=(k,v,revision=0)=>({key:k,value:v,revision});
async function read(f,namespace='watch'){const res=await state.GET(new Request(origin+'/api/v2/app-state?namespace='+namespace,{headers:{authorization:'Bearer '+f.old.access_token}}));return {status:res.status,...await res.json()};}
async function poll(f){const res=await sync.GET(new Request(origin+'/api/v2/account-sync',{headers:{authorization:'Bearer '+f.old.access_token}}));return {status:res.status,...await res.json()};}
async function write(f,list,namespace='watch',requestId=id()){const res=await state.POST(new Request(origin+'/api/v2/app-state',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.old.access_token},body:JSON.stringify({requestId,namespace,changes:list})}));return {status:res.status,...await res.json()};}
async function recover(f,requestId){const res=await receipt.GET(new Request(origin+'/api/v2/app-state/operations/'+requestId,{headers:{authorization:'Bearer '+f.old.access_token}}),{params:Promise.resolve({requestId})});return {status:res.status,...await res.json()};}
const field=(v,k)=>v.data.fields[k];
(async()=>{
 await test('discovery limits shared content to account annotations and fees, not device preferences',async()=>{
  const route=load('app/api/v2/auth/config/route.ts'),v=(await(await route.GET(new Request(origin+'/api/v2/auth/config'))).json()).data.account_sync;
  assert.equal(v.path,'/api/v2/account-sync');assert.deepEqual(v.namespaces,['watch','fees']);assert.equal(v.automatic_mutation_replay,false);
  assert.equal((await write(fixture(),[changes('appearanceMode',2)],'preferences')).status,400);
 });
 await test('two device grants share exact account annotations without sharing tokens',async()=>{
  const phone=fixture(),simulator={...phone,old:(await login(phone)).data},k=key('notes','record-1');
  const saved=await write(phone,[changes(k,'我的备注')]);assert.equal(saved.status,200);assert.equal(saved.data.state,'completed');assert.equal(field(await read(simulator),k).value,'我的备注');
  native.revokeAppToken(phone.old.refresh_token);assert.equal(field(await read(simulator),k).value,'我的备注');
 });
 await test('disjoint edits merge and same-field CAS conflict preserves the winning content',async()=>{
  const f=fixture(),a=key('pinned','a'),b=key('hidden','b');
  assert.equal((await write(f,[changes(a,true)])).data.state,'completed');assert.equal((await write(f,[changes(b,true)])).data.state,'completed');
  const conflicting=await write(f,[changes(a,null)]);assert.equal(conflicting.data.state,'conflict');assert.equal(field(await read(f),a).value,true);
  const removed=await write(f,[changes(a,null,1)]);assert.equal(removed.data.state,'completed');assert.equal(field(await read(f),a).revision,2);
  assert.equal((await write(f,[changes(a,true)])).data.state,'conflict');assert.equal(field(await read(f),a).value,null);
 });
 await test('unknown response is recovered by original UUID; duplicate body cannot mutate twice',async()=>{
  const f=fixture(),k=key('aliases','a'),requestId=id(),body=[changes(k,'别名')];
  await write(f,body,'watch',requestId);const confirmed=await recover(f,requestId);assert.equal(confirmed.data.state,'completed');assert.equal(confirmed.data.data.partial,true);
  const repeat=await write(f,body,'watch',requestId);assert.deepEqual(repeat.data,confirmed.data);assert.equal(field(await read(f),k).revision,1);
  assert.equal((await write(f,[changes(k,'other')],'watch',requestId)).status,409);
 });
 await test('another account, Cookie, revoked grant, wrong origin and read-only write cannot borrow state',async()=>{
  const f=fixture(),other=fixture(),requestId=id(),k=key('notes','a');await write(f,[changes(k,'private')],'watch',requestId);
  assert.deepEqual((await read(other)).data.fields,{});assert.equal((await recover(other,requestId)).status,404);
  const cookie=await state.GET(new Request(origin+'/api/v2/app-state?namespace=watch',{headers:{cookie:'fire_session='+auth.createSession(f.user.id)}}));assert.equal(cookie.status,401);
  const wrong=await state.GET(new Request(origin+'/api/v2/app-state?namespace=watch',{headers:{authorization:'Bearer '+f.old.access_token,origin:'https://evil.test'}}));assert.equal(wrong.status,403);
  const readOnly={...f,old:db.transaction(()=>native.createNativeAppGrant(f.user.id,'portfolio.read','read')).immediate()};assert.equal((await write(readOnly,[changes(k,'blocked')])).status,403);
  native.revokeAppToken(f.old.refresh_token);assert.equal((await read(f)).status,401);
 });
 await test('change revisions track insert/update/delete atomically and never wake another owner',async()=>{
  const f=fixture(),other=fixture(),before=(await poll(f)).data,otherBefore=(await poll(other)).data;
  auth.updateProfile(f.user.id,{nickname:'Changed'});let after=(await poll(f)).data;assert(after.revisions.profile>before.revisions.profile);assert.deepEqual((await poll(other)).data,otherBefore);
  const stable=after.revisions.profile;auth.updateProfile(f.user.id,{nickname:'Changed'});assert.equal((await poll(f)).data.revisions.profile,stable);
  assert.throws(()=>db.transaction(()=>{db.prepare("UPDATE users SET nickname='rolled back' WHERE id=?").run(f.user.id);throw Error('rollback');})());assert.equal((await poll(f)).data.revisions.profile,stable);
  const watchBefore=after.revisions.watch;db.prepare("INSERT INTO watch_groups(id,user_id,name,icon,sort,visible,kind,market,created_at) VALUES(?,?,'x','',0,1,'custom','','2026-10-25')").run('wg-sync-test',f.user.id);assert((await poll(f)).data.revisions.watch>watchBefore);
  const inserted=(await poll(f)).data.revisions.watch;db.prepare('DELETE FROM watch_groups WHERE id=?').run('wg-sync-test');assert((await poll(f)).data.revisions.watch>inserted);
 });
 await test('same-URL avatar replacement and first lazy feed mutation both signal a change',async()=>{
  const f=fixture(),before=(await poll(f)).data;auth.updateUserAvatar(f.user.id,'/uploads/avatar/test.svg');assert((await poll(f)).data.revisions.profile>before.revisions.profile);
  load('lib/feedStore.ts').feedTables();const value=(await poll(f)).data.revisions.feed;
  db.prepare("INSERT INTO feed_agent_profiles(user_id,name) VALUES(?,'New name')").run(f.user.id);assert((await poll(f)).data.revisions.feed>value);
 });
 await test('malformed/private fields and unsupported namespaces fail before any publication',async()=>{
  const f=fixture();for(const [k,v]of [['__proto__',{}],[key('token','a'),'secret'],[key('hidden','a'),'true'],[key('orders','ALL'),['a','a']]])assert.equal((await write(f,[changes(k,v)])).status,400);
  assert.deepEqual((await read(f)).data.fields,{});
 });
 await test('storage failure rolls back field changes, receipt and domain revision together',async()=>{
  const f=fixture(),before=(await poll(f)).data,requestId=id();db.exec("CREATE TEMP TRIGGER app_state_fail BEFORE INSERT ON app_state_operations BEGIN SELECT RAISE(ABORT,'private sqlite'); END");
  try{const result=await write(f,[changes(key('pinned','a'),true)],'watch',requestId);assert.equal(result.status,500);assert(!JSON.stringify(result).includes('private sqlite'));}finally{db.exec('DROP TRIGGER app_state_fail');}
  assert.deepEqual((await read(f)).data.fields,{});assert.deepEqual((await poll(f)).data,before);assert.equal((await recover(f,requestId)).status,404);
 });
 await test('financial fee bytes remain exact and concurrent overlapping plans are rejected',async()=>{
  const f=fixture(),account='ba-'+('a'.repeat(24)),planId=id();db.prepare("INSERT INTO broker_accounts(id,user_id,name,provider_id,currency,revision,created_at,updated_at) VALUES(?,?,'Test','longbridge','USD',1,'2026-10-25','2026-10-25')").run(account,f.user.id);
  const plan={id:planId,accountID:account,providerID:'longbridge',market:'us',effectiveFrom:'2026-01-01',effectiveThrough:null,overrides:{commission:{basis:'share',rate:0.00000001,minimumWins:true,side:'both',tiers:[],graduated:true}},revision:1,updatedAt:12345};
  const raw=JSON.stringify(plan),value=Buffer.from(raw).toString('base64'),result=await write(f,[changes('plan/'+planId,value)],'fees');assert.equal(result.status,200);assert.equal(field(await read(f,'fees'),'plan/'+planId).value,value);assert.equal(Buffer.from(value,'base64').toString(),raw);
  const another={...plan,id:id()},conflict=await write(f,[changes('plan/'+another.id,Buffer.from(JSON.stringify(another)).toString('base64'))],'fees');assert.equal(conflict.status,409);assert.equal(Object.keys((await read(f,'fees')).data.fields).length,1);
  const foreign=fixture(),bad=await write(foreign,[changes('plan/'+planId,value)],'fees');assert.equal(bad.status,404);
  const invalidPlan={...plan,id:id(),effectiveFrom:'2027-01-01',overrides:{commission:{...plan.overrides.commission,rate:-1}}};
  assert.equal((await write(f,[changes('plan/'+invalidPlan.id,Buffer.from(JSON.stringify(invalidPlan)).toString('base64'))],'fees')).status,400);
  assert.equal((await write(f,[changes('plan/'+planId,null,1)],'fees')).status,409);
  const removed=await write(f,[changes('plan/'+planId,null,1),changes('history/'+planId+'/1',value)],'fees');assert.equal(removed.data.state,'completed');
  assert.equal((await write(f,[changes('history/'+planId+'/1',null,1)],'fees')).status,409);

 });
 await test('deleting an account cascades annotations, revisions and receipts without reviving it',async()=>{
  const f=fixture();await write(f,[changes(key('notes','a'),'delete me')]);db.prepare('DELETE FROM users WHERE id=?').run(f.user.id);
  for(const table of ['app_state_fields','app_state_operations','app_sync_revisions'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').get(f.user.id).n,0);
 });
 console.log(`${count} cross-device account-state suites passed (isolated database/network)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{db.close();}catch{}fs.rmSync(temp,{recursive:true,force:true});});
