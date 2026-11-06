// Executes actual old parsing functions; every DB/provider/messaging dependency is forbidden.
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript'),path=require('node:path');
const root=process.argv[2],evidence=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const read=(name)=>{const source=fs.readFileSync(path.join(root,name),'utf8');if(crypto.createHash('sha256').update(source).digest('hex')!==evidence.source_sha256[name])throw Error('Old source identity changed');return source;};
const compile=(source)=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const market={exports:{}};
new vm.Script(compile(read('lib/marketCode.ts'))).runInContext(vm.createContext({exports:market.exports,module:market}),{timeout:1000});
const box={exports:{}};
const forbidden=()=>{throw Error('Real source IO forbidden in golden VM');};
class RecordsError extends Error {constructor(message,status=400){super(message);this.status=status;}}
class Clock extends Date {static now(){return Date.parse('2026-10-20T14:00:00Z');}}
const context=vm.createContext({exports:box.exports,module:box,Date:Clock,
 require(id){if(id==='./marketCode')return market.exports;if(id==='./recordsContract')return {RecordsError};
 if(id==='node:crypto')return new Proxy({},{get:()=>forbidden});
 if(!id.startsWith('./'))throw Error('Unexpected old dependency');return new Proxy({},{get:()=>forbidden});},fetch:forbidden});
new vm.Script(compile(read('lib/priceAlerts.ts'))).runInContext(context,{timeout:1000});
const vectors=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
process.stdout.write(JSON.stringify(vectors.map(v=>{try{return{id:v.id,ok:true,rule:box.exports.parseAlert(v.raw)}}catch{return{id:v.id,ok:false}}})));
