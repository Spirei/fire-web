const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm'),React=require('react');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function hooks(){
 const slots=[],effects=[];let cursor=0,queue=[];
 return {api:{...React,useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>slots[i]=typeof next==='function'?next(slots[i]):next];},useRef(initial){const i=cursor++;return slots[i]??=( {current:initial});},useCallback:f=>f,useEffect(fn,deps){const i=cursor++;if(!effects[i]||deps.some((v,j)=>v!==effects[i].deps[j]))queue.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});}},begin(){cursor=0;queue=[];},commit(){queue.forEach(fn=>fn());queue=[];},cleanup(){effects.forEach(e=>e?.cleanup?.());}};
}
const h=hooks(),requests=[],polls=[],toasts=[];
const transport=(url,options={})=>{const pending=deferred();requests.push({url,options,...pending});return pending.promise;};
class RequestError extends Error{}
const mocks={react:h.api,'react/jsx-runtime':require('react/jsx-runtime'),'@tabler/icons-react':{IconRefresh:'svg'},'./ServiceIcon':{__esModule:true,default:'i'},'./Capsule':{Capsule:'button',IconButton:'button'},'@/lib/platformRequest':{platformRequest:transport,PlatformRequestError:RequestError},'@/lib/randomId':{clientRequestId:()=> 'receipt-one'},'@/lib/toast':{showToast:(...args)=>toasts.push(args)},'@/lib/visiblePolling':{startVisiblePolling({read}){const c=new AbortController();const p={controller:c,refresh:()=>read(c.signal),stop:()=>c.abort()};polls.push(p);void read(c.signal);return p;}}};
const context={exports:{},require:id=>mocks[id],AbortController,Map};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('components/InterfaceChecks.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,context);
let props={active:true,ownerId:'owner-a',onSettings(){}};
const flatten=node=>Array.isArray(node)?node.flatMap(flatten):node&&typeof node==='object'?[node,...flatten(node.props?.children)]:[];
function render(change={},commit=true){props={...props,...change};h.begin();const tree=flatten(context.exports.default(props));if(commit)h.commit();return tree;}
const check={id:'futu:a',kind:'broker',label:'Synthetic broker A',state:'unknown',configured:true,canTest:true,points:[],scope:'connection',detail:'未检测',sourceRevision:'a'};
const action=tree=>tree.find(n=>n.type==='button'&&['检测','核对结果'].includes(n.props.children));
(async()=>{
 render();requests[0].resolve({items:[check]});await flush();let tree=render();assert(action(tree));
 const first=action(tree).props.onClick();assert.equal(requests[1].options.method,'POST');assert(action(render()).props.busy);
 render({active:false});assert(requests[1].options.signal.aborted);
 render({active:true});requests[2].resolve({items:[check]});await flush();tree=render();assert.equal(action(tree).props.busy,false,'returning to a workspace clears the aborted busy state');assert.equal(action(tree).props.children,'核对结果','unknown outcome retains its original receipt');
 const recovered=action(tree).props.onClick();assert(requests[3].url.includes('/receipts/receipt-one'));assert.equal(requests[3].options.method,undefined,'recovery only queries; it must not submit a second test');
 requests[1].resolve({state:'unknown'});await first;assert.equal(action(render()).props.busy,true,'old completion cannot unlock a newer operation');
 requests[3].resolve({state:'completed',ok:true,message:'连接成功'});await flush();requests[4].resolve({items:[{...check,state:'up'}]});await recovered;await flush();tree=render();assert.equal(action(tree).props.busy,false);assert.equal(action(tree).props.children,'检测');assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
 tree=render({ownerId:'owner-b'},false);assert(!tree.some(n=>n.props?.children==='Synthetic broker A'),'account changes hide old rows before effects run');h.commit();h.cleanup();
 console.log('PASS interface checks: aborted workspace recovers, unknown receipt is queried once, late completion cannot unlock a new request, and account rows never flash');
})().catch(e=>{console.error(e);process.exitCode=1;});
