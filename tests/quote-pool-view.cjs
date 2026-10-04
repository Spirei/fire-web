// Real auth and temporary SQLite; dashboard reads must never renew demand or poll a source.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename, load = Module._load;
Module._resolveFilename = function(id,parent,...rest){ return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest); };
require.extensions['.ts'] = (module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
let runtime = [], sourceCalls = 0;
Module._load = function(id,parent,...rest){
  if(parent?.filename===path.join(root,'lib/db.ts') && id==='./dividendSettlement') return {maybeRunDividendSettlement:async()=>{}};
  if(parent?.filename===path.join(root,'lib/quotePoolData.ts') && id==='./quotes') return {readActiveQuotePool:()=>runtime};
  return load.call(this,id,parent,...rest);
};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-pool-view-'));process.chdir(temp);
global.fetch=async()=>{sourceCalls++;throw Error('Network disabled');};
const auth=require(path.join(root,'lib/auth.ts')), db=require(path.join(root,'lib/db.ts')).getDb();
const Store=require(path.join(root,'lib/quoteSubscriptionsStore.ts')).QuoteSubscriptionsStore;
const model=require(path.join(root,'lib/quotePoolView.ts')), route=require(path.join(root,'app/api/quote-pool/route.ts'));
const admin=auth.createUser('pool_admin','Pool-tests-123'), own=auth.createUser('pool_owner','Pool-tests-123'), other=auth.createUser('pool_other','Pool-tests-123');
db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
const adminToken=auth.createSession(admin.id), ownToken=auth.createSession(own.id);
const item=(market,code)=>({id:'private-record',market,code}), store=new Store(db), at=Date.now();
store.touch(own.id,[item('HK','700')],true);store.touch(other.id,[item('US','AAPL')],true);
const request=(scope,token)=>new Request('http://localhost:3000/api/quote-pool'+scope,{headers:token?{cookie:'fire_session='+token}:{}});
const rows=()=>db.prepare('SELECT * FROM quote_subscriptions ORDER BY user_id,market,code').all();
(async()=>{
  assert.equal(route.GET(request('',null)).status,401);
  assert.equal(route.GET(request('?scope=shared',ownToken)).status,403);
  for(const suffix of ['?scope=bad','?scope=mine&scope=shared','?userId=other'])assert.equal(route.GET(request(suffix,adminToken)).status,400);
  const before=rows();
  let reply=route.GET(request('',ownToken));assert.equal(reply.status,200);assert.match(reply.headers.get('cache-control'),/no-store, private/);
  let data=(await reply.json()).data;assert.equal(data.entries.length,1);assert.equal(data.entries[0].code,'00700');assert.equal(data.entries[0].state,'dormant');
  // Another subscriber's activity can heat the shared security, never leak their other symbols.
  runtime=[{market:'HK',code:'00700',lastRequestedAt:at,expiresAt:at+604800000,state:'hot',updating:true},
    {market:'US',code:'MSFT',lastRequestedAt:at,expiresAt:at+604800000,state:'hot',updating:false}];
  data=(await route.GET(request('',ownToken)).json()).data;assert.equal(data.entries.length,1);assert.equal(data.entries[0].state,'hot');
  data=(await route.GET(request('?scope=shared',adminToken)).json()).data;assert.deepEqual(data.entries.map(model.poolKey).sort(),['HK:00700','US:AAPL','US:MSFT']);
  assert(data.entries.every(row=>!('userId'in row)&&!('reads'in row)&&!('namespace'in row)));
  assert.deepEqual(rows(),before);assert.equal(sourceCalls,0);console.log('PASS private ownership, admin shared view, fixed snapshot and zero renewal/source calls');
  const boundary=model.poolView([{item:item('US','AAPL'),requestedAt:at-604800000,reads:2}],runtime,'mine',at);assert.equal(boundary.entries.length,0);
  const candidate=model.poolView([{item:item('CN','600519'),requestedAt:at,reads:1}],[],'mine',at);assert.equal(candidate.entries[0].state,'candidate');
  assert.equal(model.poolQuery(new URLSearchParams('scope=shared&m=garbage&s=bad&p=-1'),false).scope,'mine');
  assert.equal(model.poolQuery(new URLSearchParams('m=HK&s=hot&p=2'),true).market,'HK');
  const routing=require(path.join(root,'lib/workspaceRouting.ts'));
  const tabs=[{key:'global',url:'/global'}], memory=new Map([['quote-pool','/quote-pool?m=HK']]);
  assert.equal(routing.workspaceForPath('/quote-pool',tabs),'quote-pool');
  assert.equal(routing.workspaceDestination('quote-pool',tabs,memory,'tab').url,'/quote-pool?m=HK');
  assert.equal(routing.workspaceDestination('unknown',tabs,memory,'tab'),null);
  const pos=Array.from({length:18},(_,n)=>model.tokenPose('US:SYM'+n,n));assert(pos.every(p=>p.x>=19&&p.x<=81&&p.y>=39&&p.y<=75));
  assert.deepEqual(model.tokenPose('HK:00700',3),model.tokenPose('HK:00700',3));console.log('PASS expiry, candidate state, URL validation and deterministic bounded box positions');
  const Pool=require(path.join(root,'lib/activeQuotePool.ts')).ActiveQuotePool;
  let now=1000,timers=0,reads=0;
  const pool=new Pool({now:()=>now,currentNamespace:()=> 'public',policy:()=>({intervalMs:5000,phase:'REGULAR'}),refresh:async()=>{reads++;return{};},setTimer:()=>{timers++;return{unref(){}};},clearTimer:()=>{}});
  pool.observe([item('US','AAPL')],'public');pool.observe([item('US','AAPL')],'public');
  const armed=timers;assert.equal(pool.snapshot('public')[0].state,'hot');now+=90000;assert.equal(pool.snapshot('public')[0].state,'dormant');
  now+=604800000;assert.equal(pool.snapshot('public').length,0);assert.equal(pool.snapshot('changed').length,0);assert.equal(timers,armed);assert.equal(reads,0);pool.dispose();
  console.log('PASS observer snapshots do not schedule, renew, revive expired or expose a stale namespace');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
