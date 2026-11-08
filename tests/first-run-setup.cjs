const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),load=Module._load;
Module._load=function(id,parent,...rest){
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
  console.log('PASS setup follows backend token policy and receives server-rendered site Logo/favicon');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
  Module._load=load;
  if(oldNode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNode;
  if(oldEnvironment===undefined)delete process.env.FIRE_ENVIRONMENT;else process.env.FIRE_ENVIRONMENT=oldEnvironment;
});
