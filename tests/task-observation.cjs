const assert = require('node:assert/strict'), fs = require('node:fs');
const ts = require('typescript'), vm = require('node:vm');
const item = {id:'task-one', request_id:'request-one', kind:'database.migration.complete', status:'running'};
const calls = []; let response = item, delayed;
const exportsValue = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/taskObservation.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022},
}).outputText, {exports:exportsValue, require:()=>({platformRequest:async(path,init)=>{
  calls.push({path,headers:init.headers}); return delayed ? delayed() : response;
}})});
const observe = () => exportsValue.taskObservation('request-one', t=>t.kind===item.kind, 'mismatch');
(async()=>{
  const signal=new AbortController().signal, reader=observe();
  await reader(signal,{'x-csrf-token':'first'});
  response={...item,status:'succeeded'};
  assert.equal((await reader(signal,{'x-csrf-token':'renewed'})).status,'succeeded');
  assert.deepEqual(calls.map(c=>c.path),['/api/fire/tasks/receipts/request-one','/api/fire/tasks/task-one','/api/fire/tasks/task-one']);
  assert.equal(calls.at(-1).headers['x-csrf-token'],'renewed');
  for(const wrong of [{...item,request_id:'other'},{...item,kind:'backup.create'}]){
    calls.length=0;response=wrong;await assert.rejects(()=>observe()(signal,{}),/mismatch/);
    assert.equal(calls.length,1,'an invalid receipt must not resolve another task');
  }
  for(const wrong of [{...item,id:'other'},{...item,request_id:'other'},{...item,kind:'backup.create'}]){
    response=wrong;await assert.rejects(()=>reader(signal,{}),/mismatch/);
  }
  const controller=new AbortController(); calls.length=0;response=item;
  delayed=async()=>{controller.abort();return item;};
  await assert.rejects(()=>observe()(controller.signal,{}));
  assert.equal(calls.length,1,'leaving during receipt lookup must not fetch another task');
  delayed=undefined; calls.length=0;
  await observe()(signal,{});
  assert.equal(calls[0].path,'/api/fire/tasks/receipts/request-one','a new scope revalidates the receipt');
  console.log('PASS task observations resolve once, validate every response, use current authorization and stop after leaving');
})().catch(e=>{console.error(e);process.exitCode=1;});
