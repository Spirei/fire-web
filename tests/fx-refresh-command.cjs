const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const source=ts.transpileModule(fs.readFileSync('lib/fxRefreshCommand.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const id='11111111-1111-4111-8111-111111111111', task='22222222-2222-4222-8222-222222222222';
class PlatformRequestError extends Error{}
function harness(){
 const storage=new Map(),calls=[],waiters=[];let reply={id:task,state:'queued'};
 const exports={};
 vm.runInNewContext(source,{exports,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   setTimeout:fn=>{waiters.push(fn);return fn;},clearTimeout:fn=>{const n=waiters.indexOf(fn);if(n>=0)waiters.splice(n,1);},
   require:name=>name==='./randomId'?{clientRequestId:()=>id}:{PlatformRequestError,platformRequest:async(path,init)=>{
     calls.push({path,init});if(reply instanceof Error)throw reply;return {...reply,...(init.method==='POST'?{requestId:id}:{})};
   }}});
 return {api:exports,calls,storage,waiters,setReply:r=>{reply=r;},tick:()=>{waiters.shift()?.();}};
}
(async()=>{
 const h=harness(),controller=new AbortController();
 const first=h.api.refreshFxObservation(controller.signal); const observed=assert.rejects(first,/leave/);
 await Promise.resolve();await Promise.resolve();controller.abort(Error('leave'));await observed;
 assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1);
 assert.equal(h.storage.size,1,'leaving retains the original request');
 h.setReply({id:task,state:'completed',observation_id:'observed'});
 await h.api.refreshFxObservation(new AbortController().signal);
 assert.equal(h.calls.filter(c=>c.init.method==='POST').length,1,'returning only reads the existing operation');
 assert(h.calls[1].path.endsWith(id)); assert.equal(h.storage.size,0);
 console.log('PASS durable FX refresh across navigation without repeated provider requests');
 const other=harness();other.setReply({id:task,state:'failed'});
 await assert.rejects(other.api.refreshFxObservation(new AbortController().signal),/来源读取失败/);
 assert.equal(other.storage.size,0);
 other.storage.set('fire:fx-refresh:pending:v1',JSON.stringify({requestId:id,taskId:task}));
 other.setReply({id:'33333333-3333-4333-8333-333333333333',state:'completed',observation_id:'wrong'});
 await assert.rejects(other.api.refreshFxObservation(new AbortController().signal),/尚未确认/);
 assert.equal(other.calls.filter(c=>c.init.method==='POST').length,1,'a mismatched receipt does not enqueue another call');
 console.log('PASS failed and mismatched FX receipts cannot report success or silently replay');
})().catch(e=>{console.error(e);process.exitCode=1;});
