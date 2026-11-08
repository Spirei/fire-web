const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const source=ts.createSourceFile('UserMenu.tsx',fs.readFileSync(require.resolve('../components/UserMenu.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let effect;
(function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('let lastCheck'))effect=node.arguments[0];ts.forEachChild(node,visit)})(source);
assert(effect);
const code=ts.transpileModule('exports.run='+effect.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
function harness(initialUser){
 let now=100000,calls=0;
 const events=new Map(),timers=new Set(),redirects=[];
 const context={exports:{},initialUser,goTo:undefined,AbortController,Date:{now:()=>now},rootRef:{current:null},router:{replace:p=>redirects.push(p)},setUser(){},setReady(){},document:{hidden:false,addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)},window:{setInterval:f=>{timers.add(f);return f},clearInterval:f=>timers.delete(f),addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)},fetch:async()=>{calls++;return new Response(JSON.stringify({user:initialUser}),{status:context.status||200})}};
 vm.runInNewContext(code,context);const cleanup=context.exports.run();
 return {context,cleanup,events,timers,redirects,get calls(){return calls},advance:ms=>now+=ms};
}
(async()=>{
 const h=harness({id:'owner'});await flush();assert.equal(h.calls,0,'fresh server identity removes the duplicate mount POST');
 h.events.get('focus')();await flush();assert.equal(h.calls,0);
 h.advance(60001);h.events.get('focus')();h.events.get('visibilitychange')();await flush();assert.equal(h.calls,1,'simultaneous focus and visibility checks coalesce');
 h.events.get('fire:user-updated')();await flush();assert.equal(h.calls,2,'explicit profile updates still reload immediately');
 h.context.status=401;h.advance(60001);h.events.get('focus')();await flush();assert.deepEqual(h.redirects,['/login'],'expired sessions are still rejected');
 h.cleanup();assert.equal(h.events.size,0);assert.equal(h.timers.size,0);
 const guest=harness(null);await flush();assert.equal(guest.calls,1,'a visitor without a server identity still checks the session');guest.cleanup();
 console.log('PASS account menu: server identity skips mount read, due-only resume, explicit updates, expiry and cleanup');
})().catch(error=>{console.error(error);process.exitCode=1});
