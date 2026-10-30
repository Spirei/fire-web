'use strict';
// Explicit, offline cutover. Stop the old Web writer first; --snapshot must be its verified immutable online backup.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),Database=require('better-sqlite3');
const {PostgresDatabase}=require('../server-tools/postgres/postgresDatabase.js');
const {migrateBusinessDatabase}=require('../server-tools/postgres/postgresMigration.js');
const {decryptSecret,encryptSecret}=require('../server-tools/postgres/secretStorage.js');
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const snapshot=value('--snapshot'),migrationId=value('--migration-id');
if(!args.includes('--activate')||!snapshot||!migrationId||!/^[a-zA-Z0-9_-]{8,100}$/.test(migrationId))throw Error('Use --snapshot <immutable.sqlite> --migration-id <stable-id> --activate after stopping the old writer');
const source=new Database(path.resolve(snapshot),{readonly:true,fileMustExist:true});
const saved=Object.fromEntries(source.prepare("SELECT key,value FROM site_settings WHERE key IN ('pgHost','pgPort','pgDatabase','pgUser','pgPassword')").all().map(r=>[r.key,r.value]));
if(!saved.pgHost||!saved.pgDatabase||!saved.pgUser||!saved.pgPassword)throw Error('Missing saved database connection');
const config={version:1,backend:'postgres',host:saved.pgHost,port:Number(saved.pgPort)||5432,database:saved.pgDatabase,user:saved.pgUser,schema:'ledger',encryptedPassword:saved.pgPassword.startsWith('enc:v1:')?saved.pgPassword:encryptSecret(saved.pgPassword),migrationId};
const target=new PostgresDatabase({host:config.host,port:config.port,database:config.database,user:config.user,schema:config.schema,password:decryptSecret(config.encryptedPassword,true),ssl:false});
try{
 const required=path.resolve('data/database-postgres-required');
 if(fs.existsSync(required)&&fs.readFileSync(required,'utf8')!==migrationId)throw Error('Another database cutover is pending');
 if(!fs.existsSync(required)){fs.writeFileSync(required,migrationId,{mode:0o600,flag:'wx'});const fd=fs.openSync(required,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 target.raw('CREATE SCHEMA IF NOT EXISTS ledger');
 const receipt=migrateBusinessDatabase(source,target,migrationId);
 target.raw("INSERT INTO site_settings(key,value) VALUES('dbType','postgres') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
 const counts=target.raw("SELECT (SELECT count(*) FROM trade_orders) orders,(SELECT count(*) FROM trade_orders WHERE market='US') us_orders,(SELECT count(*) FROM records) records,(SELECT count(*) FROM broker_accounts) broker_accounts").rows[0];
 const file=path.resolve('data/database-runtime.json'),temporary=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 if(fs.existsSync(file)){const previous=JSON.parse(fs.readFileSync(file,'utf8'));if(previous.migrationId!==migrationId)throw Error('Another runtime is active; refusing automatic backend replacement');}
 fs.writeFileSync(temporary,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
 const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);
 const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
 const result={...receipt,activated:true,backend:'postgres',counts,excel_reimported:false,source_sqlite_readonly:true,runtime_file:file,verified_at:new Date().toISOString()};
 const destination=path.join(path.dirname(path.resolve(snapshot)),'postgres-business-cutover-receipt.json');fs.writeFileSync(destination,JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify({activated:true,migrationId,counts,excel_reimported:false,receipt:destination}));
}finally{target.close();source.close();}
