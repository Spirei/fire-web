// Real shared auth and routes, disposable SQLite; no live accounts or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-login-case-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://login.example.test';global.fetch=async()=>{throw Error('Network disabled');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),db=load('lib/db.ts').getDb(),password='Case-Sensitive-123',origin=process.env.FIRE_APP_ORIGIN;
const request=(route,username,pw=password)=>new Request(origin+route,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username,password:pw,...(route.startsWith('/api/v2/')?{client_id:'fire-ios',device_name:'case regression'}:{})})});
(async()=>{
 const owner=auth.createUser('MixedOwner',password,false,'Owner@Example.test');
 for(const name of ['mixedowner','MIXEDOWNER','MiXeDoWnEr','OWNER@EXAMPLE.TEST'])assert.equal(auth.authenticateUser(name,password).id,owner.id);
 assert.equal(auth.authenticateUser('mixedowner',password.toLowerCase()),null);assert.equal(auth.authenticateUser('mixedowner','wrong'),null);
 for(const route of ['/api/auth/login','/api/v1/auth/login','/api/v2/auth/login']){db.prepare('DELETE FROM rate_limit').run();const r=await load('app'+route+'/route.ts').POST(request(route,'mixedowner'));assert.equal(r.status,200,route);assert.equal(auth.findUserById(owner.id).username,'MixedOwner');}
 assert.throws(()=>auth.createUser('MIXEDOWNER',password));assert.throws(()=>auth.createUser('owner@example.test',password));assert.throws(()=>auth.createUser('OtherLogin',password,false,'MIXEDOWNER'));
 db.prepare('DELETE FROM rate_limit').run();
 const registered=await load('app/api/auth/register/route.ts').POST(new Request(origin+'/api/auth/register',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'MIXEDOWNER',password})}));assert.equal(registered.status,409);
 const other=auth.createUser('OtherLogin',password);assert.equal(auth.updateProfile(other.id,{username:'MIXEDOWNER'}),null);assert.equal(auth.updateUserById(other.id,{username:'mixedowner'}),null);assert.equal(auth.updateProfile(other.id,{email:'MIXEDOWNER'}),null);
 assert.equal(auth.updateProfile(owner.id,{username:'mixedOwner'}).username,'mixedOwner');
 // Legacy case duplicates and cross username/email collision: reject every spelling, even with a matching password.
 db.prepare('UPDATE users SET username=? WHERE id=?').run('MIXEDOWNER',other.id);
 for(const name of ['mixedowner','mixedOwner','MIXEDOWNER'])assert.equal(auth.authenticateUser(name,password),null);
 for(const route of ['/api/auth/login','/api/v1/auth/login','/api/v2/auth/login']){db.prepare('DELETE FROM rate_limit').run();const r=await load('app'+route+'/route.ts').POST(request(route,'mixedOwner'));assert.equal(r.status,route.includes('/v2/')?403:401);assert(!r.headers.get('set-cookie'));}
 assert.equal(auth.updateUserById(other.id,{username:'OtherLogin'}).username,'OtherLogin');
 db.prepare('UPDATE users SET username=? WHERE id=?').run('OWNER@example.test',other.id);assert.equal(auth.authenticateUser('owner@example.test',password),null);
 assert.equal(auth.updateUserById(other.id,{username:'OtherLogin'}).username,'OtherLogin');
 assert.equal(auth.updateProfile(owner.id,{email:'mixedOwner'}).id,owner.id);assert.equal(auth.authenticateUser('MIXEDOWNER',password).id,owner.id,'one row matching both identifiers is still one identity');
 // Shared lower-case budget cannot be evaded with alternate casing.
 db.prepare('DELETE FROM rate_limit').run();const web=load('app/api/auth/login/route.ts');
 const key='login-account:'+load('lib/rateLimit.ts').loginIdentityKey('mixedOwner');db.prepare('INSERT INTO rate_limit(key,count,reset_at) VALUES(?,19,?)').run(key,Date.now()+900000);
 assert.equal((await web.POST(request('/api/auth/login','MIXEDOWNER','wrong'))).status,401);assert.equal((await web.POST(request('/api/auth/login','mixedOwner'))).status,429);
 const factors=load('lib/totp.ts'),secret=factors.generateTotpSecret();db.prepare('UPDATE users SET totp_enabled=1,totp_secret=? WHERE id=?').run(load('lib/secretStorage.ts').encryptSecret(secret),owner.id);
 for(const route of ['/api/auth/login','/api/v1/auth/login','/api/v2/auth/login']){db.prepare('DELETE FROM rate_limit').run();const r=await load('app'+route+'/route.ts').POST(request(route,'MIXEDOWNER'));assert.equal(r.status,200);const body=await r.json();assert.equal(body.requires2fa??body.data?.requires2fa??(body.data?.status==='requires_2fa'),true,JSON.stringify(body));assert(!r.headers.get('set-cookie'));}
 console.log('PASS shared case-insensitive login, exact passwords, identity conflicts, rename, budget and TOTP');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
