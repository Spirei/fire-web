// Controlled React effects, timers and reads: no server or business fixture writes.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), ts=require('typescript');
const root=path.resolve(__dirname,'..');
require.extensions['.ts']=(m,file)=>m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const source=ts.transpileModule(fs.readFileSync(path.join(root,'lib/useQuotePoolSnapshot.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const snapshot=scope=>({scope,at:1000,entries:[{market:'HK',code:'00700',name:'腾讯控股',state:'dormant',lastRequestedAt:1000,expiresAt:604801000}]});
function harness(initial={mine:snapshot('mine'),shared:snapshot('shared')}){
  let cursor=0,nextTimer=0,dirty=false,scope='mine',active=true,result;
  const states=[],effects=[],timers=new Map(),listeners=new Map(),requests=[];
  const document={hidden:false,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
  const hooks={useState:value=>{const i=cursor++;if(!(i in states))states[i]=typeof value==='function'?value():value;return[states[i],next=>{const value=typeof next==='function'?next(states[i]):next;if(!Object.is(value,states[i])){states[i]=value;dirty=true;}}];},
    useRef:value=>{const i=cursor++;if(!(i in states))states[i]={current:value};return states[i];},
    useEffect:(fn,deps)=>{const i=cursor++,old=effects[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))effects[i]={deps,fn,cleanup:old?.cleanup,pending:true};}};
  const exports={};
  vm.runInNewContext(source,{exports,document,AbortController,Number,Object,Error,
    setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
    fetch:(url,init)=>new Promise((resolve,reject)=>requests.push({url,signal:init.signal,resolve,reject})),
    require:id=>id==='react'?hooks:require(path.join(root,'lib',id))});
  function render(){for(let turns=0;turns<10;turns++){dirty=false;cursor=0;result=exports.useQuotePoolSnapshot(initial,scope,active);for(const e of effects)if(e?.pending){e.pending=false;e.cleanup?.();e.cleanup=e.fn();}if(!dirty)return result;}throw Error('Render loop');}
  const drain=async()=>{for(let i=0;i<8;i++)await Promise.resolve();return render();};
  return {requests,timers,render,drain,get value(){return result;},setScope:s=>{scope=s;return render();},setActive:a=>{active=a;return render();},
    hide:hidden=>{document.hidden=hidden;listeners.get('visibilitychange')?.();return render();},
    tick:ms=>{const found=[...timers].find(([,t])=>t.ms===ms);assert(found,'timer '+ms);timers.delete(found[0]);found[1].fn();return render();},
    reply:(n,data=snapshot(requests[n].url.includes('shared')?'shared':'mine'))=>requests[n].resolve({ok:true,json:async()=>({data})}),
    close:()=>{for(const e of effects)e?.cleanup?.();assert.equal(listeners.size,0);assert.equal(timers.size,0);}};
}
(async()=>{
  let h=harness();h.render();assert.equal(h.requests.length,1);assert(!h.value.busy,'bootstrap background read is quiet');h.reply(0);await h.drain();
  h.tick(10000);assert.equal(h.requests.length,2);assert(!h.value.busy);h.hide(true);assert(h.requests[1].signal.aborted);
  h.hide(false);assert.equal(h.requests.length,2,'resume waits for aborted read to unwind');h.requests[1].reject(Error('aborted'));await h.drain();h.tick(0);assert.equal(h.requests.length,3);h.reply(2);await h.drain();
  h.value.refresh();h.render();assert.equal(h.requests.length,4);assert(h.value.busy,'manual read has feedback');h.reply(3);await h.drain();assert(!h.value.busy);h.close();
  console.log('PASS quiet polling, manual feedback, hidden cancellation and coalesced resume');
  h=harness();h.render();h.setScope('shared');assert(h.requests[0].signal.aborted);h.reply(1);await h.drain();
  const shared=h.value.snapshot;h.reply(0,{...snapshot('mine'),at:9000});await h.drain();assert.equal(h.value.snapshot,shared);assert.equal(h.value.snapshot.at,1000);
  h.setActive(false);assert(!h.value.busy);assert.equal(h.timers.size,0);h.setActive(true);assert.equal(h.requests.length,3);h.close();h.reply(2);await h.drain();assert.equal(h.timers.size,0);
  console.log('PASS scope switch, late response disposal and inactive observer cleanup');
  h=harness(null);h.render();assert(h.value.busy);h.tick(8000);assert(h.requests[0].signal.aborted);h.requests[0].reject(Error('aborted'));await h.drain();assert.equal(h.value.error,'股票池读取超时');assert(!h.value.busy);
  h.setScope('shared');assert.equal(h.value.error,'','scope errors stay local');h.reply(1,snapshot('mine'));await h.drain();assert.equal(h.value.snapshot,undefined);assert.equal(h.value.error,'股票池暂时无法读取');
  h.value.refresh();h.render();h.reply(2,snapshot('shared'));await h.drain();assert.equal(h.value.error,'');assert.equal(h.value.snapshot.scope,'shared');h.close();
  console.log('PASS bounded timeout, invalid scope rejection and explicit retry recovery');
})().catch(error=>{console.error(error);process.exitCode=1;});
