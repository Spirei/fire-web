// Original read-only TS projections, controlled memory SQLite, no source/network modules.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const {createRequire}=require('node:module');
const ts=require('typescript');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const DB=createRequire(path.join(root,'package.json'))('better-sqlite3');
const db=new DB(':memory:');if(!db.memory)throw Error('Golden must be memory only');
db.exec('CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES(\'synthetic-owner\')');
function compile(name,dependencies){
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,Date:class extends Date { static now(){return input.now;} },require(name){if(!(name in dependencies))throw Error('Forbidden dependency '+name);return dependencies[name];}});
  vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root,'lib',name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return module.exports;
}
const code=compile('marketCode.ts',{});
const demand=compile('quoteDemand.ts',{'./marketCode':code});
compile('quoteSubscriptionsSchema.ts',{}).installQuoteSubscriptions(db);
for(const row of input.rows)db.prepare('INSERT INTO quote_subscriptions VALUES(?,?,?,?,?)').run('synthetic-owner',row.market,row.code,row.last_requested_at,row.reads??2);
const storeModule=compile('quoteSubscriptionsStore.ts',{'./quoteDemand':demand});
const view=compile('quotePoolView.ts',{'./quoteDemand':demand});
const data=compile('quotePoolData.ts',{'./db':{getDb:()=>db},'./assets':{getAssetMatches:()=>[]},'./quotes':{readActiveQuotePool:()=>input.runtime??[]},'./quoteSubscriptionsStore':storeModule,'./quotePoolView':view,'./marketCode':code});
const store=new storeModule.QuoteSubscriptionsStore(db,{now:()=>input.now});
const result={subscriptions:store.list('synthetic-owner',input.market),pool:data.readQuotePool('synthetic-owner',input.scope??'mine'),memoryOnly:true};
db.close();process.stdout.write(JSON.stringify(result));
