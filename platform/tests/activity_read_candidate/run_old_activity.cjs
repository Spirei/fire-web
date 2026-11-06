// Exact frozen TS store/route over memory SQLite. Built-in Node only; no old or local node_modules.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(':memory:'),root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,nickname TEXT); CREATE TABLE security_audit(id INTEGER PRIMARY KEY,user_id TEXT,event TEXT,detail TEXT,ip TEXT,created_at TEXT);');
for(const row of input.users)db.prepare('INSERT INTO users VALUES(?,?,?)').run(row.id,row.username,row.nickname??null);
for(const row of input.events)db.prepare('INSERT INTO security_audit VALUES(?,?,?,?,?,?)').run(row.id,row.user_id,row.event,row.detail,row.ip,row.created_at);
const context=vm.createContext({Buffer,Error,process:{cwd:()=>'/controlled'}});
async function load(relative,deps){
 const module=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,relative),'utf8'),{mode:'transform'}),{context});
 await module.link(async name=>{if(!(name in deps))throw Error('Forbidden dependency '+name);const object=deps[name],names=Object.keys(object);return new vm.SyntheticModule(names,function(){for(const key of names)this.setExport(key,object[key]);},{context});});
 await module.evaluate();return module.namespace;
}
(async()=>{
 const store=await load('lib/store.ts',{'crypto':{randomBytes(){throw Error('No random or mutation');}},'./db':{getDb:()=>db},'./stockAccount':{stockAccountError(){throw Error('No financial rule');}},'./importIdentity':{importIdentity(){throw Error('No financial import');}}});
 const route=await load('app/api/activities/route.ts',{'next/server':{NextResponse:{json(value,options){return {status:options?.status??200,body:value};}}},'@/lib/auth':{getAuthUser:request=>request.user,isAdmin:user=>user?.role==='admin'},'@/lib/store':store});
 const response=await route.GET({user:input.actor??null});db.close();process.stdout.write(JSON.stringify({memoryOnly:true,builtInNodeOnly:true,response}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
