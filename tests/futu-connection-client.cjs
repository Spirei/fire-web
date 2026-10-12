// Controlled React effects and fetches: no OpenD connection, real settings or financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
function harness(){
 let cursor=0,host='192.168.28.41',port='11111',value,dirty=false,time=0,timerId=0;
 const states=[],effects=[],requests=[],timers=new Map();
 const hooks={
  useState(initial){const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],next=>{const v=typeof next==='function'?next(states[i]):next;if(!Object.is(v,states[i])){states[i]=v;dirty=true;}}];},
  useRef(initial){const i=cursor++;return states[i]||(states[i]={current:initial});},
  useEffect(fn,deps){const i=cursor++,old=effects[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))effects[i]={fn,deps,cleanup:old?.cleanup,pending:true};}
 };
 const exports={},code=ts.transpileModule(fs.readFileSync(path.join(root,'lib/useFutuConnectionStatus.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,require:()=>hooks,AbortController,Error,Number,JSON,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:time+ms});return id;},clearTimeout:id=>timers.delete(id),
  fetch:(url,init)=>new Promise((resolve,reject)=>{requests.push({url,init,resolve,reject});const abort=()=>reject(new Error('Aborted'));if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});})});
 function render(){for(let n=0;n<10;n++){cursor=0;dirty=false;value=exports.useFutuConnectionStatus(host,port);for(const e of effects)if(e?.pending){e.pending=false;e.cleanup?.();e.cleanup=e.fn();}if(!dirty)return value;}throw Error('Render loop');}
 const drain=async()=>{for(let i=0;i<20;i++)await Promise.resolve();return render();};
 return {render,drain,requests,timers,get value(){return value;},host(next){host=next;return render();},port(next){port=next;return render();},
  reply(i,data,status=200){requests[i].resolve({ok:status===200,json:async()=>data});},
  health(i=0,extra={}){this.reply(i,{data:{futuOpenD:{host:'192.168.28.41',port:11111,available:false,skipped:false,...extra}}});},
  tick(ms){time+=ms;for(const[id,t]of[...timers])if(t.at<=time){timers.delete(id);t.fn();}},close(){for(const e of effects)e?.cleanup?.();assert.equal(timers.size,0);}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
 await test('a successful test updates both badge and message, even if the old disconnected health read arrives later',async()=>{
  const h=harness();h.render();const test=h.value.test();assert.equal(h.render().label,'测试中…');h.reply(1,{ok:true,message:'连接成功，AAPL 报价 100'});await test;await h.drain();assert.equal(h.value.label,'已连接');assert.equal(h.value.online,true);assert.equal(h.value.result.ok,true);
  h.health();await h.drain();assert.equal(h.value.label,'已连接');h.close();
 });
 await test('a failed retest replaces an earlier success instead of leaving a green connected badge',async()=>{
  const h=harness();h.render();h.health();await h.drain();let p=h.value.test();h.reply(1,{ok:true});await p;h.render();p=h.value.test();h.reply(2,{ok:false,message:'端口未开放'});await p;h.render();assert.equal(h.value.label,'未连接');assert.equal(h.value.result.msg,'端口未开放');assert.equal(h.value.online,false);h.close();
 });
 await test('changing the host/port cancels tests, hides old results and rejects late replies',async()=>{
  const h=harness();h.render();h.health();await h.drain();const p=h.value.test();h.host('192.168.28.42');assert(h.requests[1].init.signal.aborted);assert.equal(h.value.label,'未测试');h.reply(1,{ok:true});await p;await h.drain();assert.equal(h.value.result,null);assert.equal(h.value.label,'未测试');
  h.host('192.168.28.41');assert.equal(h.value.label,'未连接');h.port('22222');assert.equal(h.value.label,'未测试');h.close();
 });
 await test('local automatic skipping does not contradict a successful explicit OpenD test',async()=>{
  const h=harness();h.render();h.health(0,{skipped:true});await h.drain();assert.equal(h.value.label,'本地跳过');const p=h.value.test();h.reply(1,{ok:true});await p;h.render();assert.equal(h.value.label,'已连接');assert.equal(h.value.skipped,true);h.close();
 });
 await test('malformed and forbidden responses cannot display connection success',async()=>{
  const h=harness();h.render();h.reply(0,{data:{futuOpenD:{}}});await h.drain();assert.equal(h.value.label,'检测失败');let p=h.value.test();h.reply(1,{});await p;h.render();assert.equal(h.value.online,false);assert.equal(h.value.result.msg,'连接测试响应无效');
  p=h.value.test();h.reply(2,{ok:true,error:'需要管理员权限'},403);await p;h.render();assert.equal(h.value.label,'检测失败');assert.equal(h.value.result.msg,'需要管理员权限');h.close();
 });
 await test('double clicks share one test; a timeout aborts once and permits an explicit retry',async()=>{
  const h=harness();h.render();h.health();await h.drain();const p=h.value.test();await h.value.test();assert.equal(h.requests.length,2);h.tick(15000);await p;await h.drain();assert(h.requests[1].init.signal.aborted);assert.equal(h.value.result.msg,'连接测试超时，请重试');assert.equal(h.timers.size,0);
  const next=h.value.test();h.reply(2,{ok:true});await next;h.render();assert.equal(h.value.label,'已连接');h.close();
 });
 await test('unmount cancels health/test requests and leaves no active timer',async()=>{
  const h=harness();h.render();const p=h.value.test();h.close();assert(h.requests[0].init.signal.aborted);assert(h.requests[1].init.signal.aborted);await p;await h.drain();assert.equal(h.value.result?.ok,undefined);assert.equal(h.timers.size,0);
 });
 console.log(`Futu connection client: ${passed} checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
