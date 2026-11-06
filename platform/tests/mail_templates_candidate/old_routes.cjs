// Frozen old mail-template routes. Built-in Node only; no typescript package or local node_modules.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root=process.argv[2];
if(!root)throw Error('Explicit verified source fixture required');
const auth={assertAppOrigin(request){if(new URL(request.url).origin!=='http://testserver'||![null,'http://testserver'].includes(request.headers.get('origin')))throw Error('origin');},authenticateAppAccess(){return null;}};
const context=vm.createContext({Buffer,Error,Request,Response,URL,Headers});
async function load(relative,deps){const filename=path.join(root,relative);const module=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(filename,'utf8'),{mode:'transform'}),{context,identifier:filename});await module.link(async name=>{if(!(name in deps))throw Error('Unapproved dependency '+name);const linked=deps[name];if(linked instanceof vm.Module)return linked;return new vm.SyntheticModule(Object.keys(linked),function(){for(const key of Object.keys(linked))this.setExport(key,linked[key]);},{context,identifier:name});});await module.evaluate();return module;}
(async()=>{
 const model=await load('lib/mailTemplateModel.ts',{});
 const api=await load('lib/api.ts',{'next/server':{NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),{status:init?.status??200,headers:{'content-type':'application/json',...init?.headers}})}}});
 const policy=await load('lib/appApiV2Policy.ts',{});
 const appV2=await load('lib/appApiV2.ts',{'./appApiV2Policy':policy,'./appAuth':auth,'./api':api});
 const v1=await load('app/api/v1/auth/mail-templates/route.ts',{'@/lib/api':api,'@/lib/appAuth':auth,'@/lib/mailTemplates':{readMailTemplates:()=>model.namespace.DEFAULT_MAIL_TEMPLATES}});
 const v2=await load('app/api/v2/auth/mail-templates/route.ts',{'@/app/api/v1/auth/mail-templates/route':v1,'@/lib/appApiV2':appV2});
 const routes={1:v1.namespace,2:v2.namespace},results=[];
 for(const version of [1,2])for(const authorization of [null,'Bearer invalid','Bearer fat_'+'A'.repeat(43)]){
  const headers={origin:'http://testserver'};if(authorization!==null)headers.authorization=authorization;
  const response=await routes[version].GET(new Request(`http://testserver/api/v${version}/auth/mail-templates`,{headers}));
  results.push({version,authorization,status:response.status,body:await response.json()});
 }
 console.log(JSON.stringify(results));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
