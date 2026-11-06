const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {DatabaseSync}=require('node:sqlite');
const input=JSON.parse(fs.readFileSync(0,'utf8')),sql=new DatabaseSync(':memory:');
sql.exec('CREATE TABLE broker_cash_accounts(user_id,account_id,currency,revision,opening_amount,opening_at,opening_basis)');
for(const row of input.cashRows||[])sql.prepare('INSERT INTO broker_cash_accounts VALUES(?,?,?,?,?,?,?)').run(input.owner,input.account.id,row.currency,row.revision,row.opening_amount,row.opening_at,row.opening_basis);
const cache=new Map();
function load(name){if(name==='./brokerAccounts')return{brokerAccount:()=>input.account};if(name==='./fundCurrencies')return{isFundCurrency:c=>['USD','EUR','HKD','CNY','JPY','KRW','SGD','GBP','AUD','CAD','TWD','MOP','INR','BRL'].includes(c)};if(name==='./recordsContract')return{RecordsError:class extends Error{constructor(message,status=400,code=status*100+1){super(message);this.status=status;this.code=code;}}};if(name==='node:crypto')return require(name);if(name==='./db')return{getDb:()=>sql};if(name==='./brokerCashRead'){const cap=load('withdrawalCapacity');return{readBrokerCashLedger:(_o,_a,c)=>input.ledgers[c],pendingBuyCash:()=>null,withdrawalCapacity:cap.withdrawalCapacity};}if(cache.has(name))return cache.get(name);const filename=path.join(__dirname,'fixtures','broker-cash-read-source',name+'.ts'),module={exports:{}};cache.set(name,module.exports);const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInNewContext(`(function(require,module,exports){${source}\n})`,{})(load,module,module.exports);return module.exports;}
const context={revision:'f'.repeat(64),asOf:input.observedAt,global:{sourceComplete:false},funds:{},reservations:new Map(Object.keys(input.ledgers).map(c=>[c,null]))};
try {
const result=input.mode==='entries'?load('cashEntries').cashEntries(input.owner,input.account.id,input.currency,input.limit,input.offset,input.expected):load('cashSnapshot').cashSnapshot(input.owner,input.account.id,context,input.account);
process.stdout.write(JSON.stringify(result));

} catch(error) { process.stdout.write(JSON.stringify({status:error.status,body:{code:error.code,message:error.message}})); }
