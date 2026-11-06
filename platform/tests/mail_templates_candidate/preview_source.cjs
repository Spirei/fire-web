// Executes only the two pure legacy template modules in an isolated VM.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root=process.argv[2];if(!root)throw Error('Explicit source directory required');
const context=vm.createContext({URL,process:{env:{NODE_ENV:'test'}}});
async function load(name,deps){const filename=path.join(root,name),mod=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(filename,'utf8'),{mode:'transform'}),{context,identifier:name});await mod.link(async dep=>{if(!(dep in deps))throw Error('Unapproved module '+dep);return deps[dep];});await mod.evaluate();return mod;}
(async()=>{
 const model=await load('lib/mailTemplateModel.ts',{}),renderer=await load('lib/mailTemplateRenderer.ts',{'./mailTemplateModel':model});
 const values={email:'client@example.com',siteName:'Alcor',name:'客户',minutes:30,stockName:'苹果',stockCode:'AAPL',market:'US',currentPrice:'340.35',targetPrice:'340.00',currency:'USD',direction:'涨至',session:'盘后',quoteTime:'2026-10-21 16:05:00 美东',triggerTime:'10/21 16:05 美东',code:'593255',url:'http://testserver/verify-email?preview=1'};
 const entries=[];
 for(const preset of model.namespace.DEFAULT_MAIL_TEMPLATES){
  for(const modified of [false,true]){
   const raw=JSON.parse(JSON.stringify(preset));
   if(modified){raw.title='Text <script> & "quotes"';raw.body='{{email}} / {{minutes}}\n<strong>safe</strong>';raw.signature='';}
   const template=model.namespace.validateMailTemplate(raw),v={...values};if(template.kind==='link')v.nativeToken='PREVIEW-ONLY-NOT-A-REAL-CREDENTIAL';
   entries.push({template,values:v,rendered:renderer.namespace.renderMailTemplate(template,v,'/api/system-assets/mail-banner')});
  }
 }
 console.log(JSON.stringify(entries));
})().catch(e=>{console.error(e.stack||e);process.exit(1)});
