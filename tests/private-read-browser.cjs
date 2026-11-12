// Real account-asset component with controlled observations; no real data or financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const esbuild=require('esbuild'),postcss=require('postcss'),tailwind=require('tailwindcss'),ts=require('typescript');
const {chromium}=require('@playwright/test');
const root=path.resolve(__dirname,'..');
(async()=>{
 const fixture=`import React,{useState,useCallback} from 'react';import {createRoot} from 'react-dom/client';import QuotesView from '@/components/views/QuotesView';import FxConverter from '@/components/FxConverter';import AssetPnlAnalysis from '@/components/AssetPnlAnalysis';import AssetAnalysisView from '@/components/views/AssetAnalysisView';import {FUND_CURRENCIES} from '@/lib/fundCurrencies';import {quoteInstrumentKey} from '@/lib/quoteBatches';import {intradayCacheKey} from '@/lib/intradayCache';
 window.chartReads=0;window.rateReads=0;window.reads=0;window.writes=0;window.writePaths=[];window.fundFailure=true;window.chartMode='ready';window.rateMode='ready';window.fixtureRates={USD:1};window.owner='owner-uuid';
 const record={id:'row-uuid',market:'HK',code:'00700',name:'Synthetic Holding',qty:10,cost:10,price:20,type:'holdings',watchlist:true,group:'Synthetic',updatedAt:'2026-10-01T00:00:00Z'};
 const chart={date:'2026-11-12',source:'controlled',points:[{time:'09:30',price:10},{time:'09:31',price:15}]};
 localStorage.setItem(intradayCacheKey(window.owner),JSON.stringify({version:2,owner:'another-account',entries:{'row-uuid':{instrument:quoteInstrumentKey(record),chart,readAt:Date.now()}}}));
 window.fetch=async(input,init={})=>{window.reads++;const url=String(input);if(init.method==='POST'&&['/api/v1/portfolio-series/prepare','/api/kline/prepare'].includes(url))return Response.json({error:'history preparation is not available in this fixture'},{status:405});if(init.method&&init.method!=='GET'&&!['/api/charts','/api/quotes'].includes(url)){window.writes++;window.writePaths.push(url);return Response.json({error:'test has no financial writes'},{status:405});}
 if(url==='/api/charts'){window.chartReads++;const mode=window.chartMode;if(mode==='hold')return await new Promise(resolve=>window.releaseChart=()=>resolve(Response.json({charts:{'row-uuid':chart}})));if(mode==='denied')return Response.json({error:'已撤销'},{status:403});return Response.json({charts:mode==='empty'?{}:{'row-uuid':chart}});}
 if(url==='/api/quotes')return Response.json({quotes:{}});
 if(url==='/api/rates'){window.rateReads++;const data={base:'USD',rates:window.fixtureRates,quoted:Object.keys(window.fixtureRates),updatedAt:null};if(window.rateMode==='hold')return new Promise(resolve=>window.releaseRates=()=>{window.releaseRates=null;resolve(Response.json(data));});if(window.rateMode==='failed')return Response.json({message:'汇率服务暂时不可用'},{status:503});return Response.json(data);}
 if(url.includes('/funds')){if(window.fundFailure)return Response.json({message:'资金暂时无法读取'},{status:503});const balances=Object.fromEntries(FUND_CURRENCIES.map(c=>[c,c==='USD'?50:0]));return Response.json({code:0,data:{balances,cardCash:{USD:0},summaries:Object.fromEntries(FUND_CURRENCIES.map(c=>[c,{openingAsset:0,cashNetFlow:0,stockNetFlow:0,otherNetFlow:0}])),transactions:[],pagination:{total:0}}});}
 if(url.includes('/portfolio-series'))return Response.json({closes:{'row-uuid':[{d:'2026-10-01',c:10},{d:'2026-10-02',c:20}]},orders:[],days:330,at:Date.now()});
 if(url.includes('/kline/full'))return Response.json({items:[]});
 if(url.includes('/watch-groups'))return Response.json({code:0,data:{groups:[]}});
 if(url.includes('/settings'))return Response.json({settings:{}});
 if(url.includes('/assets'))return Response.json({assets:[]});
 if(url==='/api/records')return Response.json([record]);return Response.json({code:0,data:[],items:[]});};
 function Harness(){const[rows,setRows]=useState([record]);window.changeCode=()=>setRows([{...record,code:'00005'}]);window.changeOwner=()=>setRows([{...record,name:'Changed'}]);const onAdd=useCallback(async()=>true,[]);return <div className="records-app"><div className="records-content"><div className="tab-panel" data-workspace="assets">{location.search.includes('fx')?<FxConverter/>:location.search.includes('dashboard')?<AssetAnalysisView records={rows} quotes={{}} livePrice={r=>r.price} user={{id:window.owner,username:'synthetic',role:'user'}}/>:location.search.includes('pnl')?<AssetPnlAnalysis ownerId={window.owner} initialRecords={rows} initialQuotes={{}}/>:<QuotesView ownerId={window.owner} initialNow={Date.now()} records={rows} quotes={{}} quoteAt="" refreshing={false} refreshQuotes={()=>{}} onAddMatch={onAdd} groups={[]} onToggleWatch={onAdd}/>}</div></div></div>;}createRoot(document.getElementById('root')).render(<Harness/>);`;
 const workspace=`export const useWorkspaceActive=()=>true;export const useWorkspaceSearchParams=()=>new URLSearchParams(location.search);export const useWorkspaceLocationGuard=()=>()=>true;export const useWorkspaceScrollRef=()=>({current:null});export const useWorkspaceState=()=>null;`;
 const js=await esbuild.build({stdin:{contents:fixture,resolveDir:root,loader:'tsx'},bundle:true,write:false,outfile:'fixture.js',jsx:'automatic',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'context',setup(b){b.onResolve({filter:/^(?:@\/lib\/workspacePanel|.*\/workspacePanel)$/},()=>({path:'workspace',namespace:'mock'}));b.onResolve({filter:/^next\/navigation$/},()=>({path:'next',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='workspace'?workspace:`export const useRouter=()=>({push:()=>{},replace:()=>{},refresh:()=>{}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>location.pathname;`,loader:'js'}));}}]});
 const mod={exports:{}};new Function('exports','require',ts.transpileModule(fs.readFileSync('tailwind.config.ts','utf8'),{compilerOptions:{module:1}}).outputText)(mod.exports,require);
 const css=await postcss([tailwind({...mod.exports.default,content:[path.join(root,'components/**/*.{tsx,ts}')]})]).process(fs.readFileSync('app/globals.css','utf8')+'\n'+fs.readFileSync('styles/palettes.css','utf8')+'\n'+fs.readFileSync('styles/capsules.css','utf8'),{from:path.join(root,'app/globals.css')});
 const styled=await esbuild.build({stdin:{contents:css.css,resolveDir:path.join(root,'app'),loader:'css'},bundle:true,write:false,external:['*.woff2','*.woff','*.svg','*.png','*.webp','*.jpg']});
 const server=http.createServer((req,res)=>{if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js.outputFiles[0].contents);}else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(styled.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<html data-palette="meta" data-platform-align="left" style="--platform-content-width:960px"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><main style="width:100%;padding:16px"><div id="root"></div></main><script src="/app.js"></script></body></html>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined});
  const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const base='http://127.0.0.1:'+server.address().port;
  await page.goto(base);await page.getByText('Synthetic Holding',{exact:true}).waitFor();
  await page.waitForFunction(()=>window.chartReads===1);await page.locator('.mini-trend-line').waitFor();
  assert.equal(await page.locator('.mini-trend-line').count(),1);
  await page.evaluate(()=>{window.chartMode='hold';window.changeCode();});
  await page.waitForFunction(()=>!!window.releaseChart);assert.equal(await page.locator('.mini-trend-line').count(),0,'editing one row never displays the old security chart');
  await page.evaluate(()=>{window.chartMode='empty';window.dispatchEvent(new Event('fire:settings-updated'));window.releaseChart();});
  await page.waitForFunction(()=>window.chartReads>=3);await page.waitForTimeout(100);assert.equal(await page.locator('.mini-trend-line').count(),0,'withdrawn and late observations stay withdrawn');
  await page.evaluate(()=>{window.chartMode='ready';window.dispatchEvent(new Event('fire:settings-updated'));});await page.locator('.mini-trend-line').waitFor();
  await page.evaluate(()=>{window.chartMode='denied';window.dispatchEvent(new Event('fire:settings-updated'));});await page.waitForFunction(()=>window.chartReads>=5);await page.waitForTimeout(100);assert.equal(await page.locator('.mini-trend-line').count(),0,'denied history cannot revive cached chart');
  await page.goto(base+'/?fx');await page.waitForFunction(()=>window.rateReads>0);await page.evaluate(()=>{window.fixtureRates={USD:1,EUR:.9};window.dispatchEvent(new Event('fire:settings-updated'));});await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(el=>el.value==='90.00'||el.value==='90'));
  await page.evaluate(()=>{window.rateMode='hold';window.fixtureRates={USD:1,EUR:.8};window.dispatchEvent(new Event('fire:settings-updated'));});
  await page.waitForFunction(()=>typeof window.releaseRates==='function');
  assert((await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).some(value=>Number(value)===90),'ordinary settings revalidation keeps the displayed observation while a replacement is pending');
  await page.evaluate(()=>window.releaseRates());await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(el=>Number(el.value)===80));
  await page.evaluate(()=>{window.dispatchEvent(new CustomEvent('fire:settings-updated',{detail:{fxSourceChanged:true}}));});
  await page.waitForFunction(()=>typeof window.releaseRates==='function');
  assert(!(await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).some(value=>Number(value)===80),'an explicitly changed FX provider cannot retain the old provider result');
  await page.evaluate(()=>window.releaseRates());await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(el=>Number(el.value)===80));
  await page.evaluate(()=>{window.rateMode='failed';window.dispatchEvent(new Event('fire:settings-updated'));});await page.getByRole('alert').waitFor();
  assert((await page.locator('input').evaluateAll(inputs=>inputs.map(input=>input.value))).some(value=>Number(value)===80),'a failed ordinary revalidation keeps the last same-source observation');
  await page.evaluate(()=>{window.rateMode='ready';});
  await page.evaluate(()=>{window.fixtureRates={USD:1};window.dispatchEvent(new Event('fire:settings-updated'));});await page.waitForFunction(()=>![...document.querySelectorAll('input')].some(el=>[80,90].includes(Number(el.value))));
  await page.goto(base+'/?pnl');await page.getByText('股票累计盈亏',{exact:true}).waitFor();await page.waitForTimeout(150);
  assert((await page.getByText('股票累计盈亏',{exact:true}).locator('..').innerText()).includes('—'),'missing FX cannot be counted at 1:1');
  await page.evaluate(()=>{window.fixtureRates={USD:1,HKD:8};window.dispatchEvent(new Event('fire:rates-updated'));});
  await page.waitForFunction(()=>[...document.querySelectorAll('strong')].some(el=>el.textContent==='+$12.50'));
  await page.goto(base+'/?dashboard');await page.getByText('资金暂时无法读取',{exact:true}).waitFor();
  assert((await page.locator('.asset-account-card').innerText()).includes('—'));
  await page.evaluate(()=>{window.fundFailure=false;window.fixtureRates={USD:1,HKD:8};window.dispatchEvent(new Event("fire:rates-updated"));});await page.locator('.funds-panel').getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.funds-panel [role="status"]'));
  await page.waitForFunction(()=>document.querySelector('.asset-account-card').textContent.includes('75.00'));assert((await page.locator('.funds-panel').innerText()).includes('75.00'),'the same observed FX and recovered cash produce matching 75 USD totals');
  await page.evaluate(()=>{window.rateMode='hold';window.dispatchEvent(new Event('fire:settings-updated'));});await page.waitForFunction(()=>typeof window.releaseRates==='function');
  assert((await page.locator('.asset-account-metrics').innerText()).includes('25.00'),'asset-analysis holding valuation survives ordinary settings revalidation before FX returns');
  await page.evaluate(()=>{window.rateMode='ready';window.releaseRates();});await page.waitForFunction(()=>document.querySelector('.asset-account-card').textContent.includes('75.00'));
  const sections=['账户资产','账户总览','持仓分布','资金系统','收益日历'];for(const text of sections)assert((await page.getByText(text,{exact:true}).count())>0,text+' module renders');
  await page.setViewportSize({width:1630,height:1000});
  const sizes=await page.evaluate(()=>{const q=s=>document.querySelector(s).getBoundingClientRect().width;return{page:q('.asset-analysis-page'),left:q('.asset-analysis-split>aside'),right:q('.asset-analysis-split>main')}});
  assert(sizes.page>1100&&sizes.left>=340&&sizes.right>700,'right side gains space without shrinking the left');
  for(const width of [1630,1280,390,320])for(const dark of [false,true]){
   await page.setViewportSize({width,height:1000});await page.evaluate(d=>{document.documentElement.classList.toggle('dark',d);document.querySelector('.records-content').scrollTop=0;window.scrollTo(0,0);},dark);
   assert(!/NaN|Infinity|[+−]—/.test(await page.locator('body').innerText()),'financial placeholders remain neutral and readable');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'page does not overflow');
   if(process.env.UI_CAPTURE_DIR){fs.mkdirSync(process.env.UI_CAPTURE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.UI_CAPTURE_DIR,`analysis-${width}-${dark?'dark':'light'}.png`),fullPage:true});}
  }
  assert.equal(await page.evaluate(()=>window.writes),0,JSON.stringify(await page.evaluate(()=>window.writePaths)));assert.deepEqual(errors,[]);console.log('PASS actual watchlist chart retirement, FX/P&L recovery, analysis modules/fund retry and wider right pane in light/dark desktop/mobile');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
