// Exact frozen old TS with built-in, isolated in-memory SQLite and virtual files only.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto'),root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const files=new Map(),db=new DatabaseSync(':memory:');
class MemoryDatabase {pragma(){}exec(s){db.exec(s)}prepare(s){const statement=db.prepare(s);statement.setAllowUnknownNamedParameters(true);return statement}transaction(fn){return()=>{db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}}
const virtualFs={mkdirSync(){},readFileSync(file){if(!files.has(file))throw Error('missing');return files.get(file);},writeFileSync(file,content){files.set(file,content)},renameSync(from,to){files.set(to,files.get(from));files.delete(from)},rmSync(file){files.delete(file)}};
const context=vm.createContext({Buffer,Error,Date:class extends Date{static now(){return input.now}},process:{cwd:()=>'/controlled',once(){}},setInterval(){return {unref(){}}},console:{error(){throw Error('old storage failed')}}});
async function load(relative,deps){const module=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,relative),'utf8'),{mode:'transform'}),{context});await module.link(async name=>{if(!(name in deps))throw Error('Forbidden dependency '+name);const object=deps[name],names=Object.keys(object);return new vm.SyntheticModule(names,function(){for(const key of names)this.setExport(key,object[key]);},{context})});await module.evaluate();return module.namespace;}
(async()=>{
 const versions=await load('lib/apiDocsVersion.ts',{});
 const docs=await load('lib/apiDocs.ts',{'node:fs':{default:virtualFs},'node:path':{default:path},'node:crypto':crypto,'./apiDocsVersion':versions});
 const saved=docs.saveApiDocument(2,input.content);const document=docs.readApiDocument(2);const conflict=docs.saveApiDocument(2,'wrong','0'.repeat(64));
 const types=await load('lib/apiRequestTypes.ts',{}),routes=await load('lib/apiRequestRoutes.ts',{});
 const log=await load('lib/apiRequestLog.ts',{'better-sqlite3':{default:MemoryDatabase},'node:fs':{default:virtualFs},'node:path':{default:path},'./apiRequestRoutes':routes,'./apiRequestTypes':types});
 for(const row of input.rows)log.recordRequest(row);
 log.flushRequestLogs();const filters=types.parseRequestFilters(new URLSearchParams(input.params||{}),input.now);
 const snapshot=log.readRequestSnapshot(filters,input.now);
 process.stdout.write(JSON.stringify({document,saved,conflict,parsedVersions:[null,'1','v2','3','../secret','01'].map(v=>versions.parseApiDocsVersion(v)),snapshot,routes:input.paths.map(p=>log.requestRoute(p)),memoryOnly:true,builtInNodeOnly:true}));db.close();
})().catch(e=>{console.error(e.stack);process.exitCode=1});
