const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const root=process.argv[2],commands=JSON.parse(fs.readFileSync(0,'utf8'));
const forbidden=()=>{throw Error('No old database, filesystem deletion, runtime config or transport');};
const context=vm.createContext({URL,Request,Response,Headers,Buffer,process:{cwd:forbidden},console});
async function load(file,deps){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'),{mode:'transform'}),{context});await m.link(async name=>{if(!(name in deps))throw Error('Forbidden dependency '+name);const value=deps[name];return new vm.SyntheticModule(Object.keys(value),function(){for(const key of Object.keys(value))this.setExport(key,value[key]);},{context});});await m.evaluate();return m.namespace;}
(async()=>{
 const password=await load('password.ts',{'crypto':crypto});
 const stored=password.hashPassword('Synthetic9Pass');
 let command,statements,factors;
 const auth={getAuthUser:()=>command.unauthenticated?null:{id:'synthetic-owner',role:command.role||'user'},findUserById:()=>({password_hash:stored})};
 const db={prepare:sql=>({get:()=>{if(sql==='SELECT COUNT(*) n FROM users WHERE role = \'admin\'')return {n:command.adminCount??2};if(sql==='SELECT avatar FROM users WHERE id = ?')return {};throw Error('Unreviewed query');},run:id=>{if(sql!=='DELETE FROM users WHERE id = ?'||id!=='synthetic-owner')throw Error('Unreviewed mutation');statements.push(sql);}})};
 const route=await load('route.ts',{'@/lib/requestBody':{readJsonBody:request=>request.json()},'next/server':{NextResponse:Response},'@/lib/auth':auth,'@/lib/db':{getDb:()=>db},'fs':{default:{existsSync:forbidden,unlinkSync:forbidden}},'path':{default:{resolve:forbidden,sep:'/'}},'@/lib/password':password,'@/lib/rateLimit':{clientIp:()=> 'fixture',rateLimit:()=>!command.exhausted,rateLimitGlobal:()=>!command.exhausted},'@/lib/securityAudit':{logSecurityEvent:()=>{}},'@/lib/totpAuth':{userTotpEnabled:()=>!!command.factor,consumeTotpFactor:()=>{factors++;return command.factorValid!==false;}}});
 const results=[];
 for(command of commands){statements=[];factors=0;const response=await route.POST(new Request('https://public.example.invalid/api/v1/auth/delete-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:command.password??'Synthetic9Pass',code:'synthetic-factor'})}));results.push({status:response.status,body:await response.json(),statements,factors});}
 process.stdout.write(JSON.stringify({actualRoute:true,actualScrypt:true,identityAndFactorStubbed:true,bodyReaderStubbed:true,noOldDatabaseOrFilesystemOrTransport:true,results}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
