// Real account-asset component with controlled observations; no real data or writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const esbuild=require('esbuild'),postcss=require('postcss'),tailwind=require('tailwindcss'),ts=require('typescript');
const {chromium}=require('@playwright/test');
const root=path.resolve(__dirname,'..');
(async()=>{
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import MarketSourceSettings from '@/components/MarketSourceSettings';import PnlCalendar from '@/components/PnlCalendar';import {registeredPnlCalendar} from '@/lib/pnlCalendar';
 window.probes=0;window.concurrent=0;window.peak=0;window.saves=[];window.fetch=async(input,init={})=>{if(!init.method||init.method==='GET')return Response.json({results:{}});window.probes++;window.concurrent++;window.peak=Math.max(window.peak,window.concurrent);const b=JSON.parse(init.body);await new Promise(resolve=>setTimeout(resolve,60));window.concurrent--;return Response.json({requestId:b.requestId,state:b.provider==='eastmoney'?'unconfigured':'available',price:b.provider==='eastmoney'?undefined:210.25,code:'AAPL',market:'US',elapsedMs:125,observedAt:'2026-11-12T00:00:00Z'});};
 const calendar=registeredPnlCalendar([{id:'legacy-42',recordId:'uuid',name:'Synthetic',market:'US',code:'AAPL',side:'sell',status:'filled',realizedPnl:123.45,tradedAt:'2026-10-02T16:00:00Z'}],{USD:1},2026,10);
 function Harness(){const[order,setOrder]=useState(undefined),[mode,setMode]=useState('收益'),[view,setView]=useState('month');return <><h1 className="mb-5 text-xl font-semibold">行情源</h1><MarketSourceSettings order={order} onSave={async(next)=>{window.saves.push(next);setOrder(next);return true;}}/><div className="mt-8"><PnlCalendar title="已登记盈亏日历" days={calendar.days} yearSummary={calendar.months} month={{y:2026,m:10}} onMonthChange={()=>{}} view={view} onViewChange={setView} mode={mode} onModeChange={setMode} market="全部" onMarketChange={()=>{}} formatAmount={v=>'$'+v.toFixed(2)} formatCompact={v=>'$'+v.toFixed(2)} onDayClick={()=>{}} dayDetail={null} onDayDetailClose={()=>{}}/></div></>;}createRoot(document.getElementById('root')).render(<Harness/>);`;
 const workspace=`export const useWorkspaceActive=()=>true;export const useWorkspaceSearchParams=()=>new URLSearchParams(location.search);export const useWorkspaceLocationGuard=()=>()=>true;export const useWorkspaceScrollRef=()=>({current:null});export const useWorkspaceState=()=>null;`;
 const js=await esbuild.build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'context',setup(b){b.onResolve({filter:/^(?:@\/lib\/workspacePanel|.*\/workspacePanel)$/},()=>({path:'workspace',namespace:'mock'}));b.onResolve({filter:/^next\/navigation$/},()=>({path:'next',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='workspace'?workspace:`export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>location.pathname;`,loader:'js'}));}}]});
 const mod={exports:{}};new Function('exports','require',ts.transpileModule(fs.readFileSync('tailwind.config.ts','utf8'),{compilerOptions:{module:1}}).outputText)(mod.exports,require);
 const css=await postcss([tailwind({...mod.exports.default,content:[path.join(root,'components/**/*.{tsx,ts}')]})]).process(fs.readFileSync('app/globals.css','utf8')+'\n'+fs.readFileSync('styles/capsules.css','utf8'),{from:path.join(root,'app/globals.css')});
 const styled=await esbuild.build({stdin:{contents:css.css,resolveDir:path.join(root,'app'),loader:'css'},bundle:true,write:false,external:['*.woff2','*.woff','*.svg','*.png','*.webp','*.jpg']});
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js.outputFiles[0].contents);}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(styled.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<html data-palette="meta" style="--site-ink:28 30 33;--site-surface:255 255 255;--site-action:#0866ff;--site-action-hover:#075ce5"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main style="max-width:1100px;margin:auto;padding:16px"><div id="root" data-capsule-scope="non-home"></div></main><script src="/app.js"></script></body></html>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:'+server.address().port;
  const list=page.getByRole('list',{name:'行情源优先顺序'}),rows=list.locator('li');
  await page.goto(base);await page.getByRole('button',{name:'检测全部',exact:true}).waitFor();
  assert.deepEqual(await rows.locator('strong').allTextContents(),['富途','腾讯','东方财富','Yahoo']);
  assert.equal(await page.evaluate(()=>window.probes),0,'opening settings never probes a source');
  await page.getByRole('button',{name:'拖动Yahoo排序'}).dragTo(rows.first());
  await page.waitForFunction(()=>window.saves.length===1);
  assert.deepEqual(await rows.locator('strong').allTextContents(),['Yahoo','富途','腾讯','东方财富']);
  await page.getByRole('button',{name:'检测全部',exact:true}).click();
  await page.waitForFunction(()=>window.probes===4&&window.concurrent===0);
  assert.equal(await list.getByText('报价可用',{exact:true}).count(),3);
  assert.equal(await list.getByText('未配置',{exact:true}).count(),1);
  assert((await page.evaluate(()=>window.peak))<=2,'source checks use bounded concurrency');
  assert((await page.locator('body').innerText()).includes('$123.45'));
  await page.getByRole('button',{name:'收益率',exact:true}).click();
  assert(!(await page.locator('body').innerText()).includes('NaN'));
  await page.getByRole('button',{name:'年',exact:true}).click();
  assert(!(await page.locator('body').innerText()).includes('NaN'));
  for(const width of [1280,390,320])for(const dark of [false,true]){
   await page.setViewportSize({width,height:1100});await page.evaluate(d=>{document.documentElement.classList.toggle('dark',d);document.documentElement.style.setProperty('--site-ink',d?'241 243 245':'28 30 33');document.documentElement.style.setProperty('--site-surface',d?'34 38 45':'255 255 255');},dark);
   assert(await list.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'source list fits the viewport');
   if(process.env.UI_CAPTURE_DIR){fs.mkdirSync(process.env.UI_CAPTURE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_CAPTURE_DIR,`sources-${width}-${dark?'dark':'light'}.png`),fullPage:true});}
  }
  assert.deepEqual(errors,[]);console.log('PASS source ordering/drag/save, explicit bounded checks, truthful states, registered calendar and mobile/dark/light rendering');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
