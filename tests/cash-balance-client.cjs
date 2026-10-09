const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
function harness() {
  const timers = new Map(), requests = [], modules = new Map(); let sequence = 0;
  const load = name => {
    if (modules.has(name)) return modules.get(name);
    const exports = {}; modules.set(name, exports);
    const code = ts.transpileModule(fs.readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(code, {exports, require:id=>load(id.replace('./','')), AbortController,
      setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;}, clearTimeout:id=>timers.delete(id),
      fetch:(url,init)=>new Promise((resolve,reject)=>{
        requests.push({url,init,resolve,reject});
        const abort=()=>reject(new DOMException('Aborted','AbortError'));
        if(init.signal.aborted) abort(); else init.signal.addEventListener('abort',abort,{once:true});
      })}); return exports;
  };
  const client = load('cashBalanceClient'), currencies = load('fundCurrencies');
  return {client,requests,timers, state:()=>({balances:currencies.emptyFundBalances(),cardCash:{}}), reply:(i,data,status=200)=>requests[i].resolve({ok:status===200,json:async()=>status===200?{code:0,data}:{code:40901,message:'余额已变化'}}), timeout:()=>{for(const fn of [...timers.values()])fn();}};
}
(async()=>{
  const h=harness(), preview=h.client.cashEditPreview;
  assert.equal(preview('0',-20,0,false).changed,false,'untouched clamped zero cannot clear a negative balance');
  assert.equal(preview('0',-20,0,true).delta,20,'explicit zero reconciliation remains available');
  assert.equal(preview('100',120,20,true).changed,false,'reverting to original available cash is a no-op');
  assert.equal(preview('200',120,20,true).target,220); assert.equal(preview('200',120,20,true).delta,100);
  for(const [amount,balance,frozen] of [['',100,0],[' ',100,0],['bad',100,0],['-1',100,0],['1',null,0],['1',100,NaN],['1000000000000',100,1]]) assert.equal(preview(amount,balance,frozen,true).target,null);
  console.log('PASS intentional edits, zero/negative balances, frozen cash, reversions and invalid inputs');
  const first=h.client.requestCashState(); h.reply(0,h.state()); await first; assert.equal(h.timers.size,0);
  const malformed=h.client.requestCashState(); h.reply(1,{balances:{},cardCash:{}}); await assert.rejects(malformed,/现金余额/); assert.equal(h.timers.size,0);
  console.log('PASS bounded valid snapshots and rejection of malformed balance maps');
  const read=h.client.requestCashState(), rejectedRead=assert.rejects(read,/读取超时/); h.timeout(); await rejectedRead;
  assert.equal(h.requests.length,3); assert(h.requests[2].init.signal.aborted); assert.equal(h.timers.size,0);
  const body={currency:'USD',expectedBalance:100,targetBalance:200};
  const save=h.client.requestCashState(body), rejectedSave=assert.rejects(save,/结果尚未确认/); h.timeout(); await rejectedSave;
  assert.equal(h.requests.length,4); assert.equal(JSON.parse(h.requests[3].init.body).targetBalance,200); assert.equal(h.timers.size,0);
  console.log('PASS read/save timeouts abort once and never replay uncertain financial writes');
  const controller=new AbortController(), cancelled=h.client.requestCashState(undefined,controller.signal), rejection=assert.rejects(cancelled,error=>error.name==='AbortError'); controller.abort(); await rejection; assert.equal(h.timers.size,0);
  const conflict=h.client.requestCashState(body); h.reply(5,null,409); await assert.rejects(conflict,/余额已变化/); assert.equal(h.requests.length,6); assert.equal(h.timers.size,0);
  console.log('PASS caller cancellation and balance conflicts preserve explicit retry control');
})().catch(error=>{console.error(error);process.exitCode=1;});
