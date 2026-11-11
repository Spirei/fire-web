// Real account-asset component with controlled observations; no real data or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const esbuild=require('esbuild'),postcss=require('postcss'),tailwind=require('tailwindcss'),ts=require('typescript');
const {chromium}=require('@playwright/test');
const root=path.resolve(__dirname,'..');
(async()=>{
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import HoldingsView from '@/components/views/HoldingsView';import FireView from '@/components/views/FireView';import IndexTicker from '@/components/IndexTicker';import {accountHoldingPrice} from '@/lib/accountCash';
 const records=[{id:'usd',market:'US',code:'AAPL',name:'Synthetic USD',qty:10,cost:20,price:25,group:'Synthetic',accountMarket:'US'}, {id:'cny',market:'CN',code:'600000',name:'Synthetic CNY',qty:5,cost:15,price:location.search.includes('missing=1')?0:20,group:'Synthetic',accountMarket:'CN'}];
 window.fixtureRates={USD:1};window.fixtureWrites=0;window.fetch=async(input,init={})=>{if(init.method&&init.method!=='GET'){window.fixtureWrites++;return Response.json({});}const url=String(input);return Response.json(url==='/api/fire/ticker'?{items:[{key:'index',market:'US',secid:'100.DJIA',price:100,source:'controlled',sourceRevision:'fixture',observedAt:'2026-11-12T00:00:00Z'}]}:url==='/api/rates'?{base:'USD',rates:window.fixtureRates,quoted:[],updatedAt:null}:url.includes('/fire-settings')?{fire:{baseCurrency:'CNY',fireTargetBase:12000}}:url.includes('/funds')?{data:{balances:{USD:0,CNY:0}}}:url.includes('/assets')?{assets:[]}:{settings:{}});};
 function Harness(){const[collapsed,setCollapsed]=useState(false);return <><header className="app-shell-header"><div className="app-shell-header-inner flex"><div className="app-shell-ticker"><IndexTicker configuration={{items:[{key:'index',label:'示例指数',secid:'100.DJIA',market:'US'}],interval:5}}/></div></div></header><div className="records-app" data-sidebar-collapsed={collapsed}><button onClick={()=>setCollapsed(v=>!v)}>Toggle sidebar</button>{location.search.includes('fire=1')?<FireView records={records} quotes={{}} livePrice={r=>accountHoldingPrice(r,{})}/>:<HoldingsView records={records} quotes={{}} livePrice={r=>accountHoldingPrice(r,{})} onAddMatch={async()=>{}} onUpdate={async()=>true} onRemove={async()=>{}} groups={[]} markets={['US','CN']} marketLabels={[]} marketOptions={[]} initialFundBalances={{USD:0,CNY:0}} valuationReady={true}/>}</div></>;}createRoot(document.getElementById('root')).render(<Harness/>);`;
 const workspace=`export const useWorkspaceActive=()=>true;export const useWorkspaceSearchParams=()=>new URLSearchParams(location.search);export const useWorkspaceLocationGuard=()=>()=>true;export const useWorkspaceScrollRef=()=>({current:null});export const useWorkspaceState=()=>null;`;
 const js=await esbuild.build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'context',setup(b){b.onResolve({filter:/^(?:@\/lib\/workspacePanel|.*\/workspacePanel)$/},()=>({path:'workspace',namespace:'mock'}));b.onResolve({filter:/^next\/navigation$/},()=>({path:'next',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='workspace'?workspace:`export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>location.pathname;`,loader:'js'}));}}]});
 const mod={exports:{}};new Function('exports','require',ts.transpileModule(fs.readFileSync('tailwind.config.ts','utf8'),{compilerOptions:{module:1}}).outputText)(mod.exports,require);
 const css=await postcss([tailwind({...mod.exports.default,content:[path.join(root,'components/**/*.{tsx,ts}')]})]).process(fs.readFileSync('app/globals.css','utf8'),{from:path.join(root,'app/globals.css')});
 const styled=await esbuild.build({stdin:{contents:css.css,resolveDir:path.join(root,'app'),loader:'css'},bundle:true,write:false,external:['*.woff2','*.woff','*.svg','*.png','*.webp','*.jpg']});
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js.outputFiles[0].contents);}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(styled.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main style="max-width:1100px;margin:auto;padding:16px"><div id="root"></div></main><script src="/app.js"></script></body></html>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:'+server.address().port;
  const card=label=>page.locator('.card').filter({has:page.getByText(label,{exact:true})}).first();
  await page.goto(base+'/?market=US');await page.getByText('Synthetic USD',{exact:true}).waitFor();
  assert((await card('持仓市值').innerText()).includes('250.00'));
  assert((await card('持仓盈亏').innerText()).includes('50.00'));
  assert((await card('当日盈亏').innerText()).includes('—'),'missing daily change is not zero');
  await page.getByText('示例指数',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.ticker-item')?.title.includes('controlled'));
  assert((await page.locator('.ticker-item').getAttribute('title')).includes('2026-11-12T00:00:00Z'));
  assert(await page.evaluate(()=>Object.keys(sessionStorage).some(key=>key.includes('ticker')&&JSON.parse(sessionStorage.getItem(key)).readAt>0)));
  const expanded=await page.locator('.ticker-item').boundingBox();
  await page.getByRole('button',{name:'Toggle sidebar',exact:true}).click();
  const collapsed=await page.locator('.ticker-item').boundingBox();
  assert.equal(Math.round(expanded.x-collapsed.x),176,'left-aligned ticker follows the 240/64 sidebar widths');
  assert.equal(await page.locator('.app-shell-ticker').evaluate(el=>getComputedStyle(el).justifyContent),'flex-start');
  await page.goto(base+'/?market=CN');await page.getByText('Synthetic CNY',{exact:true}).waitFor();
  assert((await card('持仓市值').innerText()).includes('100.00'),'native CNY value needs no exchange rate');
  assert((await card('持仓盈亏').innerText()).includes('25.00'));
  await page.goto(base+'/?market=TOTAL');await page.getByText('Synthetic CNY',{exact:true}).waitFor();
  assert((await card('持仓市值').innerText()).includes('—'),'incomplete FX cannot produce a complete cross-currency total');
  assert(!(await card('持仓市值').innerText()).includes('…'),'a completed partial read is not still loading');
  for(const width of [1280,390,320])for(const dark of [false,true]){
   await page.setViewportSize({width,height:900});await page.evaluate(d=>document.documentElement.classList.toggle('dark',d),dark);
   assert(!(await page.locator('body').innerText()).includes('NaN'));
   if(process.env.UI_CAPTURE_DIR){fs.mkdirSync(process.env.UI_CAPTURE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_CAPTURE_DIR,`valuation-${width}-${dark?'dark':'light'}.png`),fullPage:true});}
  }
  await page.goto(base+'/?market=CN&missing=1');await page.getByText('Synthetic CNY',{exact:true}).waitFor();assert(!/NaN|Infinity|[+−]—/.test(await page.locator('body').innerText()),'missing mark cells do not render invalid rates or signed placeholders');
  await page.goto(base+'/?fire=1');await page.getByText('当前资产',{exact:true}).first().waitFor();
  await page.waitForTimeout(900);assert.equal(await page.evaluate(()=>window.fixtureWrites),0,'missing FX must not overwrite a saved FIRE plan');assert(!(await page.locator('body').innerText()).includes('NaN'));assert((await page.locator('body').innerText()).includes('暂无汇率'));
  await page.evaluate(()=>{window.fixtureRates={USD:1,CNY:7};window.dispatchEvent(new Event('fire:rates-updated'));});await page.getByText('¥1,850.00',{exact:true}).first().waitFor();
  assert.deepEqual(errors,[]);console.log('PASS native USD/CNY values, unavailable daily observations/FX totals, settled loading and 320/390/1280 dark/light rendering');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
