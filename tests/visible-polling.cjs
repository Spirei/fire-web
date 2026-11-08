const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(require.resolve('../lib/visiblePolling.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const flush = async () => { for(let i=0;i<12;i++) await Promise.resolve(); };
function harness(read, interval = () => 60000) {
  let now=100000, number=0;
  const timers=new Map(), events=new Map();
  const document={hidden:false,addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)};
  const module={exports:{}};
  new Function('module','exports','document','setTimeout','clearTimeout','Date',code)(module,module.exports,document,(fn,delay)=>{timers.set(++number,{at:now+delay,fn});return number},id=>timers.delete(id),{now:()=>now});
  const polling=module.exports.startVisiblePolling({read,interval});
  return {polling,timers,events,async visibility(hidden){document.hidden=hidden;events.get('visibilitychange')();await flush()},async advance(ms){const until=now+ms;for(;;){const row=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!row||row[1].at>until)break;now=row[1].at;timers.delete(row[0]);row[1].fn();await flush()}now=until;await flush()}};
}
(async()=>{
  let calls=0, interval=60000;
  const h=harness(async()=>{calls++;interval=300000},()=>interval);
  await flush();assert.equal(calls,1,'new server interval must not cause a second mount read');
  await h.advance(1000);await h.visibility(true);await h.visibility(false);
  assert.equal(calls,1,'brief tab switches retain a fresh observation');
  await h.advance(299000);assert.equal(calls,2,'next read uses the new server interval');
  await h.visibility(true);await h.advance(600000);assert.equal(calls,2,'hidden tabs stop all polling');
  await h.visibility(false);assert.equal(calls,3,'overdue data refreshes once on return');
  await h.visibility(true);await h.polling.refresh();await h.visibility(false);assert.equal(calls,4,'settings changes while hidden revalidate on return');
  h.polling.stop();await flush();assert.equal(h.timers.size,0);assert.equal(h.events.size,0);

  const requests=[];
  const slow=harness(signal=>new Promise((resolve,reject)=>{requests.push({signal,resolve});signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true})}));
  await flush();await slow.visibility(false);assert.equal(requests.length,1,'visibility cannot overlap an in-flight read');
  const a=slow.polling.refresh(), b=slow.polling.refresh();await flush();
  assert(requests[0].signal.aborted);assert.equal(requests.length,2,'repeated invalidations coalesce into one replacement');
  requests[1].resolve();await Promise.all([a,b]);await flush();
  await slow.advance(60000);assert.equal(requests.length,3);
  await slow.advance(30000);assert(requests[2].signal.aborted,'slow responses have a deadline');
  await slow.advance(60000);assert.equal(requests.length,4,'a timed-out request does not freeze future polling');
  await slow.visibility(true);await slow.visibility(false);assert.equal(requests.length,5,'an interrupted read is replaced on return');
  slow.polling.stop();await flush();assert(requests[4].signal.aborted);assert.equal(slow.timers.size,0);
  console.log('PASS visible polling: no duplicate interval read, due-only resume, coalescing, hidden cancellation, deadlines and cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
