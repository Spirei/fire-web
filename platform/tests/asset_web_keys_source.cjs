const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const root=process.argv[2],context=vm.createContext({URL,Date});
async function load(name,deps={}){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,name),'utf8'),{mode:'transform'}),{context});await m.link(key=>new vm.SyntheticModule(Object.keys(deps[key]),function(){for(const n of Object.keys(deps[key]))this.setExport(n,deps[key][n]);},{context}));await m.evaluate();return m.namespace;}
(async()=>{const related=await load('relatedEtfs.ts'),stock=await load('stockIconKey.ts',{'./relatedEtfs':{RELATED_ETF_MAIN_STOCK:related.RELATED_ETF_MAIN_STOCK}});
let captured;
const assets={};for(const n of ['deleteAsset','ensureBrokerAssets','ensureCategoryAssets','ensureIconAssets','ensureMarketAssets','ensureStockAssets','getAssets','getAssetsPage','upsertAsset'])assets[n]=()=>{};
assets.getFlagIconMap=c=>{captured=c;return {}};assets.getStockIconMap=c=>{captured=c;return {}};
const route=await load('web-route.ts',{'@/lib/requestBody':{readJsonBody:()=>{}},'next/server':{NextResponse:{json:x=>x}},'@/lib/auth':{getAuthUser:()=>{},isAdmin:()=>{}},'@/lib/assets':assets,'@/lib/cardLibrary':{ensureCardAssets(){}},'@/lib/assetQuotes':{enrichAssetQuotes:x=>x,enrichStockAssetQuotes:x=>x},'@/lib/db':{getDb(){throw Error('No database')}}});
const queries=JSON.parse(fs.readFileSync(0,'utf8'));const parsed=[];for(const q of queries){captured=null;await route.GET({url:'http://source.test/api/assets?'+new URLSearchParams(q)});parsed.push(captured)}
console.log(JSON.stringify({parsed,related:related.RELATED_ETF_MAIN_STOCK,codes:[['HK','9992'],['HK','00000'],['US','demo.oq'],['JP',' abc.t ']].map(([m,c])=>stock.stockIconLookupCodes(m,c)),maps:[stock.applyRelatedEtfMainStockIcons({'US:NVDL':'etf','US:NVDA':'main'}),stock.applyRelatedEtfMainStockIcons({'US:NVDL':'etf'})]}));})().catch(e=>{console.error(e.stack||e);process.exit(1)});
