// Original store code over controlled memory SQLite. Built-in Node only; no typescript package or local node_modules.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const root=process.argv[2],rows=JSON.parse(fs.readFileSync(0,'utf8'));
const db=new DatabaseSync(':memory:');
db.transaction=(operation)=>()=>{db.exec('BEGIN');try{const result=operation();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
db.exec('CREATE TABLE watch_groups(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,icon TEXT,sort INTEGER,visible INTEGER,kind TEXT,market TEXT,created_at TEXT);CREATE TABLE records(id TEXT PRIMARY KEY,user_id TEXT,group_name TEXT,watch_group_id TEXT,watch_group_sort INTEGER,updated_at TEXT);CREATE TABLE assets(id TEXT PRIMARY KEY,url TEXT,name TEXT,updated_at TEXT)');
const context=vm.createContext({Buffer,Error,Map,process:{cwd:()=>'/controlled'}});
async function load(relative,deps){const filename=path.join(root,relative);const module=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(filename,'utf8'),{mode:'transform'}),{context,identifier:filename});await module.link(async name=>{if(!(name in deps))throw Error('Forbidden '+name);const linked=deps[name];if(linked instanceof vm.Module)return linked;return new vm.SyntheticModule(Object.keys(linked),function(){for(const key of Object.keys(linked))this.setExport(key,linked[key]);},{context,identifier:name});});await module.evaluate();return module.namespace;}
(async()=>{
 const store=await load('lib/watchGroupsStore.ts',{'crypto':{randomBytes(){throw Error('Already initialized fixture required');}},'./db':{getDb:()=>db},'./assets':{assetId:(...v)=>v.join(':'),upsertAsset(){throw Error('No asset mutation');}},'./fileCleanup':{localPathOf(){throw Error('No file IO');},removeFileIfUnused(){throw Error('No file IO');},sameLocalFile:()=>false},'node:path':{default:path},'node:fs':{default:{}}});
 const insert=db.prepare("INSERT INTO watch_groups VALUES(?,'synthetic-owner',?,'',?,1,?,?,?)");
 store.MARKET_GROUPS.forEach((m,i)=>insert.run('market-'+m.market,m.name,i,'market',m.market,'2020-01-01T00:00:00Z'));
 for(const r of rows)insert.run(r.id,r.id,r.sort,'custom','',r.created_at);
 const groups=store.listWatchGroups('synthetic-owner').filter(g=>g.kind==='custom');
 const actual=groups.map(g=>({dto:g,raw:db.prepare('SELECT sort,created_at FROM watch_groups WHERE id=?').get(g.id)}));
 db.close();process.stdout.write(JSON.stringify({memoryOnly:true,groups:actual}));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
