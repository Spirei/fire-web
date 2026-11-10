const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const modules=new Map();function load(file){file=path.resolve(file);if(modules.has(file))return modules.get(file);const m={exports:{}};modules.set(file,m.exports);new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id.startsWith('@/')?load(path.join(process.cwd(),id.slice(2)+'.ts')):id.startsWith('.')?load(path.resolve(path.dirname(file),id+'.ts')):require(id),m,m.exports);return m.exports;}
const {stockIconBatches,readStockIcons,stockIconPreloads}=load('lib/stockIconRequests.ts');
(async()=>{
 const groups=stockIconBatches([{market:' us ',code:'ROBN.AM'},{market:'US',code:'HOOD'},{market:'HK',code:'700'},{market:'ASSET',code:'BTC'}]);
 assert(groups.flat().includes('US:HOOD'));assert(groups.flat().includes('US:ROBN.AM'));assert.equal(groups.flat().filter(k=>k==='US:HOOD').length,1);assert(!groups.flat().includes('ASSET:BTC'));
 const many=Array.from({length:253},(_,n)=>({market:'US',code:'DEMO'+n}));assert.deepEqual(stockIconBatches(many).map(b=>b.length),[100,100,53]);
 let active=0,max=0,calls=[];
 const icons=await readStockIcons(many,async url=>{calls.push(url);max=Math.max(max,++active);await new Promise(r=>setImmediate(r));active--;const keys=new URL(url,'http://test.invalid').searchParams.get('keys').split(',');if(keys[0]==='US:DEMO100')throw Error('synthetic unavailable batch');return{assets:keys.map(key=>({type:'stock',market:'US',code:key.split(':')[1],imageUrl:'/api/asset-image/'+key.split(':')[1]}))};});
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const {primeStockIconCache,useAssetIcons}=load('lib/useAssetIcons.ts');
 const seeded={'US:HOOD':'/uploads/asset/stock/US/HOOD.png','HK:00700':'/uploads/asset/stock/HK/example.svg'};
 primeStockIconCache(seeded);
 function FirstPaint(){const {stockIcons}=useAssetIcons(['stock']);return React.createElement('div',null,...['US:ROBN.AM','HK:700'].map(key=>React.createElement('img',{key,src:stockIcons[key],alt:''})));}
 const firstHtml=renderToStaticMarkup(React.createElement(FirstPaint));assert(firstHtml.includes('src="'+seeded['US:HOOD']+'"')&&firstHtml.includes('src="'+seeded['HK:00700']+'"'),'server HTML carries real icon URLs before effects or client reads');
 assert.deepEqual(stockIconPreloads([{market:'US',code:'ROBN.AM'},{market:'US',code:'HOOD'},{market:'HK',code:'700'}],seeded),Object.values(seeded));assert.equal(stockIconPreloads(many,icons).length,12);
 assert(max<=2);assert.equal(calls.length,3);assert(calls.every(url=>url.startsWith('/api/assets?type=stock&keys=')));assert.equal(Object.keys(icons).length,153);assert(icons['US:DEMO252']);assert(!icons['US:DEMO100']);
 console.log('PASS stock icon reads use the existing library, include ETF underlyings, deduplicate and bound batches, and retain partial results without writes.');
})().catch(e=>{console.error(e);process.exitCode=1;});
