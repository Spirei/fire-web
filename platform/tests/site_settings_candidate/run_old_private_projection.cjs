const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {isIP}=require('node:net'),{stripTypeScriptTypes}=require('node:module');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const forbidden=()=>{throw Error('No old database, transport or provider execution');};
const context=vm.createContext({URL,Request,Response,Headers,console,process:{env:{NODE_ENV:'production'}}});
async function load(file,deps){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,file),'utf8'),{mode:'transform'}),{context});await m.link(async name=>{if(!(name in deps))throw Error('Forbidden dependency '+name);const value=deps[name];return new vm.SyntheticModule(Object.keys(value),function(){for(const key of Object.keys(value))this.setExport(key,value[key]);},{context});});await m.evaluate();return m.namespace;}
(async()=>{
 const before=JSON.stringify(input.settings);
 const verification=await load('lib/emailVerification.ts',{'node:crypto':crypto,'node:net':{isIP},'./db':{getDb:forbidden},'./settings':{getSiteSettings:forbidden}});
 const origin=await load('lib/publicSiteUrl.ts',{'./emailVerification':verification});
 const client=await load('lib/settingsClient.ts',{'./publicSiteUrl':origin});
 const admin=client.clientSettings(input.settings,true),member=client.clientSettings(input.settings,false);
 process.stdout.write(JSON.stringify({sourceProjection:true,providerAndDatabaseDisabled:true,sourceUnchanged:before===JSON.stringify(input.settings),admin,member}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
