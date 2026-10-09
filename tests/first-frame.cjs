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
test('feed SSR bootstraps only shared navigation and never reads the default timeline',()=>{
  const layout=fs.readFileSync(path.join(root,'app/[...slug]/layout.tsx'),'utf8');
  assert(layout.includes('feedBootstrap(user.id)'));assert(!layout.includes('feedSnapshot(user.id)'));
  const initial={groups:[{id:'default',name:'默认特朗普组',mode:'people',people:['trump']},{id:'fg-0123456789abcdef01234567',name:'当前段永平组',mode:'people',people:['duan']}],capabilities:{generate:false,search:'news-rss',avatar:{image:'/local-mascot.png',video:null}}};
  const html=render('components/views/FeedView.tsx',{initial},'feedGroup=fg-0123456789abcdef01234567&feedPerson=duan');
  assert(html.includes('<h1>当前段永平组</h1>'));assert(html.includes('aria-label="段永平" aria-pressed="true"'));
  assert(!html.includes('aria-label="特朗普"'));assert(html.includes('正在加载动态'));assert(!html.includes('还没有可显示的原帖'));
});
// Retain hook state between renders while deliberately never running effects.
// This catches a wrong frame that a later layout/passive effect could conceal.
function frameHarness(file, overrides={}) {
  const states=[],refs=[],effects=[];
  let cursor=0;
  const hooks={...React,
    useState:initial=>{const i=cursor++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return[states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next;}];},
    useRef:initial=>{const i=cursor++;return refs[i]||(refs[i]={current:initial});},
    useMemo:fn=>fn(),useCallback:fn=>fn,useId:()=>':frame:',
    useEffect:fn=>effects.push(fn),useLayoutEffect:fn=>effects.push(fn)
  };
  const exports={};
  const output=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  require('node:vm').runInNewContext(output,{exports,URL,URLSearchParams,Date,Number,Set,Map,window:global.window,
    require:id=>id==='react'?hooks:overrides[id]||require(id.startsWith('@/')?path.join(root,id.slice(2)):id)
  });
  return {states,effects,render(props={}){cursor=0;effects.length=0;return exports.default(props);}};
}
function elements(tree) {
  if(Array.isArray(tree))return tree.flatMap(elements);
  if(!tree||typeof tree!=='object'||!tree.props)return[];
  return[tree,...elements(tree.props.children)];
}
try {
  test('quote pool restores private scope, market, search and selected stock in its first frame',()=>{
    const at=Date.UTC(2026,9,4), hk={market:'HK',code:'00700',name:'腾讯控股',icon:'/hk.svg',state:'dormant',updating:false,lastRequestedAt:at,expiresAt:at+604800000};
    const us={...hk,market:'US',code:'AAPL',name:'Apple',icon:'/us.svg'};
    const initial={mine:{scope:'mine',at,entries:[hk]},shared:{scope:'shared',at,entries:[hk,us]}};
    const props={initial,admin:true,onNavigate:()=>{}};
    const html=render('components/views/QuotePoolView.tsx',props,'scope=mine&m=HK&q=腾讯&stock=HK.00700');
    assert(html.includes('腾讯控股')&&html.includes('/hk.svg')&&!html.includes('Apple'));
    assert(html.includes('value="腾讯"')&&html.includes('aria-label="关闭股票信息"'));
    assert(html.includes('aria-label="收纳盒，1 个已入池标的"'));
    assert(!html.includes('正在读取股票池')&&!html.includes('盒子还是空的'));
    assert(!html.includes('pool-back'),'stock pool is a first-level workspace, without a global return button');
    const ordinary=render('components/views/QuotePoolView.tsx',{...props,admin:false},'scope=shared');
    assert(ordinary.includes('腾讯控股')&&!ordinary.includes('Apple')&&!ordinary.includes('共享池'));
    const jp=render('components/views/QuotePoolView.tsx',props,'m=JP');
    assert(!jp.includes('pool-token-slot')&&jp.includes('暂无订阅股票'));
    const excluded=render('components/views/QuotePoolView.tsx',props,'m=HK&s=hot&stock=HK.00700');
    assert(!excluded.includes('pool-selection-close')&&!excluded.includes('pool-row-detail'),'filtered selection cannot survive visually');
    assert(html.includes('最近请求')&&html.includes('释放时间')&&html.includes('pool-row-detail'));
    assert(html.includes('aria-label="清空股票搜索"')&&html.includes('aria-expanded="true"'));
  });
  test('quote pool waits for IME completion and clears page/selection when the query changes',()=>{
    const previousWindow=global.window, at=Date.UTC(2026,9,4), calls=[];
    global.window={location:{pathname:'/quote-pool',search:'?p=2&stock=HK.00700'},history:{replaceState:(_state,_title,url)=>calls.push(url)}};
    query=new URLSearchParams('p=2&stock=HK.00700');
    const snapshot={scope:'mine',at,entries:[{market:'HK',code:'00700',name:'腾讯控股',state:'dormant',lastRequestedAt:at,expiresAt:at+604800000}]};
    try {
      const harness=frameHarness('components/views/QuotePoolView.tsx',{
        '@/lib/workspacePanel':{useWorkspaceActive:()=>false,useWorkspaceLocationGuard:()=>()=>true,useWorkspaceSearchParams:()=>query},
        '@/lib/useQuotePoolSnapshot':{useQuotePoolSnapshot:()=>({snapshot,visible:true,busy:false,error:'',refresh(){}})}
      });
      const props={admin:false,onNavigate(){}};
      let tree=harness.render(props), input=elements(tree).find(e=>e.type==='input');
      input.props.onCompositionStart();input.props.onChange({target:{value:'腾'}});
      tree=harness.render(props);input=elements(tree).find(e=>e.type==='input');
      assert.equal(input.props.value,'腾');assert.equal(calls.length,0);
      input.props.onCompositionEnd({currentTarget:{value:'腾讯'}});
      assert.equal(calls.length,1);const url=new URL(calls[0],'http://localhost');
      assert.equal(url.searchParams.get('q'),'腾讯');assert(!url.searchParams.has('p')&&!url.searchParams.has('stock'));
    } finally {global.window=previousWindow;}
  });
  test('single market month calendar restores URL before effects',()=>{
    const html=render('components/views/GlobalPreviewView.tsx',{initialNow:Date.UTC(2026,9,2)},'section=calendar&calYear=2026&calDay=2026-12-24');
    assert(html.includes('2026')&&html.includes('休市日历'));
    assert.equal((html.match(/class="mc-month card"/g)||[]).length,1);
    assert(html.includes('2026-12-24')&&html.includes('13:00')&&!html.includes('12:08'));
    const hk=render('components/MarketCalendarView.tsx',{},'market=HK&calYear=2026&calDay=2026-12-24');
    assert(hk.includes('12:08')&&!hk.includes('13:00'));
    assert(hk.includes('Asia/Hong_Kong')&&!hk.includes('America/New_York'));
    assert(html.includes('美股')&&html.includes('港股')&&html.includes('A 股（沪深）'));
    assert(html.includes('mc-market-mark')&&!html.includes('汇率换算器'));
    assert(!html.includes('aria-label="2026-01-01；'));
    const october=render('components/MarketCalendarView.tsx',{initialNow:Date.UTC(2026,9,2)},'market=CN&calYear=2026&calMonth=10');
    assert(october.includes('aria-label="2026 年 10 月"'));
    assert(!october.includes('日历月份'),'month dropdown duplicates arrow navigation');
    const old=render('components/MarketCalendarView.tsx',{initialNow:Date.UTC(2026,9,2)},'calYear=2000&calMonth=1');
    assert(old.includes('aria-label="2000 年 1 月"'));
    assert(/aria-label="上个月" disabled/.test(old),'API lower limit is the only earlier-month boundary');
    const january=render('components/MarketCalendarView.tsx',{initialNow:Date.UTC(2026,9,2)},'calYear=2026&calMonth=1');
    assert(!/aria-label="上个月" disabled/.test(january),'January of this year must allow viewing previous December');
    assert(october.includes('2026-10-01')&&!october.includes('aria-label="2026-12-24；'));
    const closed=october.match(/<button[^>]*aria-label="2026-10-01；[^]*?<\/button>/)[0];
    const open=october.match(/<button[^>]*aria-label="2026-10-08；[^]*?<\/button>/)[0];
    assert(closed.includes('mc-closure-watermark')&&!open.includes('mc-closure-watermark'));
    const half=html.match(/<button[^>]*aria-label="2026-12-24；[^]*?<\/button>/)[0];
    assert(!half.includes('mc-closure-watermark'),'half-day alone must not imply full closure');
    const unknown=render('components/MarketCalendarView.tsx',{},'calYear=2027');
    assert(unknown.includes('2027 年安排未确认'));
    assert(!unknown.includes('class="mc-market-mark"'));
    assert(!unknown.includes('计划交易'));
  });

  test('calendar status filters keep date positions and never mix another market',()=>{
    const half=render('components/MarketCalendarView.tsx',{},'market=US&calYear=2026&calMonth=12&calStatus=half_day&calDay=2026-12-24');
    assert(half.includes('半日市 1 天')&&half.includes('13:00')&&!half.includes('12:08'));
    assert(/aria-label="2026-12-25；[^>]*disabled/.test(half));
    assert.equal((half.match(/class="mc-market-mark is-half"/g)||[]).length,1);
    const cn=render('components/MarketCalendarView.tsx',{},'market=CN&calYear=2026&calMonth=12&calStatus=half_day');
    assert(cn.includes('半日市 0 天')&&!cn.includes('mc-half-dot'));
    const unverified=render('components/MarketCalendarView.tsx',{},'market=HK&calYear=2027&calMonth=2&calStatus=unknown');
    assert(unverified.includes('未确认 28 天')&&!unverified.includes('mc-closure-watermark'));
    const unknown=render('components/MarketCalendarView.tsx',{},'market=US&calYear=2026&calMonth=12&calStatus=unknown');
    assert(unknown.includes('未确认 0 天'));
    let address=new URL('https://example.test/global?section=calendar&market=US&calYear=2026&calMonth=12');
    global.window={location:{get href(){return address.href;}},history:{replaceState(_a,_b,url){address=new URL(url,address);}}};
    try {
      const view=frameHarness('components/MarketCalendarView.tsx',{'@/lib/workspacePanel':{useWorkspaceSearchParams:()=>query,useWorkspaceLocationGuard:()=>()=>true}});
      query=address.searchParams;
      let tree=elements(view.render({initialNow:Date.UTC(2026,9,2)}));
      tree.find(node=>node.type==='button'&&node.key==='HK').props.onClick();
      assert.equal(address.searchParams.get('market'),'HK');
      query=address.searchParams;tree=elements(view.render({initialNow:Date.UTC(2026,9,2)}));
      tree.find(node=>node.type==='button'&&node.key==='half_day').props.onClick();
      assert.equal(address.searchParams.get('status'),'half_day');
      assert.equal(address.searchParams.get('market'),'HK');
      query=address.searchParams;tree=elements(view.render({initialNow:Date.UTC(2026,9,2)}));
      tree.find(node=>node.type==='button'&&node.key==='half_day').props.onClick();
      assert.equal(address.searchParams.has('status'),false);
    } finally {delete global.window;}
  });

  test('full closure capsule includes holidays and weekends, excludes half days, and restores its URL',()=>{
    const cell=(html,date)=>html.match(new RegExp('<button[^>]*aria-label="'+date+'；[^]*?</button>'))[0];
    const cn=render('components/MarketCalendarView.tsx',{},'market=CN&month=2026-10&status=closed');
    assert(cn.includes('全天休市 14 天'));
    assert(!cell(cn,'2026-10-01').includes('disabled'));
    assert(!cell(cn,'2026-10-10').includes('disabled'));
    assert(cell(cn,'2026-10-10').includes('data-tone="neutral"'),'full closure filter must preserve neutral weekends');
    assert(cell(cn,'2026-10-08').includes('disabled'));
    const all=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-10&status=closed');
    assert(all.includes('全天休市 15 天'),'count dates rather than individual market closures');
    const mixed=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-02&status=closed');
    const feb16=cell(mixed,'2026-02-16');
    assert(feb16.includes('data-market="US"')&&feb16.includes('data-market="CN"'));
    assert(!feb16.includes('data-market="HK"')&&!feb16.includes('mc-half-dot'));
    const hk=render('components/MarketCalendarView.tsx',{},'market=HK&month=2026-02&status=closed');
    assert(cell(hk,'2026-02-16').includes('disabled'),'half days are not full closure days');
    const future=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2027-10&status=closed');
    assert(future.includes('全天休市 0 天')&&!future.includes('class="mc-market-mark"'));
    let address=new URL('https://example.test/global?section=calendar&market=HK&month=2026-10&day=1');
    global.window={location:{get href(){return address.href;}},history:{replaceState(_a,_b,url){address=new URL(url,address);}}};
    try {
      const view=frameHarness('components/MarketCalendarView.tsx',{'@/lib/workspacePanel':{useWorkspaceSearchParams:()=>query,useWorkspaceLocationGuard:()=>()=>true}});
      query=address.searchParams;
      let tree=elements(view.render());
      tree.find(node=>node.type==='button'&&node.key==='closed').props.onClick();
      assert.equal(address.searchParams.get('status'),'closed');
      assert.equal(address.searchParams.get('market'),'HK');
      assert.equal(address.searchParams.get('month'),'2026-10');
      assert(!address.searchParams.has('day'));
      query=address.searchParams;tree=elements(view.render());
      assert.equal(tree.find(node=>node.type==='button'&&node.key==='closed').props['aria-pressed'],true);
      tree.find(node=>node.type==='button'&&node.key==='closed').props.onClick();
      assert(!address.searchParams.has('status'));
    } finally {delete global.window;}
  });

  test('market images hide the globe until genuine failure and retry new sources without an old error frame',()=>{
    const {primeMarketIconCache}=require(path.join(root,'lib/useAssetIcons.ts'));
    primeMarketIconCache({ZZ:'/uploads/asset/market/custom-zz.svg'});
    const html=render('components/MarketIcon.tsx',{market:'ZZ',size:18});
    assert(html.includes('src="/uploads/asset/market/custom-zz.svg"'),'SSR must retain the custom market URL');
    assert(html.includes('visibility:hidden'),'pending market images must not display a globe underlay');
    const fallback=React.createElement('span',{},'fallback');
    const view=frameHarness('components/SafeAssetImage.tsx');
    const props={src:'/uploads/market-a.svg',fallback,style:{width:18,height:18},showFallbackWhileLoading:false};
    const first=elements(view.render(props));
    assert(first.some(node=>node.props.style?.visibility==='hidden'));
    const firstImage=first.find(node=>node.type==='img');
    assert.deepEqual(firstImage.props.style,{width:18,height:18});
    firstImage.props.onError();
    assert(elements(view.render(props)).includes(fallback),'a genuine failure must display the fallback');
    const replacement={...props,src:'/uploads/market-b.svg'};
    assert(elements(view.render(replacement)).some(node=>node.type==='img'),'a new source retries before any effect');
    firstImage.props.onError();
    assert(elements(view.render(replacement)).some(node=>node.type==='img'),'late previous-source failures cannot hide the new image');
    assert(elements(view.render(props)).some(node=>node.type==='img'),'returning to a previous source can retry it');
    assert(elements(view.render({...props,src:null})).includes(fallback));
    const other=frameHarness('components/SafeAssetImage.tsx');
    assert(!elements(other.render({src:props.src,fallback})).some(node=>node.props.style?.visibility==='hidden'),'other icon callers retain their loading fallback');
  });

  test('compact calendar links preserve legacy state and ALL is an explicit three-market overview',()=>{
    const old=render('components/MarketCalendarView.tsx',{},'market=HK&calYear=2026&calMonth=12&calStatus=half_day&calDay=2026-12-24');
    const compact=render('components/MarketCalendarView.tsx',{},'market=HK&month=2026-12&status=half_day&day=24');
    assert.equal(compact,old,'old bookmarks and new compact URLs must render the same first frame');
    const all=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-12&status=half_day&day=24');
    assert(all.includes('全部市场')&&all.includes('半日市 2 天'));
    assert(all.includes('13:00')&&all.includes('12:08'));
    assert.equal((all.match(/class="mc-month card"/g)||[]).length,1);
    const selected=all.match(/<section class="mc-selected"[^]*?<\/section>/)[0];
    assert(selected.includes('美股')&&selected.includes('港股')&&selected.includes('A 股（沪深）'));
    const cn=render('components/MarketCalendarView.tsx',{},'market=CN&month=2026-12&day=24');
    assert(!cn.includes('13:00')&&!cn.includes('12:08'));
    const mixed=render('components/MarketCalendarView.tsx',{},'market=US&month=2026-10&calYear=2027&calMonth=12&day=1');
    assert(mixed.includes('2026 年 10 月')&&!mixed.includes('2027 年安排未确认'));
    let address=new URL('https://example.test/global?section=calendar&market=US&calYear=2026&calMonth=12&calDay=2026-12-24');
    global.window={location:{get href(){return address.href;}},history:{replaceState(_a,_b,url){address=new URL(url,address);}}};
    try {
      const view=frameHarness('components/MarketCalendarView.tsx',{'@/lib/workspacePanel':{useWorkspaceSearchParams:()=>query,useWorkspaceLocationGuard:()=>()=>true}});
      query=address.searchParams;
      let tree=elements(view.render());
      tree.find(node=>node.type==='button'&&node.props.children==='全部').props.onClick();
      assert.equal(address.searchParams.get('market'),'ALL');
      assert.equal(address.searchParams.get('month'),'2026-12');
      assert(!address.searchParams.has('calYear')&&!address.searchParams.has('calDay'));
      query=address.searchParams;tree=elements(view.render());
      tree.find(node=>node.type==='button'&&node.props['aria-label']?.startsWith('2026-12-24；')).props.onClick();
      assert.equal(address.searchParams.get('day'),'24');
      assert.equal(address.searchParams.has('status'),false);
    } finally {delete global.window;}
  });

  test('calendar colors reflect visible market schedules while normal weekends stay neutral',()=>{
    const {calendarDayAppearance:appearance}=require(path.join(root,'components/MarketCalendarView.tsx'));
    assert.deepEqual(appearance(['trading','weekend','weekend']),{tone:'neutral'});
    assert.deepEqual(appearance(['holiday','weekend']),{tone:'holiday'});
    assert.deepEqual(appearance(['holiday','weekend'],true),{tone:'neutral'},'verified weekends inside a holiday range must not gain a holiday tint');
    assert.deepEqual(appearance(['half_day','trading']),{tone:'half_day'});
    assert.deepEqual(appearance(['unknown','weekend']),{tone:'unknown'});
    const mixed=appearance(['holiday','half_day','holiday']);
    assert.equal(mixed.tone,'mixed');
    assert(mixed.fill.includes('var(--mc-fill-holiday) 66.67%')&&mixed.fill.includes('var(--mc-fill-half_day) 66.67%'));
    assert.equal(appearance(['half_day','holiday','holiday']).fill,mixed.fill,'market order cannot change the status palette');
    const three=appearance(['unknown','holiday','half_day']);
    assert(three.fill.includes('var(--mc-fill-unknown) 100%'));
    const cell=(html,date)=>html.match(new RegExp('<button[^>]*aria-label="'+date+'；[^]*?</button>'))[0];
    const all=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-02');
    assert(cell(all,'2026-02-16').includes('data-tone="mixed"'));
    assert(cell(all,'2026-02-14').includes('data-tone="neutral"'));
    assert(cell(all,'2026-02-15').includes('data-tone="neutral"'),'a weekend inside an official holiday range stays neutral');
    for(const [market,tone] of [['US','holiday'],['HK','half_day'],['CN','holiday']]) {
      const html=render('components/MarketCalendarView.tsx',{},'market='+market+'&month=2026-02');
      assert(cell(html,'2026-02-16').includes('data-tone="'+tone+'"'));
    }
    const half=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-02&status=half_day');
    assert(cell(half,'2026-02-16').includes('data-tone="half_day"'),'filtered colors include only matching markets');
    assert(cell(half,'2026-02-15').includes('data-tone="neutral"'));
    const future=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2027-02');
    assert(cell(future,'2027-02-06').includes('data-tone="unknown"'),'an unverified weekend must remain unknown');
  });

  test('confirmed weekends show only the date while closure details and unknown weekends remain available',()=>{
    const cell=(html,date)=>html.match(new RegExp('<button[^>]*aria-label="'+date+'；[^]*?</button>'))[0];
    for(const market of ['ALL','US','HK','CN']) for(const status of ['', '&status=closed']) {
      const html=render('components/MarketCalendarView.tsx',{},'market='+market+'&month=2026-10'+status+'&day=10');
      for(const date of ['2026-10-03','2026-10-10']) {
        const weekend=cell(html,date);
        assert(weekend.includes('is-quiet-weekend'));
        assert(!weekend.includes('mc-market-marks')&&!weekend.includes('mc-closure-watermark'));
        assert(weekend.includes('mc-number')&&!weekend.includes('disabled=""'));
      }
      assert(html.includes('class="mc-selected"')&&html.includes('周末休市'),'selected weekends still expose their market schedule');
    }
    const holidays=render('components/MarketCalendarView.tsx',{},'market=CN&month=2026-10');
    assert(cell(holidays,'2026-10-01').includes('mc-market-marks')&&cell(holidays,'2026-10-01').includes('mc-closure-watermark'));
    const future=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2027-10');
    const unknown=cell(future,'2027-10-02');
    assert(!unknown.includes('is-quiet-weekend')&&unknown.includes('mc-unknown-key')&&unknown.includes('data-tone="unknown"'));
    const filtered=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-10&status=half_day');
    assert(cell(filtered,'2026-10-10').includes('disabled=""'),'status filtering still excludes irrelevant weekends');
  });

  test('closure reasons stay paired with each market and omit ordinary weekends',()=>{
    const cell=(html,date)=>html.match(new RegExp('<button[^>]*aria-label="'+date+'；[^]*?</button>'))[0];
    const reasons=html=>[...html.matchAll(/class="mc-closure-reason" data-market="([A-Z]+)"[^>]*><b>([^]*?)<\/b><span>([^]*?)<\/span>/g)].map(match=>({market:match[1],label:match[2],name:match[3]}));
    const october=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-10');
    assert.deepEqual(reasons(cell(october,'2026-10-01')),[{market:'HK',label:'港股：',name:'国庆'},{market:'CN',label:'A 股：',name:'国庆'}]);
    assert.deepEqual(reasons(cell(october,'2026-10-10')),[]);
    assert.deepEqual(reasons(cell(october,'2026-10-03')),[],'weekend holiday dates do not add weekday closure reasons');
    assert(cell(october,'2026-10-03').includes('data-tone="neutral"'));
    assert.deepEqual(reasons(cell(october,'2026-10-08')),[]);
    const mixed=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2026-02');
    assert.deepEqual(reasons(cell(mixed,'2026-02-16')).map(row=>row.market),['US','HK','CN']);
    const hk=render('components/MarketCalendarView.tsx',{},'market=HK&month=2026-02&status=half_day&day=16');
    assert.deepEqual(reasons(cell(hk,'2026-02-16')),[{market:'HK',label:'港股：',name:'春节前夕'}]);
    assert(hk.includes('农历新年前夕')&&hk.includes('12:08'),'full official reason and half-day hours remain in details');
    const unknown=render('components/MarketCalendarView.tsx',{},'market=ALL&month=2027-10');
    assert.deepEqual(reasons(unknown),[],'unconfirmed dates must not invent holiday reasons');
  });

  test('late client mounts use current preferences while server hydration uses its exact snapshot',()=>{
    const output=ts.transpileModule(fs.readFileSync(path.join(root,'lib/usePersistedState.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    function firstValue(client,local,cookie,server) {
      const exports={};
      require('node:vm').runInNewContext(output,{exports,window:{},localStorage:{getItem:()=>{if(local instanceof Error)throw local;return local;}},
        require:id=>id==='react'?{useRef:value=>({current:value}),useState:fn=>[fn(),()=>{}],useCallback:fn=>fn,useEffect(){},useSyncExternalStore:(_subscribe,get,getServer)=>client?get():getServer()}
          :id==='./prefsContext'?{useServerPrefs:()=>server,writePrefCookie(){}}
          :id==='./prefsCookie'?{readPrefsCookie:()=>cookie}:{showToast(){}}
      });
      return exports.usePersistedState('fire:display-currency','USD')[0];
    }
    assert.equal(firstValue(false,'"HKD"',{'fire:display-currency':'HKD'},{'fire:display-currency':'USD'}),'USD','hydration must match the HTML even if storage changed');
    assert.equal(firstValue(true,'"HKD"',{'fire:display-currency':'HKD'},{'fire:display-currency':'USD'}),'HKD','new cached page must not flash the old layout choice');
    assert.equal(firstValue(true,'"HKD"',{'fire:display-currency':'CNY'},{'fire:display-currency':'USD'}),'HKD','current local preference retains priority over a stale cookie');
    assert.equal(firstValue(true,new Error('blocked'),{'fire:display-currency':'CNY'},{'fire:display-currency':'USD'}),'CNY','cookie-only browsers restore before effects');
    assert.equal(firstValue(true,null,{}, {'fire:display-currency':'HKD'}),'USD','a cleared preference must not resurrect the stale layout snapshot');
    assert.equal(firstValue(true,'HKD',{},{}),'HKD','legacy unquoted storage remains compatible');
  });
  test('cached global and converter views restore changed URLs on the very next render',()=>{
    const overrides={
      '@/lib/workspacePanel':{useWorkspaceSearchParams:()=>query,useWorkspaceLocationGuard:()=>()=>true},
      '@/lib/currencyPrefs':{useDisplayCurrency:()=>({currency:'USD'})},
      '@/lib/usePersistedState':{usePersistedState:(_key,value)=>[value,()=>{}]}
    };
    const global=frameHarness('components/views/GlobalPreviewView.tsx',overrides);
    query=new URLSearchParams('section=assets');global.render();
    query=new URLSearchParams('section=convert&from=USD&amount=250');
    let tree=elements(global.render());
    assert.equal(tree.find(node=>node.props['aria-current']==='page').props['aria-label'],'汇率换算');
    query=new URLSearchParams('section=assets');tree=elements(global.render());
    assert.equal(tree.find(node=>node.props['aria-current']==='page').props['aria-label'],'市值排行');
    const converter=frameHarness('components/FxConverter.tsx',overrides);
    query=new URLSearchParams('section=convert&from=USD&amount=100');
    assert(elements(converter.render()).some(node=>node.type==='input'&&node.props.value==='100'));
    query=new URLSearchParams('section=convert&from=USD&amount=250');
    assert(elements(converter.render()).some(node=>node.type==='input'&&node.props.value==='250'),'the previous amount must not survive one paint');
    query=new URLSearchParams('section=convert&from=USD&amount=100');
    assert(elements(converter.render()).some(node=>node.type==='input'&&node.props.value==='100'));
  });
  test('request rows disappear in the first render of a different query and preserve dynamic version markup',()=>{
    const view=frameHarness('components/ApiRequests.tsx',{
      '@/lib/useWorkspaceForeground':{useWorkspaceForeground:()=>true},
      '@/lib/workspacePanel':{useWorkspaceSearchParams:()=>query,useWorkspaceLocationGuard:()=>()=>true},
      '@/lib/usePersistedState':{usePersistedState:(_key,value)=>[value,()=>{}]}
    });
    const year=new Date().getUTCFullYear();
    query=new URLSearchParams(`rPeriod=today&rQ=/api/v2&rPage=1&rYear=${year}`);view.render();
    const snapshot={revision:1,today:`${year}-01-01`,summary:{total:1,errors:0,serverErrors:0,averageMs:1,sources:{web:1,ios:0,app:0,other:0}},chart:[],chartUnit:'hour',endpoints:[],logs:[{id:1,at:Date.UTC(year,0,1),path:'/api/v2/previous-result',method:'GET',source:'web',status:200,duration:1}],pagination:{page:1,pageSize:20,total:1,anchor:0},heatmap:{},detailFrom:0};
    const resultSlot=view.states.findIndex(value=>value===null);assert(resultSlot>=0);
    view.states[resultSlot]={key:query.toString(),snapshot};
    assert(elements(view.render()).some(node=>node.props.path==='/api/v2/previous-result'));
    query=new URLSearchParams(`rPeriod=today&rQ=/api/v3&rPage=1&rYear=${year}`);
    const next=elements(view.render());
    assert(next.some(node=>node.type==='input'&&node.props.value==='/api/v3'));
    assert(!next.some(node=>node.props.path==='/api/v2/previous-result'),'old rows cannot wait for an effect to clear them');
    const html=render('components/ApiPathText.tsx',{path:'/api/v3/example'});
    assert(html.includes('v3')&&html.includes('api-version'),'version coloring remains extensible');
  });
  test('request styles belong to the root and FIRE first frame has readable loading feedback',()=>{
    const layout=fs.readFileSync(path.join(root,'app/layout.tsx'),'utf8');
    assert(layout.includes('import "@/styles/api-requests.css"')&&layout.includes('import "@/styles/api-version.css"'));
    const html=render('components/views/FireView.tsx',{records:[],quotes:{},livePrice:()=>0});
    assert(html.includes('退休规划')&&html.includes('role="status"')&&!html.includes('aria-hidden="true"'));
  });
  test('global conversion URL renders converter rather than default ranking before hydration',()=>{
    const html=render('components/views/GlobalPreviewView.tsx',{},'section=convert&from=USD&amount=250');
    assert(!html.includes('全球资产市值排行'));
    assert(html.includes('value="250"'));
    assert(html.includes('USD'));
    const foreign=render('components/FxConverter.tsx',{},'from=HKD&amount=250');
    assert(!foreign.includes("fx-converter-row is-active"));
    const fallback=render('components/views/GlobalPreviewView.tsx',{},'section=invalid');
    assert(fallback.includes('全球资产市值排行'));
    assert(fallback.includes('正在读取全球市值排行'));
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
    assert(loading.includes('aria-label="加载页面"'));
    assert(loading.includes('aria-hidden="true"'));
    assert(!loading.includes('正在打开')&&!loading.includes('<p>'));
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
  test('reconciliation market badges remain visible while ordinary badges respect global hiding',()=>{
    const badges=require(path.join(root,'lib/marketBadge.ts'));
    try {
      badges.applyMarketBadges(undefined,false);
      assert.equal(render('components/MarketCodeBadge.tsx',{market:'CN',code:'600019'}),'');
      const html=render('components/MarketCodeBadge.tsx',{market:'CN',code:'600019',alwaysVisible:true});
      assert(html.includes('SH 市场'));assert(html.includes('>SH<'));
    } finally { badges.applyMarketBadges(undefined,true); }
  });
  console.log(`${passed} first-frame suites passed (no browser effects or real data writes)`);
  if(failures) process.exitCode=1;
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
