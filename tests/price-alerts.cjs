// Disposable SQLite and intercepted transports only; no real mailbox, bot or account mutation.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-price-alerts-'));process.chdir(temp);
process.env.FIRE_APP_ORIGIN='https://account.test.example';process.env.STOCKLOG_FUTU='off';
let now=Date.parse('2026-10-20T14:00:00Z');const originalNow=Date.now;Date.now=()=>now;
global.fetch=async()=>{throw Error('All external transport disabled in isolated test');};
const load=f=>require(path.join(root,f)),auth=load('lib/auth.ts'),native=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb();
const mail=load('lib/mail.ts');mail.mailConfigured=()=>true;const sent=[];mail.sendPriceAlertEmail=async(...args)=>{sent.push(args);};
const quotes=load('lib/quotes.ts');quotes.fetchOverviewQuotes=async()=>({quotes:{},cached:[],pending:false});
const service=load('lib/priceAlerts.ts'),worker=load('lib/priceAlertWorker.ts'),api=load('lib/priceAlertsApi.ts');
let seq=0,passed=0;
function fixture(scope='portfolio.read portfolio.write'){
 const user=auth.createUser('alert_test_'+(++seq),'Alerts-tests-123'),browser=auth.createSession(user.id),verifier=crypto.randomBytes(32).toString('base64url');
 const values={client_id:native.APP_CLIENT_ID,redirect_uri:native.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
 const code=native.issueAppCode(native.parseAppAuthorization(values),user.id,browser),tokens=native.exchangeAppCode({...values,code,code_verifier:verifier});
 return {user,tokens,grant:{id:tokens.grant_id,user_id:user.id}};
}
const rule=()=>({id:crypto.randomUUID(),name:'Fixture',code:'AAPL',market:'US',direction:'above',price:'340.000001',extended:true,frequency:'once',expiresAt:null});
const mutate=(f,body,id=crypto.randomUUID())=>service.mutateAlert(f.grant,id,body,()=>{});
const rows=f=>service.alertDb().prepare('SELECT * FROM price_alert_rules WHERE user_id=?').all(f.user.id);
const quote=(extra={})=>({name:'Fixture',price:340.000001,time:new Date(now).toISOString(),source:'futu',session:'REGULAR',cached:false,...extra});
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();passed++;console.log('PASS '+name);}
(async()=>{
 await test('real App route auth, owner isolation, immutable operation receipts and no financial mutation',async()=>{
  const f=fixture(),other=fixture(),r=rule(),id=crypto.randomUUID();const before=['records','trade_orders','fund_transactions'].map(t=>db.prepare(`SELECT count(*) n FROM ${t}`).get().n);
  const result=mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r},id);assert.equal(result.snapshot.rules[0].status,'enabled');
  assert.throws(()=>mutate(f,{action:'delete',ruleId:r.id,revision:1},id),e=>e.status===409);
  assert.equal(service.alertOperation(f.user.id,id).state,'completed');assert.throws(()=>service.alertOperation(other.user.id,id),e=>e.status===404);
  assert.equal(service.alertSnapshot(other.user.id).rules.length,0);assert.equal(result.snapshot.accountId,f.user.id);
  for(const key of ['market','direction','frequency'])assert.throws(()=>service.parseAlert({...r,[key]:[r[key]]}));
  assert.throws(()=>mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r}),e=>e.status===409);
  assert.deepEqual(['records','trade_orders','fund_transactions'].map(t=>db.prepare(`SELECT count(*) n FROM ${t}`).get().n),before);
  const req=(token,method='GET',body)=>new Request(process.env.FIRE_APP_ORIGIN+'/api/v2/price-alerts',{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await api.priceAlertsResponse(req('bad'),'snapshot')).status,401);
  const read=fixture('portfolio.read');assert.equal((await api.priceAlertsResponse(req(read.tokens.access_token,'POST',{}),'operation',crypto.randomUUID())).status,403);
  const snap=await api.priceAlertsResponse(req(f.tokens.access_token),'snapshot');assert.equal(snap.status,200);assert.equal((await snap.json()).data.rules.length,1);
  mutate(f,{action:'delete',ruleId:r.id,revision:1});
 });
 await test('six-decimal thresholds, real quote time/session, fresh-only and exactly-once event transaction',async()=>{
  const f=fixture(),r=rule();mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r});now+=5000;const row=rows(f)[0];
  assert.equal(service.triggerAlert(row,quote({cached:true})),false);
  assert.equal(service.triggerAlert(row,quote({session:undefined})),false);
  assert.equal(service.triggerAlert(row,quote({time:new Date(now-120000).toISOString()})),false);
  assert.equal(service.triggerAlert(row,quote({source:undefined})),false);assert.equal(service.triggerAlert(row,quote({source:'synthetic'})),false);
  assert.equal(service.triggerAlert(row,quote({price:340})),false);now+=1000;
  assert.equal(service.triggerAlert(rows(f)[0],quote()),true);assert.equal(service.triggerAlert(row,quote()),false);
  const snap=service.alertSnapshot(f.user.id);assert.equal(snap.rules[0].status,'completed');assert.equal(snap.events.length,1);assert.equal(snap.events[0].session,'REGULAR');assert.equal(snap.events[0].deliveries[0].state,'delivered');
 });
 await test('daily period deduplication, actual PRE label and regular-only exclusion',async()=>{
  const f=fixture(),r={...rule(),frequency:'daily',price:'100'};mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r});now+=1000;
  assert.equal(service.triggerAlert(rows(f)[0],quote()),true);now+=1000;assert.equal(service.triggerAlert(rows(f)[0],quote()),false);
  now+=86400000;assert.equal(service.triggerAlert(rows(f)[0],quote()),true);assert.equal(service.alertSnapshot(f.user.id).events.length,2);
  const g=fixture(),p={...rule(),price:'100',extended:false};mutate(g,{action:'upsert',ruleId:p.id,revision:0,rule:p});now=Date.parse('2026-10-22T12:00:00Z');
  assert.equal(service.triggerAlert(rows(g)[0],quote({session:'PRE'})),false);
  mutate(g,{action:'upsert',ruleId:p.id,revision:1,rule:{...p,extended:true}});now+=1000;
  assert.equal(service.triggerAlert(rows(g)[0],quote({session:'PRE'})),true);assert.equal(service.alertSnapshot(g.user.id).events[0].session,'PRE');
 });
 await test('verified mailbox only, provider acceptance, unknown send never retried',async()=>{
  const f=fixture();assert.throws(()=>mutate(f,{action:'channel',channel:'email',enabled:true,revision:0}),e=>e.status===409);
  db.prepare('UPDATE users SET email=? WHERE id=?').run('fixture@example.test',f.user.id);db.prepare('INSERT INTO verified_emails VALUES(?,?,?)').run(f.user.id,'fixture@example.test',now);
  mutate(f,{action:'channel',channel:'email',enabled:true,revision:0});mutate(f,{action:'test',channel:'email'});await worker.priceAlertTick();
  assert.equal(service.alertSnapshot(f.user.id).events[0].deliveries[0].state,'accepted');assert.equal(sent.at(-1)[0],'fixture@example.test');
  let attempts=0;mail.sendPriceAlertEmail=async()=>{attempts++;throw Error('Unknown transport acceptance; do not log secrets');};now+=1000;mutate(f,{action:'test',channel:'email'});await worker.priceAlertTick();await worker.priceAlertTick();
  assert.equal(attempts,1);assert.equal(service.alertSnapshot(f.user.id).events[0].deliveries[0].state,'unknown');
 });
 await test('Telegram deep link proves private recipient, requires explicit confirmation, encrypted binding and replay rejection',async()=>{
  const f=fixture();process.env.ALCOR_TELEGRAM_BOT_TOKEN='123456:'+('x'.repeat(30));process.env.ALCOR_TELEGRAM_BOT_USERNAME='FixtureAlertsBot';
  const link=service.beginTelegram(f.user.id),token=new URL(link.url).searchParams.get('start');
  service.receiveTelegram({message:{text:'/start '+token,from:{id:77,username:'fixture'},chat:{id:77,type:'group'}}});assert.equal(service.channelState(f.user.id)[2].ready,false);
  service.receiveTelegram({message:{text:'/start '+token,from:{id:77,username:'fixture'},chat:{id:77,type:'private'}}});
  assert.equal(service.channelState(f.user.id)[2].pendingConfirmation,true);assert.equal(service.channelState(f.user.id)[2].ready,false);
  mutate(f,{action:'telegram_confirm',revision:1});assert.equal(service.channelState(f.user.id)[2].ready,true);
  service.receiveTelegram({message:{text:'/start '+token,from:{id:88,username:'intruder'},chat:{id:88,type:'private'}}});assert.equal(service.telegramRecipient(f.user.id),'77');
  const secret=db.prepare('SELECT chat_secret FROM price_alert_telegram WHERE user_id=?').get(f.user.id).chat_secret;assert.ok(secret.startsWith('enc:v1:'));assert.notEqual(secret,'77');
  let telegramCalls=0;
  global.fetch=async(url,options)=>{
    assert.equal(new URL(url).host,'api.telegram.org');assert.equal(options.redirect,'error');
    if(url.endsWith('/getUpdates'))return Response.json({ok:true,result:[]});
    const body=JSON.parse(options.body);assert.equal(body.chat_id,'77');telegramCalls++;
    return Response.json({ok:true,result:{message_id:42}});
  };
  mutate(f,{action:'test',channel:'telegram'});await worker.priceAlertTick();
  assert.equal(telegramCalls,1);assert.equal(service.alertSnapshot(f.user.id).events[0].deliveries[0].state,'accepted');
  now+=1000;global.fetch=async url=>{if(typeof url!=='string'||!url.startsWith('https://api.telegram.org/'))throw Error('Unrelated external transport blocked');if(url.endsWith('/getUpdates'))return Response.json({ok:true,result:[]});telegramCalls++;throw Error('timeout');};
  mutate(f,{action:'test',channel:'telegram'});await worker.priceAlertTick();await worker.priceAlertTick();
  assert.equal(telegramCalls,2);assert.equal(service.alertSnapshot(f.user.id).events[0].deliveries[0].state,'unknown');
  global.fetch=async()=>{throw Error('All external transport disabled in isolated test');};
  delete process.env.ALCOR_TELEGRAM_BOT_TOKEN;delete process.env.ALCOR_TELEGRAM_BOT_USERNAME;
 });
 await test('worker consumes only fresh shared-pool quote and records the real trigger',async()=>{
  now=Date.parse('2026-10-22T14:00:00Z');
  const f=fixture(),r=rule();mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r});now+=5000;
  const previous=quotes.fetchOverviewQuotes;
  quotes.fetchOverviewQuotes=async items=>({quotes:Object.fromEntries(items.filter(i=>i.id===f.user.id+':'+r.id).map(i=>[i.id,quote()])),cached:[],pending:false});
  await worker.priceAlertTick();assert.equal(service.alertSnapshot(f.user.id).rules[0].status,'completed');assert.equal(service.alertSnapshot(f.user.id).events[0].session,'REGULAR');
  quotes.fetchOverviewQuotes=previous;
 });
 await test('revocation and expiry stop monitoring; no inferred green state or background financial writes',async()=>{
  const f=fixture(),r=rule();mutate(f,{action:'upsert',ruleId:r.id,revision:0,rule:r});db.prepare('UPDATE app_grants SET revoked_at=? WHERE id=?').run(now,f.grant.id);now+=1000;
  assert.equal(service.triggerAlert(rows(f)[0],quote()),false);await worker.priceAlertTick();assert.equal(rows(f)[0].state,'paused');
  const g=fixture(),s={...rule(),expiresAt:now+1000};mutate(g,{action:'upsert',ruleId:s.id,revision:0,rule:s});now+=2000;await worker.priceAlertTick();assert.equal(rows(g)[0].state,'expired');assert.throws(()=>mutate(g,{action:'state',ruleId:s.id,revision:rows(g)[0].revision,state:'enabled'}),e=>e.status===409);
 });
 console.log(passed+' price alert integration suites passed; no live delivery');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{Date.now=originalNow;fs.rmSync(temp,{recursive:true,force:true});});
