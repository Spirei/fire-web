// Executes captured route and model with isolated storage/identity boundaries.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root=process.argv[2],fixture=process.argv[3];
const context=vm.createContext({Buffer,Error,Request,Response,URL,Headers});
async function load(file,deps){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'}),{context,identifier:file});await m.link(async key=>{if(!(key in deps))throw Error('unapproved import');const value=deps[key];return new vm.SyntheticModule(Object.keys(value),function(){for(const name of Object.keys(value))this.setExport(name,value[name]);},{context});});await m.evaluate();return m.namespace;}
(async()=>{
 const model=await load(path.join(root,'lib/mailTemplateModel.ts'),{});
 let templates=model.DEFAULT_MAIL_TEMPLATES,revoked=false;
 const route=await load(fixture,{
  'next/server':{NextResponse:{json:(data,init)=>new Response(JSON.stringify(data),init)}},
  '@/lib/auth':{getAuthUser:r=>revoked?null:r.headers.get('x-test-role')?{role:r.headers.get('x-test-role')}:null,isAdmin:u=>u?.role==='admin',isTrustedMutationRequest:r=>r.headers.get('origin')!=='https://other.invalid'},
  '@/lib/mailTemplates':{readMailTemplates:()=>templates,saveMailTemplate:raw=>{const t=model.validateMailTemplate(raw);templates=templates.map(old=>old.id===t.id?t:old);return templates;}},
  '@/lib/requestBody':{readJsonBody:async r=>{const raw=await r.text();if(Buffer.byteLength(raw)>16384)throw Error('request body too large');if(r.headers.get('x-revoke'))revoked=true;try{return JSON.parse(raw);}catch{return null;}}}
 });
 const results=[];
 const cases=[['GET',null,null],['GET','user',null],['GET','admin',null],['PUT','admin',{...templates[0],subject:'synthetic {{siteName}}'}],['PUT','admin',null],['PUT','admin',{}],['PUT','admin',{...templates[0],body:'{{unknown}}'}]];
 for(const [method,role,body]of cases){const headers={};if(role)headers['x-test-role']=role;const r=await route[method](new Request('http://testserver/api/settings/mail-templates',{method,headers,...(method==='PUT'?{body:JSON.stringify(body)}:{})}));results.push({method,role,input:body,status:r.status,body:await r.json()});}
 console.log(JSON.stringify(results));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
