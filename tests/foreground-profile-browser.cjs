// Synthetic browser regression. No real account, database, provider, or business writes.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const esbuild = require('esbuild'), ts = require('typescript'), postcss = require('postcss'), tailwind = require('tailwindcss');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const fixture = `
import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import BackupRecoveryView from '@/components/views/BackupRecoveryView';
import PersonalHome from '@/components/PersonalHome';
import SafeAssetImage from '@/components/SafeAssetImage';
import {useAssetIcons,ensureStockIcons,primeStockIconCache} from '@/lib/useAssetIcons';
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const user={id:id(1),username:'Synthetic',nickname:'示例用户',uid:17,role:'admin',avatar:'/fixture-avatar.svg'};
const identity={user,csrf:'synthetic-csrf',instance_id:'instance-one'};
const mapping={source_owner:id(9),account_kinds:{account:'real'},broker_labels:{},market_accounts:{},order_accounts:{}};
const domains=[['identity','账号与安全',1],['accounts','券商账户',1],['positions','持仓与自选',3],['orders','历史交易',4],['cash','资金流水',5],['pnl','历史盈亏',2],['assets','素材与原件',6]].map(([key,label,source])=>({key,label,source,converted:source,state:'normalized'}));
const preparation={id:id(2),request_id:id(3),kind:'database.migration.prepare',status:'succeeded',source_revision:'source-one',has_imports:true,result:{phase:'awaiting_mapping',business_written:false,cutover_ready:false,source:{restore_verified:true,tables:1,rows:1},target:{restore_verified:true,tables:1,rows:1}}};
const conversion={id:id(4),request_id:id(5),kind:'database.migration.convert',status:'succeeded',input:mapping,result:{preparation_id:id(2),phase:'converted',domains,issue_counts:{},plan_sha256:'a'.repeat(64),portfolio_ready:true}};
const portfolio={id:id(6),request_id:id(7),kind:'database.migration.portfolio',status:'succeeded',conversion_id:id(4),result:{business_written:true}};
const history={id:id(8),request_id:id(10),kind:'database.migration.complete',status:'running',result:{conversion_id:id(4),business_written:true,progress:{phase:'backup',processed:3,total:12}}};
const conversionContext={preparation_id:id(2),users:[{id:id(9),username:'Source'}],accounts:[{id:'account',owner_id:id(9),name:'示例账户',kind:'real'}],broker_labels:[],orders:[],items:[conversion],imports:[portfolio],history_imports:[history]};
const config={host:'db.invalid',port:5432,database:'synthetic',username:'fixture',schema_name:'public'};
const connections={source:{revision:'source-one',config,password_configured:true},target:{config,password_configured:true,instance_id:'instance-one',environment:'test',managed_by:'environment'},checks:{source:null,target:null}};
const profile={revision:1,bio:'',gender:'unspecified',background:{sha256:'b'.repeat(64)}};
const activity={total:12,activeDays:2,longest:2,current:2,since:Date.UTC(2026,10,9),today:'2026-11-11',days:{'2026-11-10':6,'2026-11-11':6}};
const state=window.fixture={calls:[],holdContext:false,contextReads:0,authStatus:0,instance:'instance-one',iconVersion:1,holdIcons:new URLSearchParams(location.search).get('holdIcons')==='1',release:null};
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init={})=>{
 const url=new URL(String(input),location.href),method=init.method||'GET';state.calls.push({path:url.pathname+url.search,method});
 if(method!=='GET')throw Error('Fixture forbids writes: '+method+' '+url.pathname);
 if(url.pathname==='/api/fire/session')return Response.json(state.authStatus?{error:'会话已失效'}:{...identity,instance_id:state.instance},{status:state.authStatus||200});
 if(url.pathname.endsWith('/conversion')){
  state.contextReads++;
  if(state.contextFailure)return Response.json({error:'synthetic context unavailable'},{status:503});
  if(state.holdContext)return new Promise((resolve,reject)=>{state.release=()=>resolve(Response.json(conversionContext));init.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});});
  return Response.json(conversionContext);
 }
 if(url.pathname==='/api/fire/database-migration/connections')return Response.json(connections);
 if(url.pathname==='/api/fire/backups')return Response.json({items:[],configured:true,key_fingerprint:'fixture'});
 if(url.pathname==='/api/fire/database-migration/preparations')return Response.json({items:[preparation]});
 if(url.pathname.startsWith('/api/fire/tasks/')){const key=url.pathname.split('/').at(-1);if(state.taskAuthStatus&&key!==preparation.id&&key!==preparation.request_id)return Response.json({error:'synthetic revoked task access'},{status:403});const item=[preparation,conversion,portfolio,history].find(t=>t.id===key||t.request_id===key);return Response.json(item||{error:'unknown task'},{status:item?200:404});}
 if(url.pathname==='/api/auth/personal-home')return Response.json({user,profile});
 if(url.pathname==='/api/auth/personal-activity')return Response.json(activity);
 if(url.pathname==='/api/assets'){
  if(state.iconFailure)return Response.json({error:'synthetic unavailable'},{status:503});
  if(state.iconsMissing)return Response.json({assets:[]});
  const keys=(url.searchParams.get('keys')||'').split(','),assets=[];
  if(keys.includes('US:HOOD'))assets.push({type:'stock',market:'US',code:'HOOD',url:'/fixture-icon.svg?v='+state.iconVersion});
  if(keys.includes('HK:700'))assets.push({type:'stock',market:'HK',code:'00700',url:'/fixture-icon.svg?v='+state.iconVersion});
  if(state.holdIcons)return new Promise(resolve=>{state.releaseIcons=()=>resolve(Response.json({assets}));});
  return Response.json({assets});
 }
 throw Error('Unexpected fixture read: '+url.pathname);
};
state.visibility=hidden=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});document.dispatchEvent(new Event('visibilitychange'));};
function StockPreview(){primeStockIconCache({});const{stockIcons}=useAssetIcons(['stock']);(state.iconRenders??=[]).push(['US:ROBN','HK:700'].map(key=>stockIcons[key]||null));useEffect(()=>{void ensureStockIcons([{market:'US',code:'ROBN'},{market:'HK',code:'700'}]);},[]);return <div>{['US:ROBN','HK:700'].map(key=><div data-stock={key} key={key}><SafeAssetImage src={stockIcons[key]} fallback={<span>占位</span>}/></div>)}</div>;}
const mode=new URLSearchParams(location.search).get('view');
if(mode==='icons-seeded')primeStockIconCache({'US:HOOD':'/fixture-icon.svg?v=1','HK:00700':'/fixture-icon.svg?v=1'});
createRoot(document.getElementById('root')).render(mode==='profile'?<PersonalHome user={user} initial={{profile,activity}}/>:(mode==='icons'||mode==='icons-seeded')?<StockPreview/>:<BackupRecoveryView ownerId={user.id} initial={{identity,connections,backups:{items:[],configured:true,key_fingerprint:'fixture'},preparations:[preparation],preparation}} initialNow={Date.now()}/>);
`;
const workspaceMock = `import {useCallback,useMemo} from 'react';export const useWorkspaceActive=()=>true;export const useWorkspaceLocationGuard=()=>useCallback(()=>true,[]);export const useWorkspaceSearchParams=()=>useMemo(()=>new URLSearchParams(window.location.search),[]);`;
(async()=>{
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-foreground-profile-'));
 const mod={exports:{}};new Function('exports','require',ts.transpileModule(fs.readFileSync(path.join(root,'tailwind.config.ts'),'utf8'),{compilerOptions:{module:1}}).outputText)(mod.exports,require);
 const css=await postcss([tailwind({...mod.exports.default,content:[path.join(root,'components/**/*.{tsx,ts}')]})]).process(fs.readFileSync(path.join(root,'app/globals.css'),'utf8'),{from:path.join(root,'app/globals.css')});
 const bundledCss=await esbuild.build({stdin:{contents:css.css+fs.readFileSync(path.join(root,'styles/palettes.css'),'utf8')+fs.readFileSync(path.join(root,'styles/capsules.css'),'utf8'),resolveDir:path.join(root,'app'),loader:'css'},bundle:true,write:false,external:['*.woff2','*.woff','*.png','*.jpg','*.svg','*.webp']});
 const aliases={'@':root};if(process.env.UI_BASELINE){for(const name of ['DatabaseMigrationConversion','PersonalHome'])aliases['@/components/'+name]=path.join(process.env.UI_BASELINE,name+'.tsx');}
 const built=await esbuild.build({nodePaths:[path.join(root,'node_modules')],stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',format:'iife',alias:aliases,define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'isolated-workspace',setup(build){build.onResolve({filter:/^(?:@\/lib\/workspacePanel|.*\/workspacePanel)$/},()=>({path:'workspace',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:workspaceMock,loader:'jsx',resolveDir:root}));}}]});
 const palette={exports:{}};new Function('exports',ts.transpileModule(fs.readFileSync(path.join(root,'lib/palettes.ts'),'utf8'),{compilerOptions:{module:1}}).outputText)(palette.exports);
 const vars=Object.entries(palette.exports.paletteVariables('neutral')).map(([k,v])=>k+':'+v).join(';');
 const image='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 400"><rect width="940" height="400" fill="#b6d2de"/><path d="M0 350L350 0 940 370V400H0Z" fill="#496677"/><path d="M350 0L200 150 380 110 510 160Z" fill="#f0f7fa"/><text x="470" y="215" fill="white" text-anchor="middle" font-size="40">BANNER</text></svg>';
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(built.outputFiles[0].contents);}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(bundledCss.outputFiles[0].contents);}else if(req.url.includes('.svg')||req.url.includes('kind=background')){res.setHeader('Content-Type','image/svg+xml');res.end(image);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="zh-CN" data-palette="neutral" style="'+vars+'"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body style="background:rgb(var(--site-bg));color:rgb(var(--site-ink))"><main style="max-width:1100px;margin:auto"><div id="root"></div></main><script src="/app.js"></script></body></html>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||(process.platform==='darwin'&&fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
  browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:'+server.address().port;
  const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const migrationUrl=base+'/?'+new URLSearchParams({tab:'migration',migrationStep:'conversion',migrationRequest:id(3),conversionRequest:id(5),portfolioRequest:id(7),historyRequest:id(10)});
  await page.goto(migrationUrl);await page.waitForSelector('.migration-domain');assert.equal(await page.locator('.migration-domain').count(),7);
  await page.evaluate(()=>{window.fixture.holdContext=true;window.fixture.visibility(true);});await page.waitForTimeout(100);
  const hiddenReads=await page.evaluate(()=>window.fixture.calls.length);await page.waitForTimeout(2300);assert.equal(await page.evaluate(()=>window.fixture.calls.length),hiddenReads,'hidden document performs no task reads');
  await page.evaluate(()=>window.fixture.visibility(false));await page.waitForFunction(()=>window.fixture.contextReads>=2);
  assert.equal(await page.locator('.migration-domain').count(),7,'returning to a slow connection retains the verified conversion rows');
  assert(await page.getByText('已导入 2 / 7 类',{exact:true}).isVisible());
  await page.evaluate(()=>{window.fixture.release();window.fixture.holdContext=false;});await page.waitForTimeout(100);
  await page.screenshot({path:path.join(output,'migration-return.png'),fullPage:true});await page.evaluate(()=>document.documentElement.classList.add('dark'));await page.screenshot({path:path.join(output,'migration-return-dark.png'),fullPage:true});
  const beforeInstanceReads=await page.evaluate(()=>window.fixture.contextReads);
  await page.evaluate(()=>{window.fixture.visibility(true);window.fixture.instance='instance-two';window.fixture.holdContext=true;});await page.waitForTimeout(80);await page.evaluate(()=>window.fixture.visibility(false));await page.waitForFunction(count=>window.fixture.contextReads>count,beforeInstanceReads);
  assert.equal(await page.locator('.migration-domain').count(),0,'a verified instance change removes the old observation');await page.evaluate(()=>{window.fixture.release();window.fixture.holdContext=false;});await page.waitForSelector('.migration-domain');
  await page.evaluate(()=>{window.fixture.visibility(true);window.fixture.authStatus=403;});await page.waitForTimeout(80);await page.evaluate(()=>window.fixture.visibility(false));await page.getByRole('alert').waitFor();assert.equal(await page.locator('.migration-domain').count(),0,'revoked authorization removes cached rows');
  assert((await page.evaluate(()=>window.fixture.calls)).every(c=>c.method==='GET'),'foreground recovery never resubmits migration work');
  await page.goto(migrationUrl);await page.waitForSelector('.migration-domain');
  await page.evaluate(()=>{window.fixture.holdContext=true;window.fixture.visibility(true);});await page.waitForTimeout(80);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});window.dispatchEvent(new Event('pageshow'));});await page.waitForFunction(()=>window.fixture.contextReads>=2);
  assert.equal(await page.locator('.migration-domain').count(),7,'returning from page history retains conversion rows');await page.evaluate(()=>{window.fixture.release();window.fixture.holdContext=false;});
  await page.goto(migrationUrl);await page.waitForSelector('.migration-domain');await page.evaluate(()=>{window.fixture.contextFailure=true;window.fixture.visibility(true);});await page.waitForTimeout(80);await page.evaluate(()=>window.fixture.visibility(false));await page.getByRole('alert').waitFor();assert.equal(await page.locator('.migration-domain').count(),7,'temporary read failures preserve the existing clear view');await page.evaluate(()=>{window.fixture.contextFailure=false;});await page.getByRole('button',{name:'重新核对',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'});
  await page.goto(migrationUrl);await page.waitForSelector('.migration-domain');await page.evaluate(()=>{window.fixture.holdContext=true;window.fixture.visibility(true);});await page.waitForTimeout(80);await page.evaluate(()=>{window.fixture.visibility(false);window.fixture.taskAuthStatus=403;});await page.getByRole('alert').waitFor();assert.equal(await page.locator('.migration-domain').count(),0);await page.evaluate(()=>window.fixture.release?.());await page.waitForTimeout(100);assert.equal(await page.locator('.migration-domain').count(),0,'a late successful response cannot restore revoked observations');assert(await page.getByRole('link',{name:'重新登录',exact:true}).isVisible());
  await page.goto(base+'/?view=icons');await page.waitForSelector('[data-stock="US:ROBN"] img');await page.waitForSelector('[data-stock="HK:700"] img');
  let calls=await page.evaluate(()=>window.fixture.calls);assert(calls.every(c=>c.method==='GET'));assert(calls.some(c=>decodeURIComponent(c.path).includes('US:HOOD')),'ETF requests include underlying artwork');
  await page.evaluate(()=>{window.fixture.iconVersion=2;window.dispatchEvent(new Event('fire:assets-updated'));});await page.waitForFunction(()=>document.querySelector('[data-stock="US:ROBN"] img')?.getAttribute('src').includes('v=2'));
  await page.evaluate(()=>{window.fixture.iconFailure=true;window.dispatchEvent(new Event('fire:assets-updated'));});await page.waitForTimeout(150);assert(await page.locator('[data-stock="US:ROBN"] img').isVisible(),'a failed read preserves known artwork');
  await page.evaluate(()=>{window.fixture.iconFailure=false;window.fixture.iconsMissing=true;window.dispatchEvent(new Event('fire:assets-updated'));});await page.waitForFunction(()=>!document.querySelector('[data-stock="US:ROBN"] img')&&!document.querySelector('[data-stock="HK:700"] img'));
  await page.goto(base+'/?view=icons&holdIcons=1');await page.waitForFunction(()=>!!window.fixture.releaseIcons);await page.evaluate(()=>{window.fixture.iconVersion=3;window.fixture.holdIcons=false;window.dispatchEvent(new Event('fire:assets-updated'));window.fixture.releaseIcons();});await page.waitForFunction(()=>document.querySelector('[data-stock="US:ROBN"] img')?.getAttribute('src').includes('v=3'));
  await page.goto(base+'/?view=icons-seeded');await page.waitForSelector('[data-stock="US:ROBN"] img');assert.deepEqual(await page.evaluate(()=>window.fixture.iconRenders[0]),['/fixture-icon.svg?v=1','/fixture-icon.svg?v=1'],'first render uses server-seeded artwork');assert(!(await page.evaluate(()=>window.fixture.calls)).some(c=>c.path.startsWith('/api/assets?type=stock')),'seeded icons do not wait for a client lookup');
  await page.reload();await page.waitForSelector('[data-stock="HK:700"] img');assert.deepEqual(await page.evaluate(()=>window.fixture.iconRenders[0]),['/fixture-icon.svg?v=1','/fixture-icon.svg?v=1'],'refresh also starts with the real artwork');
  for(const width of [1280,390,320])for(const dark of [false,true]){
   await page.setViewportSize({width,height:900});await page.goto(base+'/?view=profile');await page.evaluate(d=>document.documentElement.classList.toggle('dark',d),dark);await page.locator('.personal-profile-toolbar').waitFor();
   const geometry=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};return{cover:box('.personal-cover'),avatar:box('.personal-avatar-edit'),edit:box('.personal-edit'),name:box('.personal-profile h1'),profile:box('.personal-profile'),stats:box('.personal-home-stats'),background:getComputedStyle(document.querySelector('.personal-cover')).backgroundImage,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('*')].map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,w:el.getBoundingClientRect().width,overflow:getComputedStyle(el).overflowX})).filter(el=>el.right>innerWidth+1).slice(0,12)};});
   assert(geometry.avatar.y<geometry.cover.bottom&&geometry.avatar.bottom>geometry.cover.bottom,'avatar overlaps the cover edge');assert(geometry.edit.y>=geometry.cover.bottom,'edit action sits below the background');assert(geometry.name.y>=geometry.avatar.bottom,'identity sits beneath the avatar');assert(geometry.stats.y-geometry.profile.bottom>=23,'statistics are separated from the profile');assert(Math.abs(geometry.cover.width/geometry.cover.height-2.35)<.02,'cover matches the reference banner proportions');assert(!geometry.background.includes('linear-gradient'),'background is not dimmed behind overlaid identity');assert(geometry.scroll<=width,'narrow layout overflow: '+JSON.stringify({width,dark,...geometry}));
   assert.equal(await page.locator('.personal-profile-id').textContent(),'ID: 17');
   if(width!==320)await page.screenshot({path:path.join(output,'profile-'+width+'-'+(dark?'dark':'light')+'.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);console.log('PASS foreground retention, authorization/instance isolation, read-only stock artwork, artwork refresh, and profile geometry in light/dark desktop/mobile.');
 }finally{console.log('Visual evidence: '+output);await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
