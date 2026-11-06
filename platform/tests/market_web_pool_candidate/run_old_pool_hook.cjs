// Execute the actual old hook with controlled React/browser/fetch; no DOM/network.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const states=[],effects=[];let index=0;
const react={useRef:value=>({current:value}),useState:initial=>{const slot=index++;states[slot]=initial;return [initial,value=>{states[slot]=typeof value==='function'?value(states[slot]):value;}];},useEffect:callback=>{effects.push(callback());}};
function compile(file,dependencies){const module={exports:{}};const context=vm.createContext({module,exports:module.exports,AbortController,document:{hidden:false,addEventListener(){},removeEventListener(){}},setTimeout:()=>1,clearTimeout(){},fetch:async()=>Response.json(input.body,{status:input.status??200}),require(name){if(!(name in dependencies))throw Error('Forbidden dependency '+name);return dependencies[name];}});vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);return module.exports;}
const code=compile('lib/marketCode.ts',{}),demand=compile('lib/quoteDemand.ts',{'./marketCode':code}),view=compile('lib/quotePoolView.ts',{'./quoteDemand':demand});
const hook=compile('lib/useQuotePoolSnapshot.ts',{'react':react,'./quotePoolView':view});
hook.useQuotePoolSnapshot(input.initial??null,input.scope??'mine',true);
(async()=>{await new Promise(resolve=>setImmediate(resolve));const result={accepted:!!states[0]?.[input.scope??'mine'],failure:states[3],retainedInitial:!!input.initial&&JSON.stringify(states[0])===JSON.stringify(input.initial)};for(const cleanup of effects)if(typeof cleanup==='function')cleanup();process.stdout.write(JSON.stringify(result));})().catch(error=>{console.error(error);process.exitCode=1;});
