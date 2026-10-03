// Real handlers and SQLite, never the user's database or network.
const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const crypto=require('node:crypto'), Module=require('node:module'), ts=require('typescript');
const root=path.resolve(__dirname,'..'), resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-records-'));process.chdir(temp);
process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://records.example.test';
global.fetch=async()=>{throw Error('Network disabled');};
const load=file=>require(path.join(root,file)), auth=load('lib/auth.ts'), app=load('lib/appAuth.ts'), db=load('lib/db.ts').getDb();
const store=load('lib/store.ts'), contract=load('lib/recordsContract.ts'), bodies=load('lib/requestBody.ts');
const origin=process.env.FIRE_APP_ORIGIN, input={name:'测试',code:'TEST',market:'US',price:10,cost:8,qty:2,group:'测试券商',note:'',source:'app'};
let count=0,index=0;
const key=()=>crypto.randomUUID();
function fixture(scope='portfolio.read portfolio.write'){
 const user=auth.createUser('record_owner_'+(++index),'Records-test-123'), cookie=auth.createSession(user.id);
 const verifier=crypto.randomBytes(32).toString('base64url'),values={client_id:app.APP_CLIENT_ID,redirect_uri:app.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
 const code=app.issueAppCode(app.parseAppAuthorization(values),user.id,cookie),grant=app.exchangeAppCode({...values,code,code_verifier:verifier});
 return{user,cookie,grant};
}
function req(v,tail,method,f,body,headers={}){return new Request(origin+`/api/v${v}/records`+tail,{method,headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
async function call(v,tail,method,f,body,headers={}){
 const operation=tail.startsWith('/operations/'),file=operation?'records/operations/[requestId]':tail?'records/[id]':'records';
 const handler=load(`app/api/v${v}/${file}/route.ts`),params=Promise.resolve(operation?{requestId:tail.split('/')[2]}:{id:tail.slice(1)});
 const res=await handler[method](req(v,tail,method,f,body,headers),{params});return{status:res.status,headers:res.headers,body:await res.json()};
}
const create=(v,f,body={})=>call(v,'','POST',f,{...input,requestId:key(),...body});
const readOp=(v,f,id)=>call(v,'/operations/'+id,'GET',f);
const dump=()=>Object.fromEntries(['records','activities','record_revisions','record_collections','record_operations'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('discovery freezes selected-version paths and keeps old grants/default scopes',async()=>{
  const f=fixture();
  db.prepare('UPDATE app_grants SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',f.grant.grant_id);
  for(const v of [1,2]){
   const res=await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(origin+`/api/v${v}/auth/config`)),d=(await res.json()).data;
   assert.equal(d.scope,'portfolio.read portfolio.write');assert.equal(d.records_contract.version,1);
   for(const field of ['records_path','record_path','operation_path','search_path'])assert(d.records_contract[field].startsWith(`/api/v${v}/`));
   assert.equal(d.records_contract.automatic_mutation_replay,false);assert.equal((await create(v,f)).status,200);
  }
 });
 await test('legacy input/envelopes stay compatible while both versions return the same owned revision',async()=>{
  const f=fixture();
  for(const v of [1,2]){
   const res=await call(v,'','POST',f,input);assert.equal(res.status,200);assert(!res.body.meta);const record=res.body.data;assert.equal(record.revision,1);
   assert.deepEqual((await call(3-v,'/'+record.id,'GET',f)).body.data,record);
   const updated=await call(v,'/'+record.id,'PUT',f,{...input,qty:3});assert.equal(updated.body.data.revision,2);
   const deleted=await call(v,'/'+record.id,'DELETE',f);assert.deepEqual(deleted.body.data,{deleted:true});
  }
 });
 await test('duplicate request IDs converge across versions/concurrent requests without replay or duplicate activity',async()=>{
  const f=fixture(),requestId=key();const replies=await Promise.all([create(1,f,{requestId}),create(2,f,{requestId})]);
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);const saved=replies.find(r=>r.status===200).body;
  assert.equal(saved.meta.requestId,requestId);assert.equal(saved.meta.kind,'create');assert.equal(saved.meta.recordId,saved.data.id);
  assert.equal(store.listRecords(f.user.id).length,1);assert.equal(db.prepare('SELECT count(*) n FROM activities WHERE user_id=?').get(f.user.id).n,1);
  const op=(await readOp(2,f,requestId)).body.data;assert.equal(op.state,'completed');assert.equal(op.code,0);assert.deepEqual(op.record,saved.data);
  assert.equal((await create(1,f,{requestId,name:'不同载荷'})).body.code,40901);assert.deepEqual((await readOp(1,f,requestId)).body.data,op);
 });
 await test('one concurrent revision update wins; later read query confirms both success and conflict without writes',async()=>{
  const f=fixture(),record=(await create(2,f)).body.data,keys=[key(),key()];
  const replies=await Promise.all(keys.map((requestId,i)=>call(i+1,'/'+record.id,'PUT',f,{...input,qty:3+i,revision:record.revision,requestId})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal(store.readRecord(f.user.id,record.id).revision,2);
  for(let i=0;i<2;i++){
   const before=dump(),op=(await readOp(3-(i+1),f,keys[i])).body.data;assert.deepEqual(dump(),before);
   assert.equal(op.state,replies[i].status===200?'completed':'failed');assert.equal(op.code,replies[i].status===200?0:40902);
  }
 });
 await test('delete is confirmed once, records stay absent, history receipts do not become latest snapshots',async()=>{
  const f=fixture(),created=await create(1,f),record=created.body.data,requestId=key();
  const response=await call(2,'/'+record.id,'DELETE',f,{revision:record.revision,requestId});assert.equal(response.status,200);
  assert.deepEqual(response.body.data,{deleted:true,id:record.id,revision:record.revision});assert.equal(response.body.meta.kind,'delete');
  assert.equal((await call(1,'/'+record.id,'DELETE',f,{revision:record.revision,requestId})).body.code,40901);
  assert.equal((await readOp(1,f,requestId)).body.data.deleted,true);assert.equal((await call(2,'/'+record.id,'GET',f)).status,404);
  assert.deepEqual((await readOp(2,f,created.body.meta.requestId)).body.data.record,record);
 });
 await test('all reads/operations are owner-isolated and old readonly grants receive 403 without Cookie escalation',async()=>{
  const f=fixture(),other=fixture(),readonly=fixture('portfolio.read'),created=await create(2,f),r=created.body.data;
  for(const v of [1,2]){
   assert.equal((await call(v,'/'+r.id,'GET',other)).status,404);assert.equal((await readOp(v,other,created.body.meta.requestId)).status,404);
   assert.equal((await call(v,'/'+r.id,'PUT',other,{...input,revision:r.revision,requestId:key()})).status,404);
   assert.equal((await create(v,readonly,{}, {cookie:'fire_session='+f.cookie})).status,403);
   const res=await load(`app/api/v${v}/records/route.ts`).POST(new Request(origin+`/api/v${v}/records`,{method:'POST',headers:{authorization:'Bearer '+readonly.grant.access_token,cookie:'fire_session='+f.cookie,'content-type':'application/json'},body:JSON.stringify(input)}));assert.equal(res.status,403);
  }
  assert.equal(store.listRecords(readonly.user.id).length,0);assert(app.authenticateAppAccess(readonly.grant.access_token,req(1,'','GET',readonly)));
  assert.equal((await create(1,other,{requestId:created.body.meta.requestId})).status,200,'keys are account scoped');
 });
 await test('pagination snapshots reject collection changes instead of mixing stale pages',async()=>{
  const f=fixture();for(let i=0;i<105;i++)store.createRecord(f.user.id,{...input,code:'TEST'+i});
  const first=await call(2,'','GET',f);assert.equal(first.body.meta.total,105);assert.equal(first.body.meta.collectionRevision,105);
  const route=load('app/api/v1/records/route.ts'),read=async revision=>{const res=await route.GET(new Request(origin+'/api/v1/records?page=2&pageSize=100&collectionRevision='+revision,{headers:{authorization:'Bearer '+f.grant.access_token}}));return{status:res.status,body:await res.json()};};
  assert.equal((await read(105)).body.data.length,5);store.createRecord(f.user.id,input);assert.equal((await read(105)).body.code,40902);assert.equal((await read('NaN')).status,400);
 });
 await test('group assignment, direct order-style updates and delete/reimport advance persisted revisions',async()=>{
  const f=fixture(),record=(await create(1,f)).body.data,groups=load('lib/watchGroupsStore.ts'),g=groups.createWatchGroup(f.user.id,'自选');
  groups.assignRecordsGroup(f.user.id,[record.id],g.id);assert.equal(store.readRecord(f.user.id,record.id).revision,2);
  db.prepare('UPDATE records SET qty=?,cost=? WHERE id=?').run(3,9,record.id);assert.equal(store.readRecord(f.user.id,record.id).revision,3);
  assert.equal((await call(2,'/'+record.id,'PUT',f,{...input,revision:record.revision,requestId:key()})).body.code,40902);
  const row=db.prepare('SELECT * FROM records WHERE id=?').get(record.id);db.prepare('DELETE FROM records WHERE id=?').run(record.id);
  const cols=Object.keys(row);db.prepare(`INSERT INTO records(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(k=>row[k]));
  assert.equal(store.readRecord(f.user.id,record.id).revision,5);assert.equal(contract.collectionRevision(f.user.id),5);
  load('lib/recordsSchema.ts').installRecordsContract(db);assert.equal(store.readRecord(f.user.id,record.id).revision,5,'migration restart does not reset versions');
 });
 await test('new group writes validate ownership and omission preserves group; securities search cannot register global catalog',async()=>{
  const f=fixture(),other=fixture(),groups=load('lib/watchGroupsStore.ts'),g=groups.createWatchGroup(f.user.id,'本人'),foreign=groups.createWatchGroup(other.user.id,'其他');
  const assetsBefore=db.prepare('SELECT * FROM assets').all();assert.equal((await create(2,f,{watchGroupId:foreign.id})).status,404);
  const r=(await create(2,f,{watchGroupId:g.id})).body.data;assert.equal(r.watchGroupId,g.id);
  const edited=(await call(1,'/'+r.id,'PUT',f,{...input,revision:r.revision,requestId:key()})).body.data;assert.equal(edited.watchGroupId,g.id);
  assert.deepEqual(db.prepare('SELECT * FROM assets').all(),assetsBefore);
  assert.equal(load('lib/appApiV2Policy.ts').appV2Access('/api/v2/search','GET'),'public');
 });
 await test('real trades/imports advance versions and deleting ledger-backed positions preserves history',async()=>{
  const f=fixture(),r=(await create(2,f)).body.data,orders=load('lib/orders.ts');
  const trade=orders.executeOrder({userId:f.user.id,recordId:r.id,side:'buy',qty:1,price:10,fees:0});
  const current=store.readRecord(f.user.id,r.id);assert.equal(current.revision,2);assert.equal(current.qty,3);
  const requestId=key(),res=await call(1,'/'+r.id,'DELETE',f,{revision:current.revision,requestId});assert.equal(res.body.code,40903);
  assert.equal((await readOp(2,f,requestId)).body.data.code,40903);assert(db.prepare('SELECT 1 FROM trade_orders WHERE id=?').get(trade.order.id));assert.deepEqual(store.readRecord(f.user.id,r.id),current);
  const importer=load('lib/importSnapshot.ts'),preview=importer.buildImportPreview(f.user.id,[{name:input.name,code:input.code,market:'US',qty:4,price:11,cost:9}]);
  importer.applyImport(f.user.id,preview);assert(store.readRecord(f.user.id,r.id).revision>current.revision);
 });
 await test('bad/missing revisions, unknown or oversized fields and malformed DELETE cannot degrade to a legacy write',async()=>{
  const f=fixture(),r=(await create(1,f)).body.data,before=dump();
  for(const revision of [undefined,0,-1,'1',1.5])assert.equal((await call(2,'/'+r.id,'DELETE',f,{requestId:key(),revision})).status,400);
  for(const extra of [{price:'bad'},{qty:-1},{name:'x'.repeat(101)},{watchGroupId:12},{userId:f.user.id},{requestId:'UPPER'}])assert.equal((await create(1,f,extra)).status,400);
  const route=load('app/api/v1/records/[id]/route.ts'),res=await route.DELETE(new Request(origin+'/api/v1/records/'+r.id,{method:'DELETE',headers:{authorization:'Bearer '+f.grant.access_token,'content-type':'application/json'},body:'{' }),{params:Promise.resolve({id:r.id})});assert.equal(res.status,400);
  assert.deepEqual(dump(),before);
 });
 await test('an aborted transaction rolls back records, versions, activity and receipt; internal diagnostics stay private',async()=>{
  const f=fixture(),requestId=key(),before=dump();db.exec("CREATE TEMP TRIGGER records_fail BEFORE INSERT ON record_operations BEGIN SELECT RAISE(ABORT,'private SQL error'); END");
  try{const res=await create(2,f,{requestId});assert.equal(res.status,500);assert(!JSON.stringify(res.body).includes('private SQL'));}finally{db.exec('DROP TRIGGER records_fail');}
  assert.deepEqual(dump(),before);assert.equal((await readOp(1,f,requestId)).status,404);
 });
 await test('revocation during async input or params prevents every write/read and cannot fall back to Cookie',async()=>{
  for(const v of [1,2]){
   const f=fixture(),before=dump(),read=bodies.readJsonBody;
   bodies.readJsonBody=async(...args)=>{const body=await read(...args);app.revokeAppGrant(f.grant.grant_id);return body;};
   try{assert.equal((await create(v,f)).status,401);}finally{bodies.readJsonBody=read;}
   assert.deepEqual(dump(),before);assert(auth.getUserByToken(f.cookie));
   const fresh=fixture(),r=(await create(v,fresh)).body.data,route=load(`app/api/v${v}/records/[id]/route.ts`);
   const res=await route.DELETE(req(v,'/'+r.id,'DELETE',fresh,undefined,{cookie:'fire_session='+fresh.cookie}),{params:Promise.resolve().then(()=>{app.revokeAppGrant(fresh.grant.grant_id);return{id:r.id};})});assert.equal(res.status,401);assert(store.readRecord(fresh.user.id,r.id));
  }
 });
 await test('Web reads are private same-account snapshots and legacy editing can use revision CAS',async()=>{
  const f=fixture(),r=(await create(2,f)).body.data,list=load('app/api/records/route.ts'),one=load('app/api/records/[id]/route.ts');
  const headers={cookie:'fire_session='+f.cookie,'content-type':'application/json'},res=await list.GET(new Request(origin+'/api/records',{headers}));assert.equal(res.headers.get('X-Alcor-Account-Id'),f.user.id);assert.match(res.headers.get('cache-control'),/no-store/);assert.deepEqual(await res.json(),store.listRecords(f.user.id));
  store.updateRecord(r.id,f.user.id,{...input,qty:10});const response=await one.PUT(new Request(origin+'/api/records/'+r.id,{method:'PUT',headers,body:JSON.stringify({...input,revision:r.revision})}),{params:Promise.resolve({id:r.id})});assert.equal(response.status,409);assert.equal(store.readRecord(f.user.id,r.id).qty,10);
 });
 await test('receipt tracking cascades on account deletion without trigger resurrection',async()=>{
  const f=fixture();await create(2,f);assert(auth.deleteUserById(f.user.id));for(const table of ['records','record_operations','record_revisions','record_collections'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(f.user.id).n,0);
 });
 console.log(`PASS ${count} records contract suites`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
