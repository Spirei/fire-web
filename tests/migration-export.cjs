// Synthetic PostgreSQL/files only. Never reads project data, starts app services, or touches real backups.
const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),Module=require('node:module'),ts=require('typescript'),{Client}=require('pg');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename,load=Module._load;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
Module._load=function(id,parent,...rest){if(parent?.filename.includes('migrationExport')&&/\/(auth|db|backup|feedGeneration|quotes|settings)$/.test(id))throw Error('Export must not import business initializers');return load.call(this,id,parent,...rest);};
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);
const originalCwd=process.cwd(),temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'alcor-export-fixture-')));
process.chdir(temp);global.fetch=async()=>{throw Error('Export must not call outside services');};
const hashes=value=>crypto.createHash('sha256').update(value).digest('hex');
const files=require(path.join(root,'lib/migrationExportFiles.ts')),source=require(path.join(root,'lib/migrationExportSource.ts')),snapshot=require(path.join(root,'lib/migrationExportSnapshot.ts')),api=require(path.join(root,'lib/migrationExport.ts'));
let passed=0,client,restoreClient;
const test=async(name,run)=>{await run();passed++;console.log('PASS '+name);};
async function treeFingerprint(directory){const result={};for(const entry of await fsp.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())result[entry.name]=await treeFingerprint(full);else result[entry.name]={sha:hashes(await fsp.readFile(full)),mode:(await fsp.stat(full)).mode};}return result;}
(async()=>{
  await fsp.mkdir('public/uploads',{recursive:true});await fsp.writeFile('public/uploads/图 标.png','SYNTHETIC IMAGE');
  await test('original inventory decodes local references, retains exact bytes, rejects missing files and symlinks',async()=>{
    const before=await files.inventoryOriginals(temp),references=new Set(files.localReferences('{"amount":9007199254740993.123456789012345678,"url":"/uploads/%E5%9B%BE%20%E6%A0%87.png?v=1"}','https://export.example.test'));
    files.assertReferences(references,before);const dest=path.join(temp,'copied');await fsp.mkdir(dest);await files.copyOriginals(temp,dest,before);
    assert.equal(await fsp.readFile(path.join(dest,'public/uploads/图 标.png'),'utf8'),'SYNTHETIC IMAGE');
    assert.throws(()=>files.assertReferences(new Set(['public/uploads/missing']),before),/原件/);
    await fsp.symlink('/etc/hosts','public/uploads/unsafe');await assert.rejects(()=>files.inventoryOriginals(temp),/链接/);await fsp.unlink('public/uploads/unsafe');
    await fsp.writeFile('public/uploads/图 标.png','CHANGED');await assert.rejects(()=>files.copyOriginals(temp,path.join(temp,'changed-copy'),before),/变化/);await fsp.writeFile('public/uploads/图 标.png','SYNTHETIC IMAGE');
    assert.throws(()=>snapshot.migrationKey('weak'),/密钥/);
  });
  await test('preflight never silently opens SQLite or creates a replacement source key',async()=>{
    await assert.rejects(()=>source.readExportConfiguration(temp),error=>error.code==='postgres_required');
    assert(!fs.existsSync('data/fire.db')&&!fs.existsSync('data/.fire-encryption-key'));
    assert.equal((await api.migrationExportPreflight(new Request('https://export.example.test/api/migration-export')).catch(api.migrationExportFailure)).status,401);
  });
  if(!process.env.ALCOR_EXPORT_PG_TEST_CONFIG){console.log('SKIP native dump/restore: set ALCOR_EXPORT_PG_TEST_CONFIG to a disposable alcor_export_test_* database');return;}
  const configuration=JSON.parse(await fsp.readFile(process.env.ALCOR_EXPORT_PG_TEST_CONFIG,'utf8'));
  assert(/^alcor_export_test_[a-f0-9]+$/.test(configuration.database),'Only named disposable source databases are allowed');
  assert(['127.0.0.1','localhost'].includes(configuration.host),'Test PostgreSQL must be loopback');
  process.env.FIRE_APP_ORIGIN='https://export.example.test';process.env.FIRE_BUILD_SHA='a'.repeat(40);delete process.env.FIRE_ENCRYPTION_KEY;
  client=new Client(configuration);await client.connect();
  await client.query('DROP SCHEMA IF EXISTS ledger CASCADE;CREATE SCHEMA ledger');
  await client.query(`CREATE TABLE ledger._database_backend(id integer PRIMARY KEY,version integer,migration_id text,active boolean);
    INSERT INTO ledger._database_backend VALUES(1,1,'synthetic-migration',true);
    CREATE TABLE ledger.users(id text PRIMARY KEY,uid bigint,role text,avatar text);
    CREATE TABLE ledger.sessions(token text PRIMARY KEY,user_id text REFERENCES ledger.users(id),expires_at bigint,authenticated_at bigint);
    CREATE TABLE ledger.site_settings(key text PRIMARY KEY,value text);
    CREATE TABLE ledger.trade_orders(id uuid PRIMARY KEY,user_id text,amount numeric(38,18),unknown_amount numeric,qty bigint,state text,request_uuid uuid,secret text);
    CREATE TABLE ledger.app_trading_operations(request_uuid uuid PRIMARY KEY,state text,conditional_order_uuid uuid,payload jsonb);
    CREATE SEQUENCE ledger.source_sequence START 9007199254740993;
    SELECT nextval('ledger.source_sequence');
    CREATE TABLE ledger.evidence(id bigint PRIMARY KEY DEFAULT nextval('ledger.source_sequence'),original_url text,bytes bytea);
    CREATE VIEW ledger.trade_view AS SELECT id,amount FROM ledger.trade_orders;
    CREATE FUNCTION ledger.guard_amount() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.amount<0 THEN RAISE EXCEPTION 'synthetic guard'; END IF;RETURN NEW;END $$;
    CREATE TRIGGER amount_guard BEFORE UPDATE ON ledger.trade_orders FOR EACH ROW EXECUTE FUNCTION ledger.guard_amount();
    CREATE INDEX trade_request_idx ON ledger.trade_orders(request_uuid);`);
  const sourceKey=crypto.randomBytes(32),derivedKey=crypto.createHash('sha256').update(sourceKey).digest();
  function encrypt(value){const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',derivedKey,nonce),bytes=Buffer.concat([cipher.update(value),cipher.final()]);return 'enc:v1:'+nonce.toString('base64')+':'+cipher.getAuthTag().toString('base64')+':'+bytes.toString('base64');}
  const token='b'.repeat(64),expired='c'.repeat(64),ordinary='d'.repeat(64),now=Date.now();
  await client.query("INSERT INTO ledger.users VALUES('synthetic-admin',9007199254740995,'admin','/uploads/%E5%9B%BE%20%E6%A0%87.png'),('synthetic-user',2,'user','')");
  for(const [value,user,expires]of[[token,'synthetic-admin',now+3600000],[expired,'synthetic-admin',now-1],[ordinary,'synthetic-user',now+3600000]])await client.query('INSERT INTO ledger.sessions VALUES($1,$2,$3,$4)',[hashes(value),user,String(expires),String(now)]);
  const orderId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',conditional='33333333-3333-4333-8333-333333333333';
  await client.query('INSERT INTO ledger.trade_orders VALUES($1,$2,$3,NULL,$4,$5,$6,$7)',[orderId,'synthetic-admin','9007199254740993.123456789012345678','9007199254740993','filled',requestId,encrypt('SYNTHETIC SOURCE SECRET')]);
  await client.query("INSERT INTO ledger.app_trading_operations VALUES($1,'submitted',$2,'{\"amount\":9007199254740993.123456789012345678,\"unknown\":null}')",[requestId,conditional]);
  await client.query("INSERT INTO ledger.evidence(original_url,bytes) VALUES('/uploads/%E5%9B%BE%20%E6%A0%87.png',decode('0001ffff','hex'))");
  await fsp.mkdir('data/backups/old-success',{recursive:true});await fsp.writeFile('data/backups/old-success/keep','NEVER PRUNE');await fsp.writeFile('data/backup-config.json','{"keep":1,"enabled":true}');
  await fsp.writeFile('data/.fire-encryption-key',sourceKey,{mode:0o600});
  await fsp.writeFile('data/database-runtime.json',JSON.stringify({version:1,backend:'postgres',...configuration,schema:'ledger',migrationId:'synthetic-migration',encryptedPassword:encrypt(configuration.password),password:undefined}),{mode:0o600});
  const keep=await treeFingerprint('data/backups'),backupConfig=await fsp.readFile('data/backup-config.json','utf8');
  const request=(selected=token,body,origin='https://export.example.test')=>new Request('https://export.example.test/api/migration-export',{method:body?'POST':'GET',headers:{cookie:'fire_session='+selected,...(body?{origin,'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const preflight=await(await api.migrationExportPreflight(request())).json(),exportKey=crypto.randomBytes(32).toString('base64url');
  await test('actual PostgreSQL driver/source marker and stable UID are checked without renewing or deleting sessions',async()=>{
    assert.equal(preflight.source.backend,'postgres');assert.equal(preflight.source.driver,'pg');assert.equal(preflight.source.database,configuration.database);
    for(const identity of[ordinary,expired])await assert.rejects(()=>api.migrationExportPreflight(request(identity)),error=>error.status===403);
    const wrong={confirm:'export-complete-database',expectedSource:{...preflight.source,backend:'sqlite'},encryptionKey:exportKey};
    await assert.rejects(()=>api.migrationExportStart(request(token,wrong)),error=>error.code==='source_changed');
    await assert.rejects(()=>api.migrationExportStart(request(token,{...wrong,expectedSource:preflight.source},'https://evil.example')),error=>error.status===403);
    assert.equal((await client.query('SELECT count(*)::text AS count FROM ledger.sessions')).rows[0].count,'3');
  });
  const checkAsyncJob=async()=>{
    const body={confirm:'export-complete-database',expectedSource:preflight.source,encryptionKey:exportKey};
    const response=await api.migrationExportStart(request(token,body));assert.equal(response.status,202);const started=await response.json();
    await assert.rejects(()=>api.migrationExportStart(request(token,body)),error=>error.code==='export_busy');
    let job;
    for(let n=0;n<600;n++){job=await(await api.migrationExportStatus(request(),started.id)).json();if(job.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.equal(job.state,'ready',JSON.stringify(job.error));
    const download=await api.migrationExportDownload(request(),started.id),bytes=Buffer.from(await download.arrayBuffer());assert.equal(hashes(bytes),download.headers.get('x-alcor-export-sha256'));
    await assert.rejects(()=>api.migrationExportDownload(request(ordinary),started.id),error=>error.status===403);
    const runtime=await fsp.readFile('data/database-runtime.json','utf8');
    await client.query(`CREATE SCHEMA alternate;
      CREATE TABLE alternate._database_backend AS TABLE ledger._database_backend;
      CREATE TABLE alternate.users AS TABLE ledger.users;
      CREATE TABLE alternate.sessions AS TABLE ledger.sessions;
      CREATE TABLE alternate.site_settings AS TABLE ledger.site_settings;`);
    try {
      await fsp.writeFile('data/database-runtime.json',JSON.stringify({...JSON.parse(runtime),schema:'alternate'}));
      const switched=await(await api.migrationExportPreflight(request())).json();assert.notEqual(switched.source.instanceId,job.source.instanceId);
      await assert.rejects(()=>api.migrationExportStatus(request(),started.id),error=>error.code==='source_changed');
      await assert.rejects(()=>api.migrationExportDownload(request(),started.id),error=>error.code==='source_changed');
      assert.equal(hashes(await fsp.readFile(path.join(temp,'data/migration-exports',started.id,'bundle.alcor-migration'))),hashes(bytes));
    } finally {await fsp.writeFile('data/database-runtime.json',runtime);await client.query('DROP SCHEMA alternate CASCADE');}
    assert.equal((await(await api.migrationExportStatus(request(),started.id)).json()).state,'ready');
    await fsp.appendFile(path.join(temp,'data/migration-exports',started.id,'bundle.alcor-migration'),'tamper');await assert.rejects(()=>api.migrationExportDownload(request(),started.id),error=>error.code==='export_changed');
    assert.deepEqual(await treeFingerprint('data/backups'),keep);assert.equal((await client.query('SELECT count(*)::text AS count FROM ledger.sessions')).rows[0].count,'3');
  };
  for(const variant of ['external-original','missing-private-original','registered-path','permission-revoked','runtime-changed','reused-source-key']){
    await test(variant+' rejects incomplete/unauthorized output and preserves source backups',async()=>{
      const runtime=await fsp.readFile('data/database-runtime.json','utf8'),dest=path.join(temp,'reject-'+variant);await fsp.mkdir(dest,{mode:0o700});
      if(variant==='external-original')await client.query("UPDATE ledger.users SET avatar='https://unsealed.example.test/logo.png' WHERE id='synthetic-admin'");
      if(variant==='missing-private-original')await client.query("CREATE TABLE ledger.resource_files(id text,user_id text,state text,sha256 text,size_bytes bigint);INSERT INTO ledger.resource_files VALUES('missing','synthetic-admin','ready',repeat('0',64),12)");
      if(variant==='registered-path')await client.query("CREATE TABLE ledger.registered_attachment(file_path text);INSERT INTO ledger.registered_attachment VALUES('data/attachments/missing-original')");
      const c=await source.openExportContext(request(),true);
      const code={'external-original':'external_original_unsealed','missing-private-original':'resource_original_invalid','registered-path':'registered_original_missing','permission-revoked':'admin_required','runtime-changed':'source_changed','reused-source-key':'export_key_not_independent'}[variant];
      try {
        await assert.rejects(()=>snapshot.buildMigrationBundle(c,dest,'mex_'+'2'.repeat(32),variant==='reused-source-key'?Buffer.from(sourceKey):snapshot.migrationKey(exportKey),async phase=>{
          if(phase==='encrypting'&&variant==='permission-revoked')await client.query("UPDATE ledger.users SET role='user' WHERE id='synthetic-admin'");
          if(phase==='encrypting'&&variant==='runtime-changed')await fsp.writeFile('data/database-runtime.json',runtime+'\n');
        }),error=>error.code===code);
      } finally {
        await c.close();await fsp.writeFile('data/database-runtime.json',runtime);
        await client.query("UPDATE ledger.users SET role='admin',avatar='/uploads/%E5%9B%BE%20%E6%A0%87.png' WHERE id='synthetic-admin';DROP TABLE IF EXISTS ledger.resource_files;DROP TABLE IF EXISTS ledger.registered_attachment");
      }
      assert(!fs.existsSync(path.join(dest,'bundle.alcor-migration')));assert(!fs.existsSync(path.join(dest,'staging')));assert(!fs.existsSync(path.join(dest,'bundle.partial')));
      assert.deepEqual(await treeFingerprint('data/backups'),keep);assert.equal(await fsp.readFile('data/backup-config.json','utf8'),backupConfig);
    });
  }
  if(process.env.ALCOR_EXPORT_FAILURES_ONLY==='1'){
    await test('ready status/download reject another source with the same admin ID and retain the original archive',checkAsyncJob);
    console.log('Failure-only validation: native restoration was deliberately not repeated');return;
  }
  const context=await source.openExportContext(request(),true),id='mex_'+'1'.repeat(32),directory=path.join(temp,'direct-snapshot');await fsp.mkdir(directory,{mode:0o700});
  let result;
  await test('one MVCC snapshot preserves exact amounts, nulls, UUIDs and App execution state during concurrent source writes',async()=>{
    result=await snapshot.buildMigrationBundle(context,directory,id,snapshot.migrationKey(exportKey),async phase=>{if(phase==='snapshot-open')await client.query('UPDATE ledger.trade_orders SET amount=1 WHERE id=$1',[orderId]);});
    await context.close();
    assert.equal((await client.query('SELECT amount::text FROM ledger.trade_orders')).rows[0].amount,'1.000000000000000000');
    assert.equal((await client.query('SELECT state FROM ledger.app_trading_operations')).rows[0].state,'submitted');
    assert.equal((await fsp.stat(path.join(directory,'bundle.alcor-migration'))).mode&0o777,0o600);
    assert(!fs.existsSync(path.join(directory,'staging')));
  });
  const proofRoot=process.env.ALCOR_EXPORT_FIXTURE_OUTPUT?path.resolve(process.env.ALCOR_EXPORT_FIXTURE_OUTPUT):path.join(temp,'proof');
  if(process.env.ALCOR_EXPORT_FIXTURE_OUTPUT)assert(/^alcor-export-proof-/.test(path.basename(proofRoot)),'Retained outputs must be explicitly named synthetic proofs');
  await fsp.mkdir(proofRoot,{mode:0o700});
  const bundle=path.join(proofRoot,'synthetic.alcor-migration'),keyFile=path.join(proofRoot,'synthetic-export.key'),sourceFile=path.join(proofRoot,'synthetic-source.key');
  await fsp.copyFile(path.join(directory,'bundle.alcor-migration'),bundle);await fsp.chmod(bundle,0o600);await fsp.writeFile(keyFile,exportKey+'\n',{mode:0o600});await fsp.writeFile(sourceFile,sourceKey,{mode:0o600});
  const {verifyMigrationExport}=await import(path.join(root,'scripts/verify-migration-export.mjs'));
  const verified=await verifyMigrationExport({bundle,exportKeyFile:keyFile,sourceKeyFile:sourceFile,output:path.join(proofRoot,'verified')});
  await test('GCM, manifest seal, file census, separate source key and exact table row lexemes all verify before restore',async()=>{
    const {manifest}=verified;
    assert.equal(manifest.users.find(user=>user.id==='synthetic-admin').uid,'9007199254740995');
    const table=manifest.tables.find(table=>table.name==='trade_orders'),rows=await fsp.readFile(path.join(verified.payload,table.path),'utf8');
    assert(rows.includes('9007199254740993.123456789012345678'));assert(rows.includes('"unknown_amount":null'));assert(rows.includes(requestId));
    assert(!manifest.originals.files.some(file=>/encryption-key|runtime.json|backup/.test(file.path)));
    assert.equal(verified.receipt.originalSourceKeyVerified,true);assert.equal(verified.receipt.nativeDatabaseRestoreVerified,false);
    const tampered=path.join(proofRoot,'tampered.alcor-migration'),bytes=await fsp.readFile(bundle);bytes[bytes.length-25]^=1;await fsp.writeFile(tampered,bytes);
    await assert.rejects(()=>verifyMigrationExport({bundle:tampered,exportKeyFile:keyFile,sourceKeyFile:sourceFile,output:path.join(proofRoot,'must-not-exist')}));assert(!fs.existsSync(path.join(proofRoot,'must-not-exist')));await fsp.unlink(tampered);
    const wrong=path.join(proofRoot,'wrong-source.key');await fsp.writeFile(wrong,crypto.randomBytes(32),{mode:0o600});await assert.rejects(()=>verifyMigrationExport({bundle,exportKeyFile:keyFile,sourceKeyFile:wrong,output:path.join(proofRoot,'wrong-source-output')}));await fsp.unlink(wrong);
  });
  const restored=configuration.database.replace('alcor_export_test_','alcor_export_restore_test_');await client.query('CREATE DATABASE '+source.quoted(restored));
  try {
    await test('native pg_restore reproduces every table digest, schema guards, sequence values and decryptable original source ciphertext in isolation',async()=>{
      const env={...process.env,DYLD_LIBRARY_PATH:process.env.ALCOR_PG_DYLD_LIBRARY_PATH,PGHOST:configuration.host,PGPORT:String(configuration.port),PGUSER:configuration.user,PGPASSWORD:configuration.password,PGDATABASE:restored};delete env.PGOPTIONS;
      const child=snapshot.runTool(snapshot.postgresTool('pg_restore'),['--no-password','--exit-on-error','--no-owner','--no-privileges','--dbname='+restored,path.join(verified.payload,'database.dump')],env);child.child.stdout.resume();await child.done;
      restoreClient=new Client({...configuration,database:restored});await restoreClient.connect();
      for(const table of verified.manifest.tables){const rows=(await restoreClient.query(`SELECT row_to_json(t)::text AS value FROM ONLY ${source.quoted(table.schema)}.${source.quoted(table.name)} t ORDER BY row_to_json(t)::text COLLATE "C"`)).rows;assert.equal(String(rows.length),table.rowCount);assert.equal(hashes(rows.map(row=>row.value+'\n').join('')),table.sha256);}
      const secret=(await restoreClient.query('SELECT secret FROM ledger.trade_orders')).rows[0].secret;const [iv,tag,payload]=secret.slice(7).split(':').map(value=>Buffer.from(value,'base64')),decipher=crypto.createDecipheriv('aes-256-gcm',derivedKey,iv);decipher.setAuthTag(tag);assert.equal(Buffer.concat([decipher.update(payload),decipher.final()]).toString(),'SYNTHETIC SOURCE SECRET');
      await assert.rejects(()=>restoreClient.query('UPDATE ledger.trade_orders SET amount=-1'),/synthetic guard/);
      assert.equal((await restoreClient.query('SELECT last_value::text AS value FROM ledger.source_sequence')).rows[0].value,verified.manifest.snapshot.sequences[0].value);
      await fsp.writeFile(path.join(proofRoot,'native-restore-verification.json'),JSON.stringify({...verified.receipt,nativeDatabaseRestoreVerified:true,allRestoredTableDigestsMatch:true,financialReplayExecuted:false,sourceBackupsUnchanged:true,fixtureOnly:true},null,2)+'\n',{mode:0o600});
    });
  }finally{if(restoreClient){await restoreClient.end();restoreClient=null;}await client.query('DROP DATABASE '+source.quoted(restored));}
  await test('file changes and sequence changes fail without replacing existing backups',async()=>{
    for(const variant of['file','sequence']){
      const c=await source.openExportContext(request(),true),dest=path.join(temp,'fail-'+variant);await fsp.mkdir(dest,{mode:0o700});
      await assert.rejects(()=>snapshot.buildMigrationBundle(c,dest,'mex_'+'2'.repeat(32),snapshot.migrationKey(exportKey),async phase=>{if(phase==='snapshot-open'){if(variant==='file')await fsp.writeFile('public/uploads/new-original','race');else await client.query("SELECT nextval('ledger.source_sequence')");}}));
      await c.close();assert(!fs.existsSync(path.join(dest,'bundle.alcor-migration')));if(variant==='file')await fsp.unlink('public/uploads/new-original');
    }
    assert.deepEqual(await treeFingerprint('data/backups'),keep);assert.equal(await fsp.readFile('data/backup-config.json','utf8'),backupConfig);
  });
  await test('admin-created asynchronous jobs bind downloads to the original source and reject tampering',checkAsyncJob);
  console.log('Synthetic migration proof: '+proofRoot);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(restoreClient)await restoreClient.end().catch(()=>{});if(client)await client.end().catch(()=>{});process.chdir(originalCwd);await fsp.rm(temp,{recursive:true,force:true});console.log(passed+' migration export checks passed');});
