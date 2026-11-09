const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 const mocks={
  '@/lib/workspacePanel':{useWorkspaceSearchParams:()=>new URLSearchParams('section=convert&from=USD&amount=100'),useWorkspaceLocationGuard:()=>()=>true},
  '@/lib/currencyPrefs':{useDisplayCurrency:()=>({currency:'USD'})},
  '@/lib/usePersistedState':{usePersistedState:(_,value)=>React.useState(value)},
  '@/lib/useAssetIcons':{ensureFlagIcons:()=>undefined},
  '@/lib/toast':{showToast:()=>{}},
  '@/components/CurrencyFlag':{__esModule:true,default:({market})=>React.createElement('span',{'data-currency-flag':market})},
 };
 const req=id=>mocks[id]||(id.startsWith('@/')?load(path.resolve(id.slice(2)+(id.includes('CurrencyFlag')?'.tsx':'.ts'))):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id));
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports,require:req,URLSearchParams,AbortController,DOMException,setTimeout,clearTimeout});
 return exports;
}
const Fx=load(path.resolve('components/FxConverter.tsx')).default;
let html=renderToStaticMarkup(React.createElement(Fx,{initial:{data:{base:'USD',rates:{USD:1,EUR:.9},quoted:['USD','EUR'],updatedAt:12345678},checkedAt:Date.now()}}));
assert(!html.includes('加载中'),'Server-seeded rates do not flash loading');assert(/value="90(?:\.0+)?"/.test(html),'Known EUR quote is converted on the first frame');
assert.equal((html.match(/data-currency-flag=/g)||[]).length,14,'Every visible currency flag is rendered together');
html=renderToStaticMarkup(React.createElement(Fx,{initial:{data:{base:'USD',rates:{USD:1},quoted:[],updatedAt:null},checkedAt:Date.now()}}));
assert(!html.includes('加载中'));assert(html.includes('暂无汇率'),'Missing observations remain explicitly unknown');assert(!html.includes('value="90"'));
console.log('PASS FX first frame includes all visible flags and retained rates, without fabricating missing quotes or flashing loading');
