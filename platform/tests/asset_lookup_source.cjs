const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const context=vm.createContext({}),root=process.argv[2];
async function load(name,deps){const m=new vm.SourceTextModule(stripTypeScriptTypes(fs.readFileSync(path.join(root,name),'utf8'),{mode:'transform'}),{context});await m.link(key=>{if(deps[key] instanceof vm.Module)return deps[key];return new vm.SyntheticModule(Object.keys(deps[key]),function(){for(const k of Object.keys(deps[key]))this.setExport(k,deps[key][k]);},{context});});await m.evaluate();return m;}
(async()=>{const market=await load('marketCode.ts',{}),parser=await load('assetLookup.ts',{'./marketCode':market}),stock=await load('stockIconKey.ts',{'./relatedEtfs':{RELATED_ETF_MAIN_STOCK:{}}});
const input=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(input.map(raw=>{const keys=parser.namespace.parseAssetLookup(raw);return keys===null?null:keys.map(k=>{let codes=stock.namespace.stockIconLookupCodes(k.market,k.code);if(k.type==='stock'&&k.market==='US')codes=[k.code,...['AM','N','OQ','PS','K'].map(s=>k.code+'.'+s)];if(k.type==='stock'&&k.market==='JP')codes.push(k.code+'.T');if(k.type==='stock'&&k.market==='KR')codes.push(k.code+'.KS',k.code+'.KQ');return {key:k,codes};});})));})().catch(e=>{console.error(e.stack||e);process.exit(1)});
