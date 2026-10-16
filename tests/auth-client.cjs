// Execute the actual client submit handlers with deferred HTTP responses.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../components/LoginForm.tsx'),'utf8'),tree=ts.createSourceFile('LoginForm.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const functions=[];
(function visit(node){if(ts.isFunctionDeclaration(node)&&['submit','completeTotp','pause','retryDelay'].includes(node.name?.text))functions.push(node.getText(tree));ts.forEachChild(node,visit);})(tree);
assert.equal(functions.length,4);
function fixture(mode='register',shared=new Map()){
 let calls=0,pushes=0;const context={Date,Error,Number,Math,Response,JSON,mode,step:mode,retryDeadlines:shared,submitting:{current:false},totpSubmitting:{current:false},loading:false,
  emailRegistration:false,emailRegistrationSupported:false,registrationEmail:null,registrationCode:'',setRegistrationEmail(v){context.registrationEmail=v;},setRegistrationCode(v){context.registrationCode=v;},username:'client_user',password:'Client-password-123',confirm:'Client-password-123',totpTicket:'',totpCode:'',totpAutoTried:{current:''},useBackupCode:false,
  setClock(){},setError(v){context.error=v;},setLoading(v){context.loading=v;},setTotpTicket(v){context.totpTicket=v;},setTotpCode(v){context.totpCode=v;},setUseBackupCode(v){context.useBackupCode=v;},setPassword(v){context.password=v;},onClose(){},destination:'/records',router:{push(){pushes++;}},fetch:async(url,options)=>{calls++;context.lastRequest={url,body:JSON.parse(options.body)};return context.respond();}};
 vm.createContext(context);vm.runInContext(ts.transpileModule(functions.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
 return {context,shared,calls:()=>calls,pushes:()=>pushes};
}
(async()=>{
 const event={preventDefault(){}};
 const first=fixture();let release;first.context.respond=()=>new Promise(resolve=>{release=resolve;});
 const pending=first.context.submit(event);await first.context.submit(event);assert.equal(first.calls(),1,'rapid double submit must issue one HTTP request');release(new Response(JSON.stringify({user:{id:'created'}}),{status:201}));await pending;assert.equal(first.pushes(),1);
 console.log('PASS actual Web register handler admits one in-flight submit');
 const limited=fixture();limited.context.respond=async()=>new Response(JSON.stringify({error:'注册过于频繁，请稍后再试'}),{status:429,headers:{'retry-after':'12'}});
 await limited.context.submit(event);assert.equal(limited.calls(),1);assert(limited.shared.get('register')>Date.now());await limited.context.submit(event);assert.equal(limited.calls(),1);
 const reopened=fixture('register',limited.shared);reopened.context.respond=async()=>new Response('{}',{status:201});await reopened.context.submit(event);assert.equal(reopened.calls(),0,'reopening keeps server pause');
 const login=fixture('login',limited.shared);login.context.respond=async()=>new Response('{}',{status:200});await login.context.submit(event);assert.equal(login.calls(),1,'registration pause does not block a separate login');
 limited.shared.set('register',Date.now()-1);assert.equal(reopened.calls(),0,'expiry never automatically posts');await reopened.context.submit(event);assert.equal(reopened.calls(),1);
 console.log('PASS 429 cooldown survives form recreation, isolates register/login and only retries explicitly');
 const factor=fixture('login');factor.context.step='factor';factor.context.totpTicket='factor-ticket';let factorRelease;factor.context.respond=()=>new Promise(resolve=>{factorRelease=resolve;});
 const factorPending=factor.context.completeTotp('000000');await factor.context.completeTotp('000000');assert.equal(factor.calls(),1);factorRelease(new Response('{}',{status:200}));await factorPending;assert.equal(factor.pushes(),1);
 const delay=fixture();assert.equal(delay.context.retryDelay(new Response('',{status:429})),60);assert.equal(delay.context.retryDelay(new Response('',{status:429,headers:{'retry-after':'999999999'}})),86400);
 console.log('PASS actual factor handler rejects concurrent posts and Retry-After is bounded');
 const email=fixture();Object.assign(email.context,{emailRegistration:true,emailRegistrationSupported:true,username:'Native@Example.test',password:'',confirm:'',step:'register-email'});
 email.context.respond=async()=>new Response(JSON.stringify({challenge:'e'.repeat(43),email:'native@example.test',expires_in:1800,retry_after:60}));
 await email.context.submit(event);assert.equal(email.context.lastRequest.url,'/api/auth/register/email/request');assert.equal(JSON.stringify(email.context.lastRequest.body),JSON.stringify({email:'Native@Example.test'}));assert.equal(email.pushes(),0);assert(email.context.registrationEmail);assert(email.shared.get('register-email')>Date.now());
 Object.assign(email.context,{step:'register',registrationCode:'123456',password:'Client-password-123',confirm:'Client-password-123'});
 email.context.respond=async()=>new Response(JSON.stringify({user:{id:'email-user',email:'native@example.test',emailVerified:true,role:'user'}}),{status:201});
 await email.context.submit(event);assert.equal(email.context.lastRequest.url,'/api/auth/register/email/confirm');assert.equal(email.pushes(),1);assert.equal(email.context.lastRequest.body.challenge,'e'.repeat(43));
 console.log('PASS email registration sends no password before verification and only routes after a bound/verified receipt');
 const mismatch=fixture();Object.assign(mismatch.context,{emailRegistration:true,emailRegistrationSupported:true,username:'native@example.test',registrationEmail:{challenge:'e'.repeat(43),email:'native@example.test',expiresAt:Date.now()+60000},registrationCode:'123456'});
 mismatch.context.respond=async()=>new Response(JSON.stringify({user:{id:'email-user',email:'',emailVerified:false,role:'user'}}),{status:201});await mismatch.context.submit(event);assert.equal(mismatch.pushes(),0);assert(mismatch.context.error.includes('邮箱绑定'));
 console.log('PASS unbound email receipt never reports email registration success');
 console.log('5 authentication client suites passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
