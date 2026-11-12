const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const modules=new Map();let request;
function load(name){
  if(modules.has(name))return modules.get(name);
  const exports={};modules.set(name,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/'+name+'.ts','utf8'),{compilerOptions:{module:1,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:id=>id==='@/lib/platformRequest'?{platformRequest:async(url,init)=>{if(!init?.method)return{revision:7,privateRevision:4};request=JSON.parse(init.body);return{requestId:request.requestId,operation:{requestId:request.requestId,state:'completed'}}},PlatformRequestError:class extends Error{}}:id==='@/lib/randomId'?{clientRequestId:()=> '12345678-1234-4123-8123-123456789abc'}:load(id.replace(/^@\/lib\//,''))});
  return exports;
}
(async()=>{
 const {sourceSettingsPatch}=load('sourceSettingsPatch');
 const fields=['quoteApiUrl','searchApiUrl','chartApiUrl','currencyApiUrl'];
 const merged={quoteApiUrl:'https://qt.gtimg.cn/q=',searchApiUrl:'https://smartbox.gtimg.cn/s3/?q={q}',chartApiUrl:'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}',currencyApiUrl:' https://rates.example.invalid/latest?app_id=synthetic-only '};
 const patch=sourceSettingsPatch(fields,new Set(['currencyApiUrl']),merged);
 assert.deepEqual(Object.keys(patch),['currencyApiUrl']);assert.equal(patch.currencyApiUrl,merged.currencyApiUrl.trim());
 assert.equal(Object.keys(sourceSettingsPatch(fields,new Set(),merged)).length,0,'partial settings must not turn displayed defaults into provider edits');
 assert.equal(Object.keys(sourceSettingsPatch(['earningsApiUrl'],new Set(['currencyApiUrl']),merged)).length,0,'one section cannot submit edits from another section');
 const {SiteSettingsCommand}=load('siteSettingsCommand');
 await new SiteSettingsCommand('synthetic-owner').save({...patch,currencyApproved:true,currencyRevision:1},'verified-session-v1');
 assert.equal(request.currencyApiUrl,merged.currencyApiUrl.trim());
 assert(!('chartApiUrl' in request)&&!('quoteApiUrl' in request)&&!('searchApiUrl' in request),'saving FX with unconfigured quote adapters submits only the explicitly edited URL');
 assert.equal(request.currencyRevision,1);assert.equal(request.revision,7);assert.equal(request.privateRevision,4);
 console.log('PASS source settings: partial/redacted defaults stay untouched; FX-only save preserves owner, approvals and revisions');
})().catch(e=>{console.error(e);process.exitCode=1});
