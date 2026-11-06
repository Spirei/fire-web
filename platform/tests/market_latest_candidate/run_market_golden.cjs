// Actual old normalization executed; every provider/DB/timer dependency is unavailable.
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript'),path=require('node:path');
const root=process.argv[2],evidence=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const read=name=>{const source=fs.readFileSync(path.join(root,name),'utf8');if(crypto.createHash('sha256').update(source).digest('hex')!==evidence.source_sha256[name])throw Error('Legacy source identity changed');return source;};
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const market={exports:{}};new vm.Script(compile(read('lib/marketCode.ts'))).runInContext(vm.createContext({exports:market.exports,module:market}),{timeout:1000});
const demand={exports:{}};new vm.Script(compile(read('lib/quoteDemand.ts'))).runInContext(vm.createContext({exports:demand.exports,module:demand,require(name){if(name==='./marketCode')return market.exports;throw Error('No IO permitted');}}),{timeout:1000});
const vectors=JSON.parse(fs.readFileSync(process.argv[4],'utf8'));
process.stdout.write(JSON.stringify(vectors.map(items=>demand.exports.publicQuoteItems(items))));
