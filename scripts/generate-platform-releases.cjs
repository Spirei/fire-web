const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),Module=require('node:module');
const root=path.resolve(__dirname,'..'),file=path.join(root,'lib/versions.ts'),moduleInstance=new Module(file);
moduleInstance._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const records=moduleInstance.exports.VERSIONS.map(item=>({version:item.version.replace(/^v/,''),date:item.date,changes:item.changes.map(change=>change.title+'：'+change.desc)}));
fs.writeFileSync(path.join(root,'platform/contracts/releases.json'),JSON.stringify({releases:records},null,2)+'\n');
