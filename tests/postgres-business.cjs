// Uses a disposable PostgreSQL database only. No production account, financial data or remote quote writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const config=JSON.parse(fs.readFileSync(process.env.ALCOR_PG_TEST_CONFIG||'/tmp/alcor-pg-cutover-test.json','utf8'));
assert(/^alcor_cutover_test_[a-f0-9]+$/.test(config.database),'Only disposable test databases are allowed');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-pg-business-'));process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.FIRE_APP_ORIGIN='https://postgres.example.test';global.fetch=async()=>{throw Error('External network disabled');};
const load=f=>require(path.join(root,f)),database=load('lib/db.ts'),auth=load('lib/auth.ts'),app=load('lib/appAuth.ts'),store=load('lib/store.ts'),orders=load('lib/orders.ts'),funds=load('lib/funds.ts');
const sqlite=database.getDb(),{PostgresDatabase}=load('lib/postgresDatabase.ts'),{migrateBusinessDatabase}=load('lib/postgresMigration.ts'),pg=new PostgresDatabase(config);
let passed=0;
const test=async(name,fn)=>{await fn();console.log('PASS '+name);passed++;};
const originalGetDb=database.getDb;
let fixture,record,originalOrder,nativeGrant;
(async()=>{
 pg.raw('DROP SCHEMA IF EXISTS ledger CASCADE;CREATE SCHEMA ledger');
 fixture=auth.createUser('pg_owner_fixture','Fixture-12345'),record=store.createRecord(fixture.id,{name:'Synthetic',code:'TEST',market:'US',qty:10,cost:5,price:10,group:'Fixture',note:''});
 load('lib/feedStore.ts').feedTables();load('lib/priceAlertsSchema.ts').installPriceAlerts(sqlite);load('lib/resourceLibrary.ts').resourceUsage(fixture.id);
 funds.createFundTransaction({userId:fixture.id,currency:'USD',type:'opening',amount:1000,direction:1});
 originalOrder=orders.executeOrder({userId:fixture.id,recordId:record.id,side:'buy',qty:2,price:10,fees:1,tradedAt:'2026-10-20T14:30:00.000Z'});
 sqlite.prepare("UPDATE records SET price='' WHERE id='seed-600519'").run();
 const countBefore=sqlite.prepare('SELECT count(*) n FROM trade_orders').get().n;
 // Match the previously written seed: a minimal identity table, existing order rows and separate private evidence.
 pg.raw('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL,nickname TEXT,created_at TEXT NOT NULL);CREATE TABLE records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,UNIQUE(user_id,id))');
 for(const u of sqlite.prepare('SELECT id,username,nickname,created_at FROM users').all())pg.raw('INSERT INTO users VALUES($1,$2,$3,$4)',[u.id,u.username,u.nickname,u.created_at]);
 for(const r of sqlite.prepare('SELECT id,user_id FROM records').all())pg.raw('INSERT INTO records(id,user_id) VALUES($1,$2)',[r.id,r.user_id]);
 pg.raw(load('lib/postgresSql.ts').postgresSql(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='trade_orders'").get().sql).replace(/ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED/g,'ON DELETE RESTRICT'));
 const original=sqlite.prepare('SELECT * FROM trade_orders').all();for(const row of original){const keys=Object.keys(row);pg.raw('INSERT INTO trade_orders('+keys.join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',keys.map(k=>row[k]));}
 pg.raw('CREATE TABLE migration_batches(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));CREATE TABLE source_rows(id TEXT PRIMARY KEY,batch_id TEXT REFERENCES migration_batches(id));CREATE TABLE source_documents(id TEXT PRIMARY KEY,batch_id TEXT REFERENCES migration_batches(id),user_id TEXT REFERENCES users(id));CREATE TABLE historical_events(id TEXT PRIMARY KEY,batch_id TEXT REFERENCES migration_batches(id),user_id TEXT REFERENCES users(id),record_id TEXT,FOREIGN KEY(user_id,record_id) REFERENCES records(user_id,id));CREATE TABLE reconciliation_issues(id TEXT PRIMARY KEY,batch_id TEXT REFERENCES migration_batches(id),user_id TEXT REFERENCES users(id))');
 pg.raw("INSERT INTO migration_batches VALUES('native-seed',$1)",[fixture.id]);pg.raw("INSERT INTO source_rows VALUES('evidence','native-seed')");
 for(const table of ['source_documents','reconciliation_issues'])pg.raw('INSERT INTO '+table+" VALUES('evidence','native-seed',$1)",[fixture.id]);pg.raw("INSERT INTO historical_events VALUES('evidence','native-seed',$1,$2)",[fixture.id,record.id]);
 await test('migrate complete source schema, exact Excel-style order rows, quantities, cash and receipts',()=>{
  const receipt=migrateBusinessDatabase(sqlite,pg,'isolated-integration');assert(receipt.copiedTables>70);assert.equal(receipt.excelReimported,false);
  assert(receipt.numericNulls.some(r=>r.table==='records'&&r.column==='price'));assert.equal(pg.raw("SELECT price FROM records WHERE id='seed-600519'").rows[0].price,null);
  assert.equal(pg.raw('SELECT count(*) n FROM trade_orders').rows[0].n,countBefore);
 });
 database.getDb=()=>pg.asDatabase();
 load('lib/brokerCashSchema.ts').registerBrokerCashGuard(pg.asDatabase());load('lib/tradeCorrectionSchema.ts').registerTradeCorrection(pg.asDatabase());load('lib/brokerHoldingSourceSchema.ts').registerBrokerSourceGuard(pg.asDatabase());
 await test('legacy camel-case result fields and SQLite booleans stay compatible without altering native JSON',()=>{
  const row=pg.prepare('SELECT count(*) AS usedBytes,EXISTS(SELECT 1 FROM records) AS isPresent FROM records').get();assert.equal(typeof row.usedBytes,'number');assert.equal(row.isPresent,1);
  assert.equal(pg.raw("SELECT DATE '2026-07-28' AS recorded_date").rows[0].recorded_date,'2026-07-28');
  pg.raw('CREATE TABLE native_json_fixture(id TEXT PRIMARY KEY,payload JSONB)');pg.raw('INSERT INTO native_json_fixture VALUES($1,$2)',['one',JSON.stringify({verified:false,_alcor_rowid:'source-owned'})]);
  assert.deepEqual(pg.prepare('SELECT payload FROM native_json_fixture WHERE id=?').get('one').payload,{verified:false,_alcor_rowid:'source-owned'});
  pg.raw('CREATE TABLE native_sort_fixture(value NUMERIC);INSERT INTO native_sort_fixture VALUES(NULL),(1),(2)');
  assert.deepEqual(pg.prepare('SELECT value FROM native_sort_fixture ORDER BY value DESC').all().map(r=>r.value),[2,1,null]);
  assert.deepEqual(pg.prepare('SELECT value FROM native_sort_fixture ORDER BY value').all().map(r=>r.value),[null,1,2]);
 });
 await test('same migration identity cannot reimport or duplicate existing history',()=>{
  assert.equal(migrateBusinessDatabase(sqlite,pg,'isolated-integration').importedAgain,0);assert.equal(pg.raw('SELECT count(*) n FROM trade_orders').rows[0].n,countBefore);
 });
 await test('read existing holdings and filled history through shared Web/App business functions',()=>{
  assert.equal(store.readRecord(fixture.id,record.id).qty,12);assert.equal(funds.readFundBalances(fixture.id).USD,979);
  assert.equal(load('lib/appAssetOrders.ts').assetOrderRows(fixture.id).length,1);
 });
 await test('PostgreSQL commits an actual trade, cash and position atomically; no SQLite dual write',()=>{
  orders.executeOrder({userId:fixture.id,recordId:record.id,side:'buy',qty:3,price:10,fees:1,tradedAt:'2026-10-21T14:30:00.000Z'});
  assert.equal(store.readRecord(fixture.id,record.id).qty,15);assert.equal(funds.readFundBalances(fixture.id).USD,948);
  assert.equal(sqlite.prepare('SELECT qty FROM records WHERE id=?').get(record.id).qty,12);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM trade_orders').get().n,countBefore);
 });
 await test('failure after order insert rolls back position, cash, revision, fee evidence and sync counters',()=>{
  const before=pg.raw('SELECT qty,revision FROM records WHERE id=$1',[record.id]).rows[0],cash=funds.readFundBalances(fixture.id).USD,n=orders.listOrders(fixture.id).length;
  pg.exec("CREATE TRIGGER isolated_abort BEFORE INSERT ON trade_orders BEGIN SELECT RAISE(ABORT,'isolated rollback fixture'); END;");
  assert.throws(()=>orders.executeOrder({userId:fixture.id,recordId:record.id,side:'buy',qty:1,price:10,fees:1}),/isolated rollback fixture/);
  pg.exec('DROP TRIGGER isolated_abort');
  assert.deepEqual(pg.raw('SELECT qty,revision FROM records WHERE id=$1',[record.id]).rows[0],before);assert.equal(funds.readFundBalances(fixture.id).USD,cash);assert.equal(orders.listOrders(fixture.id).length,n);
 });
 await test('overselling is refused and another owner cannot see or mutate the position',()=>{
  assert.throws(()=>orders.executeOrder({userId:fixture.id,recordId:record.id,side:'sell',qty:999,price:10,fees:1}));
  const other=auth.createUser('pg_other_fixture','Fixture-12345');assert.equal(store.readRecord(other.id,record.id),null);
  assert.throws(()=>orders.executeOrder({userId:other.id,recordId:record.id,side:'sell',qty:1,price:10,fees:1}));
 });
 await test('nested savepoints retain outer writes and roll back only the failed nested operation',()=>{
  pg.transaction(()=>{pg.prepare('UPDATE records SET note=? WHERE id=?').run('outer',record.id);assert.throws(()=>pg.transaction(()=>{pg.prepare('UPDATE records SET note=? WHERE id=?').run('inner',record.id);throw Error('nested fixture');})());assert.equal(store.readRecord(fixture.id,record.id).note,'outer');})();
 });
 await test('a rejected statement leaves the outer transaction usable for its failure receipt',()=>{
  pg.transaction(()=>{assert.throws(()=>pg.prepare('INSERT INTO records(id,user_id,name,code,market,price,updated_at) VALUES(?,?,?,?,?,?,?)').run(record.id,fixture.id,'Duplicate','TEST','US',10,new Date().toISOString()));pg.prepare('UPDATE records SET note=? WHERE id=?').run('failure receipt remains writable',record.id);})();
  assert.equal(store.readRecord(fixture.id,record.id).note,'failure receipt remains writable');
 });
 await test('PostgreSQL login and native token issue/refresh retain the original account identity',()=>{
  const session=auth.createSession(fixture.id),verifier=crypto.randomBytes(32).toString('base64url'),a={client_id:app.APP_CLIENT_ID,redirect_uri:app.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope:'portfolio.read portfolio.write assets.read positions.read cash.read orders.read orders.write orders.cancel'};
  const code=app.issueAppCode(app.parseAppAuthorization(a),fixture.id,session),grant=app.exchangeAppCode({...a,code,code_verifier:verifier});assert(grant.access_token);nativeGrant=app.refreshAppTokens(app.APP_CLIENT_ID,grant.refresh_token);assert(nativeGrant.access_token);
 });
 await test('real Web and native password login use persistent PostgreSQL security budgets',async()=>{
  const origin=process.env.FIRE_APP_ORIGIN,headers={origin,'content-type':'application/json'};
  for(const password of ['wrong-fixture','Fixture-12345']) {
   const request=new Request(origin+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({username:fixture.username,password})});
   const response=await load('app/api/auth/login/route.ts').POST(request);assert.equal(response.status,password==='Fixture-12345'?200:401);if(response.status===200)assert(response.headers.get('set-cookie')?.includes('HttpOnly'));
  }
  const old=await load('app/api/v1/auth/login/route.ts').POST(new Request(origin+'/api/v1/auth/login',{method:'POST',headers,body:JSON.stringify({username:fixture.username,password:'Fixture-12345'})}));assert.equal(old.status,200);
  const native=await load('app/api/v2/auth/login/route.ts').POST(new Request(origin+'/api/v2/auth/login',{method:'POST',headers,body:JSON.stringify({client_id:'fire-ios',username:fixture.username,password:'Fixture-12345',device_name:'PostgreSQL fixture'})}));assert.equal(native.status,200);
 });
 await test('real v1/v2 native history routes read PostgreSQL and preserve counts',async()=>{
  load('lib/quotes.ts').fetchOverviewQuotes=async()=>({quotes:{},cached:[],pending:false});
  for(const version of [1,2]) {
   const request=new Request(process.env.FIRE_APP_ORIGIN+`/api/v${version}/account-assets/orders?scope=all&status=all`,{headers:{authorization:'Bearer '+nativeGrant.access_token}});
   const response=await load(`app/api/v${version}/account-assets/orders/route.ts`).GET(request);const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));assert.equal(json.data.items.length,2);
  }
 });
 await test('native v1/v2 submission routes commit PostgreSQL only and reject the same request UUID',async()=>{
  const assets=load('lib/appAssets.ts'),trading=load('lib/appTrading.ts');
  assets.declareInstrument(fixture.id,record.id,{requestId:crypto.randomUUID(),recordRevision:store.readRecord(fixture.id,record.id).revision,revision:0,kind:'cash_equity',listingStatus:'listed'},()=>fixture.id);
  for(const version of [1,2]) {
   const current=store.readRecord(fixture.id,record.id),s=trading.tradingSnapshot(fixture.id);
   const body={requestId:crypto.randomUUID(),accountId:fixture.id,recordId:record.id,recordRevision:current.revision,snapshotRevision:s.snapshotRevision,side:'buy',mode:'record',orderType:'limit',qty:1,price:10,fees:1,tif:'gtc',session:'REGULAR',tradedAt:new Date(Date.now()-1000).toISOString()};
   const request=()=>new Request(process.env.FIRE_APP_ORIGIN+`/api/v${version}/account-assets/trading/submissions`,{method:'POST',headers:{authorization:'Bearer '+nativeGrant.access_token,'content-type':'application/json'},body:JSON.stringify(body)});
   const route=load(`app/api/v${version}/account-assets/trading/submissions/route.ts`);const response=await route.POST(request());assert.equal(response.status,200,JSON.stringify(await response.json()));
   assert.equal(store.readRecord(fixture.id,record.id).qty,current.qty+1);const duplicate=await route.POST(request());assert.equal(duplicate.status,409);
  }
  assert.equal(sqlite.prepare('SELECT qty FROM records WHERE id=?').get(record.id).qty,12);
 });
 await test('financial correction exemptions remain connection-local, ID-scoped and cleared after failure',()=>{
  const u=auth.createUser('pg_guard_fixture','Fixture-12345'),r=store.createRecord(u.id,{name:'Guard fixture',code:'GUARD',market:'US',qty:0,cost:0,price:10,group:'Fixture',note:''});
  funds.createFundTransaction({userId:u.id,currency:'USD',type:'opening',amount:100,direction:1});
  const rows=[1,2].map(()=>orders.executeOrder({userId:u.id,recordId:r.id,side:'buy',qty:1,price:10,fees:1}).order);
  for(const o of rows)pg.prepare('INSERT INTO trade_fee_details VALUES(?,?,?,?,?)').run(o.id,u.id,'{}','{}',new Date().toISOString());
  const update=(o,fee)=>pg.prepare('UPDATE trade_orders SET fees=? WHERE id=?').run(fee,o.id);
  assert.throws(()=>update(rows[0],2),e=>e.status===409);
  load('lib/tradeCorrectionSchema.ts').withTradeCorrection(pg.asDatabase(),new Set([rows[0].id]),()=>{update(rows[0],2);assert.throws(()=>update(rows[1],2),e=>e.status===409);update(rows[0],1);});
  assert.throws(()=>update(rows[0],2),e=>e.status===409);
  load('lib/brokerCashSchema.ts').withBrokerFeeCorrection(pg.asDatabase(),new Set([rows[0].id]),()=>{assert.equal(pg.raw('SELECT broker_cash_fee_correction($1) allowed',[rows[0].id]).rows[0].allowed,1);assert.equal(pg.raw('SELECT broker_cash_fee_correction($1) allowed',[rows[1].id]).rows[0].allowed,0);});
  assert.equal(pg.raw('SELECT broker_cash_fee_correction($1) allowed',[rows[0].id]).rows[0].allowed,0);
  pg.prepare('DELETE FROM users WHERE id=?').run(u.id);
 });
 await test('native PostgreSQL backup restores exact rows, financial triggers, history and identity sequences',async()=>{
  const file=path.join(temp,'postgresql.sql'),before=pg.raw('SELECT id,qty,revision FROM records ORDER BY id').rows,n=pg.raw('SELECT count(*) n FROM trade_orders').rows[0].n;
  await load('lib/postgresBackup.ts').backupPostgres(config,file);const text=fs.readFileSync(file,'utf8');assert(text.includes('CREATE TRIGGER'));assert(text.includes('json_populate_record'));
  pg.raw('DROP SCHEMA ledger CASCADE');pg.raw(text);
  assert.deepEqual(pg.raw('SELECT id,qty,revision FROM records ORDER BY id').rows,before);assert.equal(pg.raw('SELECT count(*) n FROM trade_orders').rows[0].n,n);
  const old=store.readRecord(fixture.id,record.id);orders.executeOrder({userId:fixture.id,recordId:record.id,side:'buy',qty:1,price:10,fees:1});assert.equal(store.readRecord(fixture.id,record.id).qty,old.qty+1);
 });
 await test('position deletion with orders is refused, while deleting the owner cascades the complete account',()=>{
  assert.throws(()=>pg.prepare('DELETE FROM records WHERE id=?').run(record.id));
  assert(store.readRecord(fixture.id,record.id));
  pg.prepare('DELETE FROM users WHERE id=?').run(fixture.id);
  for(const table of ['records','trade_orders','fund_transactions'])assert.equal(pg.raw('SELECT count(*) n FROM '+table+' WHERE user_id=$1',[fixture.id]).rows[0].n,0);
  for(const table of ['migration_batches','source_rows','source_documents','historical_events','reconciliation_issues'])assert.equal(pg.raw('SELECT count(*) n FROM '+table).rows[0].n,0);
 });
 console.log('PostgreSQL business integration passed '+passed+' checks');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{database.getDb=originalGetDb;pg.close();sqlite.close();fs.rmSync(temp,{recursive:true,force:true});process.exit(process.exitCode||0);});
