// Disposable native PostgreSQL cluster. Never reads runtime credentials or the business database.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),{spawnSync}=require('node:child_process'),net=require('node:net'),{Pool}=require('pg');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-search-history-')),resolve=Module._resolveFilename,load=Module._load;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const {parseSearchMutation,normalizeSearchQuery}=require('../lib/searchHistory.ts'),{createSearchHistoryStore}=require('../lib/searchHistoryStore.ts');
let pool,store,started=false,externalConfig,schema,passed=0,authUser={id:'alice'},revoked=false;
class Unavailable extends Error{};
Module._load=function(id,parent,...rest){if(parent?.filename.endsWith('/app/api/auth/search-history/route.ts')){
 if(id==='@/lib/auth')return{getAuthUser:()=>revoked?null:authUser,isTrustedMutationRequest:r=>r.headers.get('origin')==='https://history.example.test'};
 if(id==='@/lib/searchHistoryRuntime')return{searchHistoryRuntime:async()=>{if(!store)throw new Unavailable('搜索历史尚未接入 PostgreSQL');return store;},SearchHistoryUnavailable:Unavailable};
 if(id==='@/lib/rateLimit')return{rateLimit:()=>true};
}return load.call(this,id,parent,...rest);};
const route=require('../app/api/auth/search-history/route.ts');
const run=(bin,args)=>{const result=spawnSync(path.join(process.env.ALCOR_SEARCH_PG_BIN,bin),args,{encoding:'utf8'});if(result.status!==0)throw Error(bin+' failed: '+result.stderr);};
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
async function call(method='GET',body,headers={}){return route[method](new Request('https://history.example.test/api/auth/search-history',{method,headers:{origin:'https://history.example.test','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));}
(async()=>{
 await test('bounded completed queries and strict mutation fields',()=>{assert.equal(normalizeSearchQuery('  ＰＧ   搜索  '),'PG 搜索');assert.equal(normalizeSearchQuery('x'.repeat(81)),'');assert.equal(parseSearchMutation({action:'clear',revision:0,ownerId:'bob'}),null);assert.equal(parseSearchMutation({action:'clear',revision:-1}),null);});
 await test('unavailable PG is explicit and never falls back to browser or SQLite',async()=>{const r=await call();assert.equal(r.status,503);assert.equal((await r.json()).available,false);});
 if(process.env.ALCOR_PG_TEST_CONFIG){
   externalConfig=JSON.parse(fs.readFileSync(process.env.ALCOR_PG_TEST_CONFIG,'utf8'));
   assert(/^alcor_cutover_test_[a-f0-9]+$/.test(externalConfig.database),'Only disposable test databases are allowed');
   assert(['localhost','127.0.0.1'].includes(externalConfig.host),'Test PG must be loopback');
   schema='search_history_test_'+require('node:crypto').randomBytes(8).toString('hex');
   const admin=new Pool({...externalConfig,max:1});try{await admin.query('CREATE SCHEMA '+schema);}finally{await admin.end();}
   pool=new Pool({...externalConfig,max:4,options:'-c search_path='+schema+',pg_catalog'});
 }else{
   assert(process.env.ALCOR_SEARCH_PG_BIN,'Set ALCOR_SEARCH_PG_BIN for a temporary cluster, or ALCOR_PG_TEST_CONFIG for disposable CI PG');
   const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
   run('initdb',['-D',path.join(temp,'cluster'),'-U','history_test','--auth=trust','--no-locale','--encoding=UTF8']);
   run('pg_ctl',['-D',path.join(temp,'cluster'),'-l',path.join(temp,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${temp}`,'-w','start']);started=true;
   pool=new Pool({host:'127.0.0.1',port,user:'history_test',database:'postgres',max:4});
 }
 await pool.query("CREATE TABLE users(id text PRIMARY KEY);INSERT INTO users VALUES('alice'),('bob')");
 store=createSearchHistoryStore(pool);
 await test('two server initializers share one native schema lock',async()=>{const second=createSearchHistoryStore(pool);const both=await Promise.all([store.access('alice'),second.access('bob')]);assert(both.every(h=>h.revision===0&&h.items.length===0));});
 await test('native PG save, deduplicate, latest first and per-user isolation',async()=>{let a=await store.access('alice');assert.equal(a.items.length,0);a=await store.access('alice',{action:'record',query:'外观',revision:a.revision});a=await store.access('alice',{action:'record',query:'PostgreSQL',revision:a.revision});a=await store.access('alice',{action:'record',query:'postgresql',revision:a.revision});assert.equal(a.items.length,2);assert.equal(a.items[0].query,'postgresql');assert.equal((await store.access('bob')).items.length,0);});
 await test('keep last twenty without deleting anyone else',async()=>{let a=await store.access('alice'),b=await store.access('bob');await store.access('bob',{action:'record',query:'other',revision:b.revision});for(let i=0;i<23;i++)a=await store.access('alice',{action:'record',query:'item '+i,revision:a.revision});assert.equal(a.items.length,20);assert.equal(a.items[0].query,'item 22');assert.equal((await store.access('bob')).items.length,1);});
 await test('single delete cannot remove another owner entry',async()=>{let a=await store.access('alice'),b=await store.access('bob');a=await store.access('alice',{action:'remove',id:b.items[0].id,revision:a.revision});assert.equal(a.items.length,20);assert.equal((await store.access('bob')).items.length,1);a=await store.access('alice',{action:'remove',id:a.items[0].id,revision:a.revision});assert.equal(a.items.length,19);});
 await test('clear invalidates delayed records instead of resurrecting history',async()=>{let a=await store.access('alice'),old=a.revision;a=await store.access('alice',{action:'clear',revision:old});assert.equal(a.items.length,0);const stale=await store.access('alice',{action:'record',query:'delayed',revision:old});assert(stale.conflict);assert.equal(stale.items.length,0);assert.equal((await store.access('bob')).items.length,1);});
 await test('two devices at the same revision have one atomic winner',async()=>{const a=await store.access('alice');const both=await Promise.all(['one','two'].map(query=>store.access('alice',{action:'record',query,revision:a.revision})));assert.equal(both.filter(x=>x.conflict).length,1);assert.equal((await store.access('alice')).items.length,1);});
 await test('authorization lost while waiting rolls back writes',async()=>{const a=await store.access('alice');await assert.rejects(()=>store.access('alice',{action:'clear',revision:a.revision},()=>{throw Error('revoked');}),/revoked/);assert.deepEqual((await store.access('alice')).items,a.items);});
 await test('route cookies, CSRF, strict body, private cache and revision conflict',async()=>{let r=await call();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');let a=await r.json();r=await call('POST',{action:'record',query:'SQL \' ; --',revision:a.revision});assert.equal(r.status,200);r=await call('DELETE',{action:'clear',revision:a.revision});assert.equal(r.status,409);r=await call('DELETE',{action:'clear',revision:0,userId:'bob'});assert.equal(r.status,400);r=await call('DELETE',{action:'clear',revision:0},{origin:'https://outside.example.test'});assert.equal(r.status,403);r=await call('GET',undefined,{authorization:'Bearer unsupported'});assert.equal(r.status,401);authUser=null;assert.equal((await call()).status,401);authUser={id:'alice'};});
 await test('owner deletion cascades only their search data',async()=>{await pool.query("DELETE FROM users WHERE id='alice'");assert.equal((await pool.query("SELECT count(*)::int AS n FROM user_search_history WHERE user_id='alice'")).rows[0].n,0);assert.equal((await store.access('bob')).items.length,1);});
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(pool)await pool.end();if(externalConfig&&schema){const admin=new Pool({...externalConfig,max:1});try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}finally{await admin.end();}}if(started)run('pg_ctl',['-D',path.join(temp,'cluster'),'-m','fast','-w','stop']);fs.rmSync(temp,{recursive:true,force:true});console.log(passed+' search history checks passed');});
