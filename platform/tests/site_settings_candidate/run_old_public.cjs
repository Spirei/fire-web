const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {isIP}=require('node:net'),{stripTypeScriptTypes}=require('node:module');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const forbidden=()=>{throw Error('No old database, transport or provider execution');};
const context=vm.createContext({URL,Request,Response,Headers,console,process:{env:{NODE_ENV:'production'}}});
async function load(file,deps,source){const m=new vm.SourceTextModule(stripTypeScriptTypes(source??fs.readFileSync(path.join(root,file),'utf8'),{mode:'transform'}),{context});await m.link(async name=>{if(!(name in deps))throw Error('Forbidden dependency '+name);const value=deps[name];return new vm.SyntheticModule(Object.keys(value),function(){for(const key of Object.keys(value))this.setExport(key,value[key]);},{context});});await m.evaluate();return m.namespace;}
(async()=>{
 const settings={getSiteSettings:()=>input.settings},next={NextResponse:Response};
 const verification=await load('lib/emailVerification.ts',{'node:crypto':crypto,'node:net':{isIP},'./db':{getDb:forbidden},'./settings':settings});
 const origin=await load('lib/publicSiteUrl.ts',{'./emailVerification':verification});
 const api=await load('lib/api.ts',{'next/server':next});
 const policy=await load('lib/appApiV2Policy.ts',{});
 const authSource=fs.readFileSync(path.join(root,'lib/appAuth.ts'),'utf8'),start=authSource.indexOf('export function assertAppOrigin'),end=authSource.indexOf('\n}\n',start)+3;
 if(start<0||end<=start)throw Error('Source origin function missing');
 const auth=await load('lib/appAuth.ts',{'./settings':settings,'./publicSiteUrl':origin},'import {getSiteSettings} from "./settings";import {publicSiteDomain} from "./publicSiteUrl";'+authSource.slice(start,end));
 let authentications=0;
 const wrapper=await load('lib/appApiV2.ts',{'./appApiV2Policy':policy,'./appAuth':{assertAppOrigin:auth.assertAppOrigin,authenticateAppAccess:token=>{authentications++;return token==='fat_'+'A'.repeat(43)?{scope:'portfolio.read'}:null;}},'./api':api});
 const web=await load('app/api/settings/public/route.ts',{'next/server':next,'@/lib/settings':settings,'@/lib/publicSiteUrl':origin,'@/lib/emailRegistration':{emailRegistrationDiscovery:()=>({supported:input.emailSupported})}});
 const v1=await load('app/api/v1/settings/public/route.ts',{'@/lib/settings':settings,'@/lib/api':api,'@/lib/publicSiteUrl':origin});
 const v2=await load('app/api/v2/settings/public/route.ts',{'@/app/api/v1/settings/public/route':v1,'@/lib/appApiV2':wrapper});
 const output=[];
 for(const command of input.commands){const route=command.version===2?v2:command.version===1?v1:web;const url='https://public.example.invalid/api/'+(command.version?'v'+command.version+'/':'')+'settings/public';const request=new Request(url,{headers:command.headers||{}});const response=await route.GET(request);output.push({status:response.status,body:await response.json(),headers:Object.fromEntries(response.headers)});}
 process.stdout.write(JSON.stringify({sourceRoutes:true,actualOriginFunction:true,realV2Policy:true,providerAndDatabaseDisabled:true,discoveryBoundaryStubbed:true,authentications,results:output}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
