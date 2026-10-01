const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-first-frame-'));
process.chdir(temp);
process.env.STOCKLOG_FUTU = 'off';
global.fetch = async () => { throw Error('Network disabled in isolated SSR tests'); };
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
for (const ext of ['.ts','.tsx']) require.extensions[ext] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText, filename);
require.extensions['.css'] = () => {};
let query = new URLSearchParams();
let fourDoorEligible = true;
const fourDoorLoads = [];
const load = Module._load;
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root,'components/RecordsApp.tsx')) {
    if (id === '@/lib/useDesktopViewport') return {useDesktopViewport:()=>false,useFourDoorViewport:()=>fourDoorEligible,useTabletDevice:()=>false};
    if (id === 'react') return {...React,lazy:loader=>()=>{fourDoorLoads.push(loader.toString());throw new Promise(()=>{});}};
  }
  if (id === 'next/navigation') return {ReadonlyURLSearchParams:URLSearchParams,useSearchParams:()=>query,useRouter:()=>({push(){},replace(){},refresh(){}}),usePathname:()=>'/test'};
  // Password worker uses import.meta; it is irrelevant to settings navigation SSR.
  if (id === '@/components/PasswordStrength') return {__esModule:true,default:()=>null};
  if (id === 'next/dynamic') return {__esModule:true,default:()=>()=>null};
  return load.call(this,id,parent,...rest);
};
const { PrefsProvider } = require(path.join(root,'lib/prefsContext.tsx'));
function render(file, props={}, params='', prefs={}, name='default') {
  query = new URLSearchParams(params);
  const Component = require(path.join(root,file))[name];
  return renderToStaticMarkup(React.createElement(PrefsProvider,{initialPrefs:prefs},React.createElement(Component,props)));
}
let passed=0, failures=0;
function test(label,run){try{run();passed++;console.log('PASS '+label);}catch(error){failures++;console.error('FAIL '+label+'\n'+error.stack);}}
try {
  test('global conversion URL renders converter rather than default ranking before hydration',()=>{
    const html=render('components/views/GlobalPreviewView.tsx',{},'section=convert&from=USD&amount=250');
    assert(!html.includes('全球资产市值排行'));
    assert(html.includes('value="250"'));
    assert(html.includes('USD'));
    const foreign=render('components/FxConverter.tsx',{},'from=HKD&amount=250');
    assert(!foreign.includes("fx-converter-row is-active"));
    const fallback=render('components/views/GlobalPreviewView.tsx',{},'section=invalid');
    assert(fallback.includes('全球资产市值排行'));
  });
  test('request filters render their actual URL selection before hydration',()=>{
    const html=render('components/ApiRequests.tsx',{},`rQ=%2Fapi%2Fv3&rPeriod=year&rYear=${new Date().getUTCFullYear()-1}&rPage=3`);
    assert(html.includes('value="/api/v3"'));
    assert(html.includes(String(new Date().getUTCFullYear()-1)));
  });
  test('asset library classification and sort do not expose unrelated default stock snapshot',()=>{
    const props={initialAssets:[{id:'wrong-default',type:'stock',market:'US',code:'WRONG',name:'错误默认股票',url:''}],initialTotal:1};
    const html=render('components/views/AssetLibraryView.tsx',props,'tab=card&view=grid');
    assert(!html.includes('错误默认股票'));
    assert(html.includes('卡片'));
    assert(html.includes('卡片素材加载中'));
    assert(!html.includes('暂无卡片素材'));
    const filtered=render('components/views/AssetLibraryView.tsx',props,'market=HK&q=00700&sort=name&dir=asc&page=4');
    assert(filtered.includes('value="00700"'));
    assert(!filtered.includes('错误默认股票'));
  });
  test('attachments load requested category and report folder in server HTML',()=>{
    const html=render('components/views/AttachmentsView.tsx',{},'category=reports&view=HK/SEHK/00700/2025');
    assert(html.includes('00700'));
    assert(!html.includes('attachment-file-table'));
    assert.doesNotThrow(()=>render('components/LibraryAttachmentsView.tsx',{},'view=HK/%25broken/00700/NaN',{},'FinancialAttachments'));
  });
  test('earnings calendar URL selects market and stock type before client effects',()=>{
    const html=render('components/views/EarningsCalendarView.tsx',{initialNow:Date.UTC(2026,9,1)},'market=HK&type=hold');
    assert(html.includes('港股'));
    assert(html.includes('持仓'));
  });
  test('holdings direct detail URL renders the detail without the portfolio list first',()=>{
    const record={id:'holding-one',market:'US',code:'AAPL',name:'苹果',qty:'1',cost:'100',price:'100',source:'holdings',group:'',watchGroupId:'',note:'',updatedAt:''};
    const props={records:[record],quotes:{},livePrice:()=>100,groups:[],markets:['US'],marketLabels:[],marketOptions:[],onAddMatch(){},onUpdate(){},onRemove(){}};
    const html=render('components/views/HoldingsView.tsx',props,'market=US&symbol=US.AAPL&tab=company');
    assert(html.includes('苹果'));
    assert(!html.includes('前一日持仓盈亏'));
    assert(!html.includes('stock-overview'));
  });
  test('settings category URL is rendered without an empty shell or default home',()=>{
    const html=render('components/views/SettingsView.tsx',{user:{id:'u-first-frame',username:'fixture',role:'admin'},recordsCount:0,onExport(){},onClearAll(){},onTabsChange(){}},'category=website');
    fs.writeFileSync(path.join(temp,'settings.html'),html);
    assert(!html.includes('settings-home-welcome'));
    assert(html.includes('外观'));
    const detail=render('components/views/SettingsView.tsx',{user:{id:'fixture',username:'fixture',role:'admin'},recordsCount:0,onExport(){},onClearAll(){},onTabsChange(){}},'sub=palette&from=website');
    assert(detail.includes('role="dialog"'));
    assert(detail.includes('aria-label="外观"'));
  });
  test('saved chart range and style exist in SSR rather than flashing defaults',()=>{
    const html=render('components/StockKline.tsx',{market:'US',code:'AAPL'},'',{
      'fire:kline-view':{range:'MONTH',session:'REGULAR',minutes:5,allDay:false},
      'fire:kline-settings':{style:'candle',adjust:'none',indicators:['VOL'],maConfigs:[],maLinesVisible:false,showMAValues:true}
    });
    assert(html.includes('月K'));
    assert(html.includes('class="candle-icon"')); 
  });
  test('shared calendar preferences are applied to both server-rendered analysis pages',()=>{
    const prefs={'fire:asset-pnl-cal-market':'港股','fire:asset-pnl-cal-view':'year','fire:asset-pnl-cal-mode':'收益率','fire:asset-pnl-cal-month':{y:2024,m:3}};
    const html=render('components/AssetPnlAnalysis.tsx',{initialRecords:[],initialQuotes:{}},'',prefs);
    assert(html.includes('2024'));
    assert(html.includes('收益率'));
    const dashboard=render('components/AssetAnalysisDashboard.tsx',{positions:[],quotes:{},rates:{USD:1},livePrice:()=>0,currency:'USD',stockIcons:{},initialModuleOrder:{left:['funds','account'],right:['calendar','overview']}},'',prefs);
    assert(dashboard.includes('2024'));
    assert(dashboard.includes('style="order:0"'));
  });
  test('shared modal renders a stable first-frame dialog without browser globals',()=>{
    const html=render('components/AppModal.tsx',{title:'首屏弹窗',onClose(){},children:'详情内容'});
    assert(html.includes('role="dialog"'));
    assert(html.includes('详情内容'));
  });
  test('eligible navigator loading art matches saved style without starting browser effects',()=>{
    const file='components/FourDoorLoading.tsx';
    const first=render(file,{activeKey:'fire'});
    assert(first.includes('/four-door/window.png'));
    assert(first.includes('/four-door/dial.png'));
    assert(first.includes('rotate(-180deg)'));
    assert(!first.includes('<button'));
    const second=render(file,{activeKey:'assets'},'',{'fire:four-door-style':2});
    assert(second.includes('four-door-dial'));
    assert(!second.includes('/four-door/dial.png'));
    assert(second.includes('rotate(-90deg)'));
  });
  test('four-door appearance switch defaults off and restores the saved choice in server HTML',()=>{
    const file='components/PaletteSettings.tsx';
    const switchTag=html=>html.match(/<button[^>]*role="switch"[^>]*aria-label="四色门"[^>]*>/)?.[0];
    const first=switchTag(render(file));
    assert(first?.includes('aria-checked="false"'));
    const saved=switchTag(render(file,{},'',{'fire:four-door-enabled':true}));
    assert(saved?.includes('aria-checked="true"'));
    const disabled=switchTag(render(file,{},'',{'fire:four-door-enabled':false}));
    assert(disabled?.includes('aria-checked="false"'));
  });
  test('disabled four-door never initializes either resource loader even on an eligible desktop',()=>{
    const props={initialTab:'watchlist',initialNow:Date.UTC(2026,9,2),initialVersion:'test',initialUser:{id:'fixture',username:'fixture',role:'user'},initialRecords:[],initialUserLogs:[],initialFundBalances:{},initialSettings:{tabs:[],groups:[],markets:[],marketLabels:[],modelServices:[]},initialStockIcons:{}};
    const file='components/RecordsApp.tsx';
    fourDoorEligible=true;
    fourDoorLoads.length=0;
    for(const prefs of [{},{'fire:four-door-enabled':false},{'fire:four-door-enabled':'false'}]) {
      const html=render(file,props,'',prefs);
      assert(!html.includes('four-door-anchor')&&!html.includes('/four-door/'));
      assert.equal(fourDoorLoads.length,0,'neither lazy initializer may run while disabled');
    }
    const enabled=render(file,props,'',{'fire:four-door-enabled':true});
    assert(enabled.includes('four-door-anchor'));
    assert(fourDoorLoads.some(loader=>loader.includes('FourDoorNavigator')));
    assert(fourDoorLoads.some(loader=>loader.includes('FourDoorLoading')));
    fourDoorEligible=false;
    fourDoorLoads.length=0;
    const compact=render(file,props,'',{'fire:four-door-enabled':true});
    assert(!compact.includes('four-door-anchor'));
    assert.equal(fourDoorLoads.length,0,'saved enable must still respect device and viewport restrictions');
  });
  test('loading and render failure offer local feedback without changing the whole workspace',()=>{
    const loading=render('components/WorkspacePanel.tsx',{},'',{},'WorkspaceLoading');
    assert(loading.includes('role="status"'));
    assert(loading.includes('正在打开'));
    const shell=fs.readFileSync(path.join(root,'components/RecordsApp.tsx'),'utf8');
    assert(shell.includes('<WorkspacePanel active={active}'));
    const panel=fs.readFileSync(path.join(root,'components/WorkspacePanel.tsx'),'utf8');
    assert(panel.includes('getDerivedStateFromError'));
    assert(panel.includes('window.location.reload()'));
    const {WorkspaceBoundary}=require(path.join(root,'components/WorkspacePanel.tsx'));
    const failed=new WorkspaceBoundary({children:'broken'});failed.state={failed:true};
    const html=renderToStaticMarkup(failed.render());
    assert(html.includes('role="alert"')&&html.includes('重新加载')&&!html.includes('broken'));
    const decoration=new WorkspaceBoundary({children:'broken',fallback:React.createElement('span',null,'静态四色门')});decoration.state={failed:true};
    assert.equal(renderToStaticMarkup(decoration.render()),'<span>静态四色门</span>');
    assert(shell.includes('<WorkspaceBoundary fallback={<FourDoorLoading'));
  });
  test('cached workspace parameters stay isolated and hidden listeners cannot write another page URL',()=>{
    const vm=require('node:vm'),file=path.join(root,'lib/workspacePanel.tsx');
    const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
    const exports={},state={active:true,path:'/holdings',query:new URLSearchParams('market=HK'),saved:'market=HK',ref:null},window={location:{pathname:'/holdings'}};
    let contextId=0;
    vm.runInNewContext(output,{exports,window,require:id=>id==='react'?{
      createContext:initial=>({initial,id:contextId++}),useContext:context=>context.id===0?state.active:context.id===1?state.path:state.saved,
      useMemo:fn=>fn(),useRef:value=>state.ref||(state.ref={current:value}),useCallback:fn=>fn
    }:{ReadonlyURLSearchParams:URLSearchParams,useSearchParams:()=>state.query}});
    const first=exports.useWorkspaceSearchParams();state.active=false;state.query=new URLSearchParams('page=99&market=US');
    assert.equal(exports.useWorkspaceSearchParams(),first);assert.equal(first.get('market'),'HK');
    state.active=true;assert.equal(exports.useWorkspaceSearchParams(),state.query);
    state.ref=null;state.active=false;assert.equal(exports.useWorkspaceSearchParams().get('market'),'HK','late hidden mount must initialize from its own URL');
    state.active=true;
    state.ref=null;const guard=exports.useWorkspaceLocationGuard();assert.equal(guard(),true);
    window.location.pathname='/holdings/US.AAPL';assert.equal(guard(),true);
    window.location.pathname='/library';assert.equal(guard(),false);
    window.location.pathname='/holdings';state.active=false;exports.useWorkspaceLocationGuard();assert.equal(guard(),false);
    for(const name of ['AssetLibrary','CardLibrary','Celebs','EarningsCalendar','Holdings','Quotes','Settings']) {
      const source=fs.readFileSync(path.join(root,`components/views/${name}View.tsx`),'utf8');
      assert(source.includes('useWorkspaceLocationGuard'),name+' URL listeners must be workspace scoped');
    }
    assert(fs.readFileSync(path.join(root,'components/FxConverter.tsx'),'utf8').includes('readUrlState(start, searchParams)'));
    assert(fs.readFileSync(path.join(root,'components/StockDetailView.tsx'),'utf8').includes('const requested = searchParams.get("tab")'));
    const quotes=fs.readFileSync(path.join(root,'components/views/QuotesView.tsx'),'utf8');
    assert(/function writeFilterToUrl[^\n]*\n\s*if \(!canUseWorkspaceUrl\(\)\) return;/.test(quotes));
    const dashboard=fs.readFileSync(path.join(root,'components/AssetAnalysisDashboard.tsx'),'utf8');
    assert(/useEffect\(\(\) => \{\s*if \(!canUseWorkspaceUrl\(\)\) return;\s*const sp = new URLSearchParams/.test(dashboard));
  });
  test('celeb URL renders requested detail rather than the default gallery first',()=>{
    const {CELEBS}=require(path.join(root,'lib/celebs.ts'));
    const html=render('components/views/CelebsView.tsx',{},'celeb='+encodeURIComponent(CELEBS[0].id));
    assert(html.includes(CELEBS[0].name));
    assert(html.includes('返回'));
    const custom={...CELEBS[0],id:'custom-cache-person',name:'服务端缓存人物',holdings:[]};
    const snapshot=render('components/views/CelebsView.tsx',{initialData:{celebs:[custom],source:'cache',detail:{},updatedAt:''}},'celeb=custom-cache-person');
    assert(snapshot.includes('服务端缓存人物'));
    assert(snapshot.includes('返回'));
    const repeated=render('components/views/CelebsView.tsx',{initialData:{celebs:[custom],source:'cache',detail:{},updatedAt:''}},'celeb=custom-cache-person');
    assert.equal(snapshot,repeated,'chart IDs and detail HTML must be deterministic across server/client render');
  });
  test('celebrity first-frame snapshot does not seed rows or start external requests',()=>{
    const {getDb}=require(path.join(root,'lib/db.ts'));
    const db=getDb();
    const before=db.prepare('SELECT COUNT(*) AS n FROM celebs').get().n;
    const {getCelebsSnapshot}=require(path.join(root,'lib/celebsData.ts'));
    const snapshot=getCelebsSnapshot();
    assert(Array.isArray(snapshot.celebs));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM celebs').get().n,before);
    db.close();
  });
  console.log(`${passed} first-frame suites passed (no browser effects or real data writes)`);
  if(failures) process.exitCode=1;
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
