const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync('lib/marketHistory.ts','utf8'),{compilerOptions:{module:1,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(read,{manualTimer=false}={}){
  let sequence=0,epoch=0;const calls=[],timers=new Map(),exports={};
  vm.runInNewContext(code,{exports,DOMException,setTimeout:fn=>{const id=Symbol();timers.set(id,fn);if(!manualTimer)queueMicrotask(()=>{if(timers.delete(id))fn()});return id;},clearTimeout:id=>timers.delete(id),require:id=>id==='./randomId'?{clientRequestId:()=>`request-${++sequence}`}:id==='./privateReadContext'?{accountReadHeaders:id=>id?{'X-Alcor-Expected-Account':id}:{},privateReadEpoch:()=>epoch}:{platformRequest:async(url,init)=>{calls.push([url,init]);return read(url,init)}}});
  return {run:exports.prepareMarketHistory,calls,timers,retire:()=>epoch++};
}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
  let polls=0;
  const h=fixture(async(url,init)=>url.endsWith('/prepare')?{requestId:JSON.parse(init.body).requestId}:{requestId:url.split('/').pop(),pending:++polls<3,failed:false,unavailable:[]});
  await h.run([{market:'CN',code:'002602'}],{minute:true,ownerId:'synthetic-owner'});
  assert.equal(h.calls.filter(([u])=>u.endsWith('/prepare')).length,1);
  assert.equal(h.calls.filter(([u])=>u.includes('/preparations/')).length,3);
  assert(h.calls.every(([,i])=>i.headers['X-Alcor-Expected-Account']==='synthetic-owner'));
  let source=0;
  const fallback=fixture(async(url,init)=>{if(url.endsWith('/prepare')){source++;return{requestId:JSON.parse(init.body).requestId}}return{requestId:url.split('/').pop(),pending:false,failed:source===1,unavailable:[]}});
  await fallback.run([{market:'CN',code:'002602'}]);
  assert.equal(source,2,'a confirmed failed source permits one distinct follow-up intent');
  assert.notEqual(JSON.parse(fallback.calls[0][1].body).requestId,JSON.parse(fallback.calls[2][1].body).requestId);
  const unknown=fixture(async()=>{throw Error('response lost')});
  await assert.rejects(unknown.run([{market:'US',code:'AAPL'}]),/response lost/);assert.equal(unknown.calls.length,1,'unknown mutation is never replayed');
  const stopped=new AbortController();
  const cancel=fixture(async(url,init)=>url.endsWith('/prepare')?{requestId:JSON.parse(init.body).requestId}:{requestId:url.split('/').pop(),pending:true,failed:false,unavailable:[]},{manualTimer:true});
  const waiting=cancel.run([{market:'US',code:'AAPL'}],{signal:stopped.signal});await tick();stopped.abort();
  await assert.rejects(waiting,e=>e.name==='AbortError');assert.equal(cancel.timers.size,0);assert.equal(cancel.calls.length,2);
  let stale;
  stale=fixture(async(url,init)=>{if(url.endsWith('/prepare'))return{requestId:JSON.parse(init.body).requestId};stale.retire();return{requestId:url.split('/').pop(),pending:false,failed:false,unavailable:[]}});
  await assert.rejects(stale.run([{market:'US',code:'AAPL'}]),e=>e.name==='AbortError');
  console.log('PASS history readiness: original task polling, confirmed fallback, no unknown replay, cancellation and context retirement');
})().catch(e=>{console.error(e);process.exitCode=1});
