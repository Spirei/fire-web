const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),Module=require('node:module');
const file=path.resolve(__dirname,'../lib/recordsRefresh.ts'),compiled=new Module(file);
compiled._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {createRecordsRefresh,RECORDS_WORKSPACES}=compiled.exports;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function harness(){let time=0;const requests=[],applied=[],ownerChanges=[];
 const sync=createRecordsRefresh('owner',signal=>new Promise((resolve,reject)=>requests.push({signal,resolve,reject})),records=>applied.push(records),()=>time,()=>ownerChanges.push(true));
 return{sync,requests,applied,ownerChanges,advance:n=>time+=n};
}
let count=0;async function test(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
 await test('entry and repeated focus/pageshow events coalesce, including slow reads',async()=>{
  assert.deepEqual([...RECORDS_WORKSPACES],['holdings','watchlist','assets','pnl','fire','earnings']);
  const h=harness();h.sync.setActive(true);h.sync.resume();await tick();assert.equal(h.requests.length,1);
  h.advance(2000);h.sync.resume();h.sync.refresh();await tick();assert.equal(h.requests.length,1);
  h.requests[0].resolve({ownerId:'owner',records:['first']});await tick();assert.deepEqual(h.applied,[['first']]);
  h.advance(2000);h.sync.resume();h.sync.resume();await tick();assert.equal(h.requests.length,2);
  h.requests[1].resolve({ownerId:'owner',records:['app update']});await tick();assert.deepEqual(h.applied,[['first'],['app update']]);h.sync.dispose();
 });
 await test('hide/leave aborts; return reads once and rejects late pre-hide results',async()=>{
  const h=harness();h.sync.setActive(true);await tick();h.sync.setActive(false);assert(h.requests[0].signal.aborted);
  h.sync.resume();h.sync.refresh();await tick();assert.equal(h.requests.length,1);
  h.sync.setActive(true);await tick();assert.equal(h.requests.length,2);
  h.requests[0].resolve({ownerId:'owner',records:['old']});h.requests[1].resolve({ownerId:'owner',records:['fresh']});await tick();assert.deepEqual(h.applied,[['fresh']]);h.sync.dispose();
 });
 await test('local changes discard old snapshots without old finalizers clearing the new read',async()=>{
  const h=harness();h.sync.setActive(true);await tick();h.sync.changed();await tick();assert(h.requests[0].signal.aborted);
  h.requests[0].resolve({ownerId:'owner',records:['before save']});await tick();h.sync.refresh();await tick();assert.equal(h.requests.length,2);
  h.requests[1].resolve({ownerId:'owner',records:['saved']});await tick();assert.deepEqual(h.applied,[['saved']]);h.sync.dispose();
 });
 await test('owner mismatch or disposal never applies another account or late results',async()=>{
  const h=harness();h.sync.setActive(true);await tick();h.requests[0].resolve({ownerId:'other',records:['private']});await tick();assert.deepEqual(h.applied,[]);assert.equal(h.ownerChanges.length,1,'reload SSR identity to remount the correct account');
  h.sync.refresh();await tick();h.sync.dispose();assert(h.requests[1].signal.aborted);h.requests[1].resolve({ownerId:'other',records:['late']});await tick();assert.deepEqual(h.applied,[]);assert.equal(h.ownerChanges.length,1);
 });
 await test('failed background reads retain confirmed data with no retry loop',async()=>{
  const h=harness();h.sync.setActive(true);await tick();h.requests[0].reject(Error('offline'));await tick();assert.equal(h.requests.length,1);assert.deepEqual(h.applied,[]);
  h.advance(2000);h.sync.resume();await tick();assert.equal(h.requests.length,2);h.sync.dispose();
 });
 console.log(`PASS ${count} records refresh suites`);
})().catch(e=>{console.error(e);process.exitCode=1;});
