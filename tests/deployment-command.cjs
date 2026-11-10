const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const modules={};function load(name){if(modules[name])return modules[name];const m={exports:{}};modules[name]=m.exports;new Function('require','module','exports',ts.transpileModule(fs.readFileSync('lib/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>load(id.split('/').at(-1)),m,m.exports);return m.exports;}
const {DeploymentCommand}=load('deploymentCommand'),original=global.fetch;
(async()=>{let calls=[],lost=true,id;global.fetch=async(url,init={})=>{calls.push({url,init});if(init.method){const body=JSON.parse(init.body);id=body.request_id;assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(body.revision,null);if(lost){lost=false;throw new TypeError('lost');}}return Response.json({repository:'owner/repo',revision:'test-revision',hasToken:true});};const cmd=new DeploymentCommand('/config','PUT','/receipts');await assert.rejects(cmd.execute({revision:null,repository:'owner/repo',token:'synthetic'}));assert(cmd.pending);await cmd.execute({revision:null});assert.equal(calls.length,2);assert.equal(calls[1].url,'/receipts/'+id);assert(!calls[1].init.method);assert(!cmd.pending);
global.fetch=async()=>Response.json({error:'changed'},{status:409});await assert.rejects(cmd.execute({revision:null}));assert(!cmd.pending);
for (const state of ['running','unknown']) {
  calls=[];
  global.fetch=async(url,init={})=>{
    calls.push({url,init});
    return Response.json({status:state,request_id:JSON.parse(init.body).request_id});
  };
  const update=new DeploymentCommand('/container-update','POST','/requests',true);
  await update.execute({release:{revision:'target'}});
  assert(!update.pending);
  await update.execute({release:{revision:'target'}});
  assert.equal(calls.length,2);
  assert(calls.every(call=>call.init.method==='POST'));
  assert.notEqual(JSON.parse(calls[0].init.body).request_id,JSON.parse(calls[1].init.body).request_id);
}
calls=[];
let recoveredId;
global.fetch=async(url,init={})=>{
  calls.push({url,init});
  if(init.method){recoveredId=JSON.parse(init.body).request_id;throw new TypeError('lost');}
  assert.equal(url,'/requests/'+recoveredId);
  return Response.json({status:'unknown',request_id:recoveredId});
};
const update=new DeploymentCommand('/container-update','POST','/requests',true);
await assert.rejects(update.execute({release:{revision:'target'}}));
assert(update.pending);
await update.execute({release:{revision:'different-preview'}});
assert(!update.pending);
assert.equal(calls.length,2);
assert(!calls[1].init.method);
let unblock;
calls=[];
global.fetch=(url,init={})=>{
  calls.push({url,init});
  return new Promise(resolve=>{unblock=()=>resolve(Response.json({status:'running',request_id:JSON.parse(init.body).request_id}));});
};
const first=update.execute({release:{revision:'target'}}),second=update.execute({release:{revision:'target'}});
assert.equal(calls.length,1);
unblock();
await Promise.all([first,second]);
// Build requests continue to recover the original request instead of dispatching again.
calls=[];
let buildId;
global.fetch=async(url,init={})=>{
  calls.push({url,init});
  if(init.method) buildId=JSON.parse(init.body).request_id;
  return Response.json({status:'unknown',request_id:buildId});
};
const build=new DeploymentCommand('/builds','POST','/builds');
await build.execute({});await build.execute({});
assert.equal(calls[1].url,'/builds/'+buildId);
assert(!calls[1].init.method);
console.log('PASS deployment commands retain original UUID on lost saves and use receipt-only recovery; definitive conflicts allow explicit retry');})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>global.fetch=original);
