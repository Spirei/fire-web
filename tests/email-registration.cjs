// Disposable database and captured SMTP only; never a real address or mailbox.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-email-register-'));process.chdir(temp);
process.env.STOCKLOG_FUTU='off';process.env.FIRE_TRUST_PROXY_HEADERS='true';process.env.FIRE_APP_ORIGIN='https://register.example.test';
global.fetch=async()=>{throw new Error('Network disabled');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),db=load('lib/db.ts').getDb(),mail=load('lib/mail.ts'),deliveries=[];
const owner=auth.createUser('fixture_owner','Owner-safe-123');load('lib/settings.ts').updateSiteSettings({allowRegister:true});
mail.mailConfigured=()=>true;mail.sendRegistrationCode=async(email,code,permit)=>{load('lib/mailBudget.ts').consumeMailPermit(email,'verification',permit);deliveries.push({email,code});};
const api=load('lib/emailRegistration.ts'),origin=process.env.FIRE_APP_ORIGIN,password='Register-safe-123';let ip=0,count=0;
const request=(body,action='request',extra={})=>new Request(origin+'/api/auth/register/email/'+action,{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-for':'192.0.2.'+(++ip),...extra},body:JSON.stringify(body)});
const call=(body,action='request',extra)=>api.emailRegistration(request(body,action,extra),action);
const total=table=>db.prepare('SELECT COUNT(*) n FROM '+table).get().n;
function fresh(){db.prepare('DELETE FROM rate_limit').run();db.prepare('DELETE FROM mail_send_attempts').run();}
async function test(name,fn){fresh();await fn();count++;console.log('PASS '+name);}
async function issue(email){const r=await call({email});assert.equal(r.status,200);return r.json();}
const confirm=(s,code,passwordValue=password)=>call({email:s.email,challenge:s.challenge,code,password:passwordValue},'confirm');
(async()=>{try{
 await test('strict request validation, source checks and signup switch cannot create a user',async()=>{
  const n=total('users');for(const body of [null,[],{email:['a@example.test']},{email:'a@example.test',role:'admin'},{email:'x@example.test\r\nBcc:other@example.test'},{email:"<script>@example.test"}]){assert.equal((await call(body)).status,400);}
  assert.equal((await call({email:'a@example.test'},'request',{origin:'https://evil.example'})).status,403);
  load('lib/settings.ts').updateSiteSettings({allowRegister:false});assert.equal((await call({email:'a@example.test'})).status,403);load('lib/settings.ts').updateSiteSettings({allowRegister:true});assert.equal(total('users'),n);
 });
 await test('request creates no account/session or password row; verification atomically binds email and profile',async()=>{
  const before=[total('users'),total('sessions')],s=await issue(' New.User@Example.test ');assert.equal(s.email,'new.user@example.test');assert.deepEqual([total('users'),total('sessions')],before);
  const stored=db.prepare('SELECT * FROM registration_email_challenges WHERE email=?').get(s.email);assert(!JSON.stringify(stored).includes(s.challenge));assert(!Object.keys(stored).some(k=>k.includes('password')));
  const r=await confirm(s,deliveries.at(-1).code);assert.equal(r.status,201);const user=(await r.json()).user;assert.equal(user.email,s.email);assert.equal(user.emailVerified,true);assert.equal(user.role,'user');assert(!user.username.includes('@'));assert.equal(total('users'),before[0]+1);assert.equal(total('sessions'),before[1]+1);
  const session=r.headers.get('set-cookie').match(/fire_session=([^;]+)/)[1];assert.equal(auth.getUserByToken(session).email,s.email);assert.equal(auth.getUserByToken(session).emailVerified,true);
  const native=await load('lib/appNativeLogin.ts').nativeLogin(new Request(origin+'/api/v2/auth/login',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.240'},body:JSON.stringify({client_id:'fire-ios',username:s.email.toUpperCase(),password,device_name:'QA'})}));assert.equal(native.user.email,s.email);assert.equal(native.user.emailVerified,true);
  for(const version of [1,2]){const me=await load('app/api/v'+version+'/auth/me/route.ts').GET(new Request(origin+'/api/v'+version+'/auth/me',{headers:{authorization:'Bearer '+native.access_token}}));const data=(await me.json()).data;assert.equal(data.email,s.email);assert.equal(data.emailVerified,true);}
  assert.equal((await confirm(s,deliveries.at(-1).code)).status,400);assert.equal(total('users'),before[0]+1);
 });
 await test('bad codes count persistently, do not bind email and stop at five attempts',async()=>{
  const s=await issue('attempts@example.test'),correct=deliveries.at(-1).code,wrong=correct==='000000'?'000001':'000000';for(let i=0;i<5;i++){fresh();assert.equal((await confirm(s,wrong)).status,400);}fresh();assert.equal((await confirm(s,correct)).status,400);assert.equal(auth.findUserByEmail(s.email),undefined);assert.equal(db.prepare('SELECT attempts FROM registration_email_challenges WHERE email=?').get(s.email).attempts,5);
 });
 await test('expired, changed-email, cross-origin and oversized challenges cannot create accounts',async()=>{
  const s=await issue('bound@example.test'),code=deliveries.at(-1).code;
  assert.equal((await call({email:'other@example.test',challenge:s.challenge,code,password},'confirm')).status,400);
  assert.equal((await api.emailRegistration(new Request('https://other.example.test/api/auth/register/email/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:s.email,challenge:s.challenge,code,password})}),'confirm')).status,400);
  assert.equal((await call({email:s.email,challenge:'x'.repeat(6000),code,password},'confirm')).status,400);
  assert.equal((await call({email:s.email,challenge:s.challenge,code,password,role:'admin'},'confirm')).status,400);
  db.prepare('UPDATE registration_email_challenges SET expires_at=0 WHERE email=?').run(s.email);assert.equal((await confirm(s,code)).status,400);
 });
 await test('resend invalidates the old code; send cooldown and failed SMTP retain budgets',async()=>{
  const s=await issue('resend@example.test'),oldCode=deliveries.at(-1).code;assert.equal((await call({email:s.email})).status,429);fresh();const next=await issue(s.email);assert.equal((await confirm(s,oldCode)).status,400);assert.equal((await confirm(next,deliveries.at(-1).code)).status,201);
  fresh();const sender=mail.sendRegistrationCode;mail.sendRegistrationCode=async()=>{throw new Error('secret SMTP key');};const r=await call({email:'failed@example.test'});assert.equal(r.status,503);assert(!JSON.stringify(await r.json()).includes('secret'));assert.equal(total('mail_send_attempts'),1);assert.equal(auth.findUserByEmail('failed@example.test'),undefined);assert.equal(db.prepare('SELECT 1 FROM registration_email_challenges WHERE email=?').get('failed@example.test'),undefined);mail.sendRegistrationCode=sender;
 });
 await test('session/verified-email failure rolls back account, code consumption and creation quotas',async()=>{
  const s=await issue('rollback@example.test'),code=deliveries.at(-1).code,before=[total('users'),total('sessions')];db.exec("CREATE TRIGGER fixture_fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'private failure'); END");assert.equal((await confirm(s,code)).status,503);assert.deepEqual([total('users'),total('sessions')],before);assert.equal(auth.findUserByEmail(s.email),undefined);assert.equal(db.prepare("SELECT count(*) n FROM rate_limit WHERE key LIKE 'register-created-%'").get().n,0);db.exec('DROP TRIGGER fixture_fail_session');assert.equal((await confirm(s,code)).status,201);
 });
 await test('duplicate verified mail never becomes another account and all writers enforce case-insensitive uniqueness',async()=>{
  const before=total('users'),sent=deliveries.length,s=await issue('new.user@example.test');assert.equal(deliveries.length,sent);assert.equal((await confirm(s,'123456')).status,400);assert.equal(total('users'),before);assert.throws(()=>auth.createUser('email_duplicate',password,false,'NEW.USER@example.test'),/email already bound/);
  const created=auth.createUser('receipt_email',password,false,'receipt@example.test');assert.equal(created.email,'receipt@example.test');
 });
 console.log(count+' email registration suites passed (isolated SMTP and database)');
}finally{db.close();fs.rmSync(temp,{recursive:true,force:true});}})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1);});
