const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),load=Module._load;
const originalTs=require.extensions['.ts'];
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
Module._load=function(id,parent,...rest){
  if(id==='@/lib/randomId')return require('../lib/randomId.ts');
  if(id==='@/lib/platformRequest')return require('../lib/platformRequest.ts');
  if(parent?.filename===path.join(root,'app/setup/page.tsx')){
    if(id==='@/components/FirstRunSetup')return {__esModule:true,default:function FirstRunSetup(){}};
    if(id==='@/lib/auth')return {needsSetup:async()=>true};
    if(id==='@/lib/settings')return {getSiteSettings:async()=>({siteLogo:'/uploads/logo/custom.svg',ico:'/uploads/ico/custom.png'})};
    if(id==='next/navigation')return {redirect(){throw new Error('Unexpected redirect');}};
    if(id==='next/headers')return {cookies(){throw new Error('Unexpected cookie read');}};
  }
  return load.call(this,id,parent,...rest);
};
require.extensions['.tsx']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);
const oldNode=process.env.NODE_ENV,oldEnvironment=process.env.FIRE_ENVIRONMENT;
(async()=>{
  const SetupPage=require('../app/setup/page.tsx').default;
  process.env.NODE_ENV='production';
  for(const environment of ['local','test','staging','production']){
    process.env.FIRE_ENVIRONMENT=environment;
    const page=await SetupPage(),form=page.props.children;
    assert.equal(form.props.requireSetupToken,environment==='production','Token visibility follows the backend environment, not the Node build mode');
    assert.deepEqual(form.props.initialBrand,{logo:'/uploads/logo/custom.svg',favicon:'/uploads/ico/custom.png'},'Branding is present in the server first frame');
  }
  await testSiteSave();
  console.log('PASS setup follows backend token policy and receives server-rendered site Logo/favicon');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  Module._load=load;
  if(originalTs)require.extensions['.ts']=originalTs;else delete require.extensions['.ts'];
  if(oldNode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNode;
  if(oldEnvironment===undefined)delete process.env.FIRE_ENVIRONMENT;else process.env.FIRE_ENVIRONMENT=oldEnvironment;
});

async function testSiteSave(){
 const {SiteSettingsCommand}=require('../lib/siteSettingsCommand.ts');
 const originalFetch=global.fetch,calls=[];let revision=7,fail=false,conflict=false,id;
 global.fetch=async(url,init={})=>{
  calls.push({url,method:init.method||'GET',body:init.body&&JSON.parse(init.body)});
  if(url.includes('/operations/'))return Response.json({requestId:id,state:'completed'});
  if(!init.method)return Response.json({revision});
  const body=JSON.parse(init.body);id=body.requestId;
  assert.match(id,/^[0-9a-f-]{36}$/);if(body.revision!==revision)return Response.json({error:'版本已变化'},{status:409});
  assert.equal(body.currentPassword,'Synthetic9Pass');assert.equal(body.title,'Alcor');
  if(fail){fail=false;throw new TypeError('lost response');}
  if(conflict){conflict=false;revision++;return Response.json({error:'版本已变化'},{status:409});}
  return Response.json({requestId:id,operation:{requestId:id,state:'completed'}});
 };
 try{
  const patch={title:'Alcor',allowRegister:false},save=new SiteSettingsCommand();
  const first=save.save(patch,'Synthetic9Pass');assert.equal(save.save(patch,'Synthetic9Pass'),first);await first;
  assert.equal(calls.filter(c=>c.method==='PUT').length,1);assert.equal(save.pending,false);
  conflict=true;await assert.rejects(save.save(patch,'Synthetic9Pass'));assert.equal(save.pending,false);
  const previous=id;await save.save(patch,'Synthetic9Pass');assert.notEqual(id,previous);
  fail=true;await assert.rejects(save.save(patch,'Synthetic9Pass'));assert.equal(save.pending,true);
  const writes=calls.filter(c=>c.method==='PUT').length;
  await save.save(patch,'Synthetic9Pass');assert.equal(save.pending,false);
  assert.equal(calls.filter(c=>c.method==='PUT').length,writes,'Lost writes are recovered by receipt only');
  assert.match(calls.at(-1).url,/operations/);
  const readCount=calls.filter(c=>c.method==='GET'&&c.url==='/api/settings').length;
  await assert.rejects(save.save(patch,'Synthetic9Pass','',{revision:revision-1}));
  assert.equal(save.pending,false,'A stale editor revision fails without becoming an unknown command');
  assert.equal(calls.filter(c=>c.method==='GET'&&c.url==='/api/settings').length,readCount,'An editor keeps its original revision instead of silently refreshing it at save time');
  console.log('PASS first-run save carries admin proof, revision and original UUID; concurrent clicks coalesce and lost responses recover without another write');
 }finally{global.fetch=originalFetch;}
}
