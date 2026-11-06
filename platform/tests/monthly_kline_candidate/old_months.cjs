const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const directory=path.join(__dirname,'../fixtures/monthly-kline-source');
function load(file, bindings){
  let source=fs.readFileSync(path.join(directory,file),'utf8');
  source=source.replace(/^import[^;]*;\s*/gm,'');
  source=stripTypeScriptTypes(source,{mode:'strip'}).replace(/export\s+(?=(?:async\s+)?function|const)/g,'');
  const context={URL,...bindings};vm.createContext(context);
  vm.runInContext(source+'\nthis.route=GET;',context,{timeout:1000});
  return context.route;
}
(async()=>{
  const results=[];
  for(const value of cases){
    const response=(body,opts={})=>({status:opts.status??200,body});
    const bindings={NextResponse:{json:response},clientIp:()=> 'synthetic',
      rateLimit:()=>!value.throttled,rateLimitGlobal:()=>true,
      ok:data=>response({code:0,message:'ok',data}),
      fail:(code,message,status)=>response({code,message},{status}),
      fetchMonthlyKline:async()=>{if(value.upstreamError)throw Error('synthetic');return value.series;}};
    const legacy=load('v1.ts',bindings);
    const route=value.version===2?load('v2.ts',{legacy:{GET:legacy},appV2Response:(_r,next)=>next()}):value.version===1?legacy:load('web.ts',bindings);
    results.push(await route({url:'http://example.invalid/api/kline?'+value.query}));
  }
  process.stdout.write(JSON.stringify(results));
})().catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
