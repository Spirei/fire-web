const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
let response,observed;
const exportsValue={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/analysisOrders.ts','utf8'),{compilerOptions:{module:1}}).outputText,{
  exports:exportsValue,require:name=>name.endsWith('privateReadContext')?{accountReadHeaders:owner=>({'X-Alcor-Expected-Account':owner})}:{platformRequest:async(path,init)=>{observed={path,init};return response;}}
});
(async()=>{
  const orders=Array.from({length:451},(_,i)=>({id:'synthetic-order-'+i,recordId:'synthetic-record'}));
  response={code:0,data:{orders,coverage:{authority:'source-originals'}}};
  const signal=new AbortController().signal;
  assert.equal(await exportsValue.readAnalysisOrders('owner-uuid',signal),orders);
  assert.equal(observed.path,'/api/v1/orders?scope=all&limit=5000');
  assert.equal(observed.init.headers['X-Alcor-Expected-Account'],'owner-uuid');assert.equal(observed.init.signal,signal);
  for(const invalid of [{orders},{code:0,data:{}},{code:40301,data:{orders:[]}}]){
    response=invalid;await assert.rejects(exportsValue.readAnalysisOrders('owner-uuid'),/历史订单格式无效/);
  }
  response={code:0,data:{orders:[]}};assert.equal((await exportsValue.readAnalysisOrders('owner-uuid')).length,0);
  console.log('PASS analysis history: wrapped v1 orders, 451 source rows, owner/cancellation binding, invalid responses never become empty history');
})().catch(error=>{console.error(error);process.exitCode=1});
