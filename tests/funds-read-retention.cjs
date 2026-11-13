const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const source=ts.createSourceFile('FundsPanel.tsx',fs.readFileSync('components/FundsPanel.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const arrows={};
function visit(node){
 if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)){
  if(node.name.text==='load')arrows.load=node.initializer.arguments[0];
  if(node.name.text==='refresh')arrows.refresh=node.initializer;
 }
 if(ts.isCallExpression(node)&&node.expression.getText(source)==='useLayoutEffect'&&!arrows.reset)arrows.reset=node.arguments[0];
 ts.forEachChild(node,visit);
}
visit(source);
function compile(text){const m={exports:{}};new Function('exports',ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(m.exports);return m.exports;}
const {PlatformRequestError}=compile(fs.readFileSync('lib/platformRequest.ts','utf8'));
function actual(name,deps){const keys=Object.keys(deps);return compile(`exports.make=({${keys.join(',')}})=>(${arrows[name].getText(source)});`).make(deps);}
function harness(){
 let epoch=0,now=1000,reply=async()=>({code:0,data:{balances:{USD:127},cardCash:{USD:0},summaries:{USD:{openingAsset:100}}}});
 const state={},notifications=[],balanceRequest={current:null},balanceReceiptAt={current:null};
 const deps={foreground:true,ownerId:'synthetic-owner',balanceRequest,balanceReceiptAt,BALANCE_RETAIN_MS:300000,Date:{now:()=>now},
  privateReadEpoch:()=>epoch,accountReadHeaders:id=>({'X-Alcor-Expected-Account':id}),AbortController,PlatformRequestError,
  platformRequest:async(path,init)=>{assert.equal(init.headers['X-Alcor-Expected-Account'],'synthetic-owner');return reply(path,init);},
  EMPTY:{USD:null},EMPTY_SUMMARY:{USD:{openingAsset:null}},recordsCache:{current:new Map()},recordsRequest:{current:null},
  onBalancesChange:(balances,cards)=>notifications.push({balances,cards}),
  setBalances:x=>state.balances=x,setSummaries:x=>state.summaries=x,setTransactions:x=>state.transactions=x,
  setRecordsTotal:x=>state.recordsTotal=x,setRecordsLoading:x=>state.recordsLoading=x,
  setRecordsReadVersion:()=>{},setReadError:x=>state.error=x};
 const load=actual('load',deps),reset=actual('reset',deps),refresh=actual('refresh',{...deps,load});reset();
 return{state,notifications,load,reset,refresh,balanceRequest,balanceReceiptAt,
  reply:fn=>reply=fn,advance:ms=>now+=ms,changeScope:()=>{epoch++;reset();}};
}
const unavailable=()=>{const e=new PlatformRequestError('Synthetic temporary read failure');e.status=503;e.transient=true;return e;};
(async()=>{
 const h=harness();await h.load();assert.equal(h.state.balances.USD,127);
 const count=h.notifications.length;h.reply(async()=>{throw unavailable();});await h.load();
 assert.equal(h.state.balances.USD,127);assert.equal(h.notifications.length,count,'temporary failure cannot overwrite the accepted book with unknown');
 assert.match(h.state.error,/temporary/);
 h.reply(async()=>({code:0,data:{balances:{USD:130},cardCash:{USD:0},summaries:{}}}));await h.load();
 assert.equal(h.state.balances.USD,130);assert.equal(h.state.error,'');
 const denied=new PlatformRequestError('Synthetic revoked account');denied.status=403;
 h.reply(async()=>{throw denied;});await h.load();assert.equal(h.state.balances.USD,null);assert.equal(h.balanceReceiptAt.current,null);
 const expired=harness();await expired.load();expired.reply(async()=>{throw unavailable();});expired.advance(300001);await expired.load();
 assert.equal(expired.state.balances.USD,null,'temporary errors never extend the accepted financial receipt lifetime');
 const unknown=harness();await unknown.load();unknown.reply(async()=>({code:0,data:{balances:{USD:null}}}));await unknown.load();
 assert.equal(unknown.state.balances.USD,null,'a successful authoritative unknown must replace the older value');
 const invalid=harness();await invalid.load();invalid.reply(async()=>({code:0,data:{balances:{USD:'not a financial number'}}}));await invalid.load();
 assert.equal(invalid.state.balances.USD,null,'invalid successful data must not enter retained transient handling');
 const changed=harness();await changed.load();changed.reply(async()=>{throw unavailable();});changed.refresh();
 await changed.balanceRequest.current.promise;assert.equal(changed.state.balances.USD,null,'confirmed financial changes retire the old book even when revalidation fails');
 const late=harness();let release;late.reply(()=>new Promise(resolve=>release=resolve));const pending=late.load();late.changeScope();
 release({code:0,data:{balances:{USD:999}}});await pending;
 assert.equal(late.state.balances.USD,null,'late results cannot cross an owner or source epoch');
 console.log('PASS actual FundsPanel reads: retain same-scope temporary failures, accept new values, retire denied/unknown/invalid/changed scopes and late replies');
})().catch(error=>{console.error(error);process.exitCode=1;});
