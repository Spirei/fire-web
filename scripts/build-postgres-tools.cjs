'use strict';
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),out=path.join(root,'server-tools','postgres');
fs.mkdirSync(out,{recursive:true});
for(const name of ['postgresDatabase','postgresSql','postgresFunctions','postgresMigration','postgresRuntime','postgresBackup','secretStorage']){
 const file=path.join(root,'lib',name+'.ts');
 const result=ts.transpileModule(fs.readFileSync(file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}});
 fs.writeFileSync(path.join(out,name+'.js'),result.outputText);
}
fs.copyFileSync(path.join(root,'lib','postgresWorker.cjs'),path.join(out,'postgresWorker.cjs'));
