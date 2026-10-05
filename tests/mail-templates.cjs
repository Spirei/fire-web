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



const model=load('lib/mailTemplateModel.ts'), templates=load('lib/mailTemplates.ts'), settingsRoute=load('app/api/settings/mail-templates/route.ts'), previewRoute=load('app/api/settings/mail-templates/preview/route.ts');
function web(f,body,method='PUT',source=origin){return new Request(origin+'/api/settings/mail-templates',{method,headers:{cookie:'fire_session='+f.browser,origin:source,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
(async()=>{
 await test('admin-only edits and pure previews enforce origin and reject executable or unknown settings',async()=>{
  const admin=fixture(false,true), ordinary=fixture();
  const template={...model.DEFAULT_MAIL_TEMPLATES[0],title:'自定义邮箱验证'};
  assert.equal((await settingsRoute.GET(web(ordinary,undefined,'GET'))).status,403);
  assert.equal((await settingsRoute.PUT(web(ordinary,template))).status,403);
  assert.equal((await settingsRoute.PUT(web(admin,template,'PUT','https://evil.example'))).status,403);
  assert.equal((await settingsRoute.PUT(web(admin,{...template,html:'<script>evil</script>'}))).status,400);
  assert.equal((await settingsRoute.PUT(web(admin,template))).status,200);assert.equal(templates.readMailTemplates()[0].title,template.title);
  const before=db.prepare('SELECT COUNT(*) n FROM app_account_changes').get().n;
  const preview=await previewRoute.POST(web(admin,template,'POST'));assert.equal(preview.status,200);const rendered=await preview.json();assert(rendered.html.includes('593255'));assert(rendered.text.includes('30 分钟'));assert.equal(db.prepare('SELECT COUNT(*) n FROM app_account_changes').get().n,before);assert.equal(preview.headers.get('Cache-Control'),'private, no-store');
  const original=bodies.readJsonBody;bodies.readJsonBody=async(...args)=>{const b=await original(...args);auth.deleteSession(admin.browser);return b;};try{assert.equal((await settingsRoute.PUT(web(admin,template))).status,403);}finally{bodies.readJsonBody=original;}
 });
 await test('template slots escape values, preserve code and link contracts, and public App read never exposes SMTP',async()=>{
  for(const template of model.DEFAULT_MAIL_TEMPLATES){
   const output=templates.renderMailTemplate({...template,greeting:'<script>alert(1)</script>'},{email:'client@example.com',siteName:'Alcor',minutes:30,code:'012345',url:'https://safe.example/verify-email?token=fixture',nativeToken:template.kind==='link'?'fixture-token':undefined});
   assert(!output.html.includes('<script>'));assert(output.html.includes('&lt;script&gt;'));
   if(template.kind==='code'){assert(output.html.includes('012345'));assert(!output.html.includes('/verify-email'));}
   if(template.kind==='link'){assert(output.html.includes('https://safe.example'));assert(output.text.includes('fixture-token'));}
  }
  assert.throws(()=>templates.renderMailTemplate(model.DEFAULT_MAIL_TEMPLATES[2],{email:'a@example.com',siteName:'Alcor',minutes:30,url:'javascript:evil()'}));
  const response=await load('app/api/v2/auth/mail-templates/route.ts').GET(new Request(origin+'/api/v2/auth/mail-templates'));
  const data=(await response.json()).data;assert.equal(response.status,200);assert.equal(data.templates.length,4);assert(!JSON.stringify(data).includes('smtpPassword'));
 });
 await test('all real senders use the saved renderer and embed banner without remote fetching',async()=>{
  const mailer=load('node_modules/nodemailer').default || load('node_modules/nodemailer'), original=mailer.createTransport, sent=[];
  process.env.SMTP_HOST='smtp.example.test';process.env.SMTP_FROM_EMAIL='sender@example.test';mailer.createTransport=()=>({sendMail:async message=>sent.push(message)});
  // Earlier shared security fixture installs an SMTP stub; restore real new-code sender for this test.
  delete require.cache[require.resolve(path.join(root,'lib/mail.ts'))];const realMail=load('lib/mail.ts');
  try{
   await realMail.sendPasswordResetEmail({to:'reset@example.test',name:'Customer',code:'123456',minutes:30});
   await realMail.sendEmailVerification('verify@example.test','https://safe.example/verify-email?token=fixture',undefined,'fixture-token');
   await realMail.sendAccountEmailChangeCode('change@example.test','234567',mailBudget.reserveMailAttempt('change@example.test','verification'));
   await realMail.sendTestEmail('test@example.test');
   assert.equal(sent.length,4);for(const message of sent){assert(message.html.includes('cid:alcor-mail-banner'));assert(message.attachments[0].content.length>1000);assert(!message.html.includes('https://fire.'));}
   assert(sent[0].text.includes('30 分钟'));assert(sent[2].text.includes('30 分钟'));
  }finally{mailer.createTransport=original;}
 });
 await test('email code remains valid at minute 29, expires at minute 30, and resulting proof lasts five minutes',async()=>{
  const f=fixture();db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,row(f.user.id).email,Date.now());
  const started=Date.now(), issued=reset.issuePasswordResetCode(f.user.id);assert.equal(reset.PASSWORD_RESET_MINUTES,30);
  const oldNow=Date.now;
  try{Date.now=()=>started+29*60_000;const verified=reset.verifyPasswordResetCode(issued.challenge,issued.code);assert(verified);assert.equal(verified.expiresAt-Date.now(),5*60_000);}finally{Date.now=oldNow;}
  db.prepare('DELETE FROM password_reset_codes WHERE user_id=?').run(f.user.id);const expired=reset.issuePasswordResetCode(f.user.id);
  try{Date.now=()=>started+30*60_000+1000;assert.equal(reset.verifyPasswordResetCode(expired.challenge,expired.code),null);}finally{Date.now=oldNow;}
 });
 await test('latest uploaded website logo updates SMTP, previews and App banner without restarting',async()=>{
  const branding=load('lib/mailBranding.ts'), route=load('app/api/system-assets/mail-banner/route.ts');
  const setLogo=value=>db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('siteLogo',value);
  fs.mkdirSync('public/uploads/logo',{recursive:true});
  const artwork=color=>`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><rect width="320" height="80" fill="${color}"/></svg>`;
  fs.writeFileSync('public/uploads/logo/first.svg',artwork('#ff0000'));setLogo('/uploads/logo/first.svg');
  const first=await branding.mailBrandBanner();assert.equal((await templates.mailBannerAttachment()).content.compare(first),0);
  fs.writeFileSync('public/uploads/logo/latest.svg',artwork('#0000ff'));setLogo('/uploads/logo/latest.svg');
  const latest=await branding.mailBrandBanner();assert(!first.equals(latest),'saved new upload cannot reuse the old banner');
  const image=await route.GET();assert.equal(image.headers.get('Cache-Control'),'no-store');assert(Buffer.from(await image.arrayBuffer()).equals(latest));
  const admin=fixture(false,true), rendered=await (await previewRoute.POST(web(admin,model.DEFAULT_MAIL_TEMPLATES[0],'POST'))).json();
  assert(rendered.html.includes(`data:image/png;base64,${latest.toString('base64')}`),'preview must use the same current brand snapshot');
  const sharp=load('node_modules/sharp'), pixels=await sharp(latest).raw().toBuffer({resolveWithObject:true});
  const pixel=(x,y)=>{const i=(y*pixels.info.width+x)*pixels.info.channels;return Array.from(pixels.data.subarray(i,i+3));};
  assert.deepEqual(pixel(100,140),[0,0,255]);assert.notDeepEqual(pixel(100,80),[0,0,255],'wide logo keeps its aspect ratio');
  fs.writeFileSync('public/uploads/logo/latest.svg',artwork('#00ff00'));assert(!(await branding.mailBrandBanner()).equals(latest),'replacing the same path also invalidates cached artwork');
  for(const source of ['/uploads/logo/../../data/fire.db','/uploads/logo/%2e%2e%2fsecret','https://private.example/logo.png']){setLogo(source);assert((await branding.mailBrandBanner()).length>1000);}
 });
 console.log(`PASS ${count} mail template groups`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
