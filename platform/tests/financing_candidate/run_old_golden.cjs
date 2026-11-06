// Frozen pure original validators/debt only; no source DB/config/network import.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
const lib=path.join(__dirname,'legacy/lib');
const source=file=>fs.readFileSync(path.join(lib,file),'utf8');
function exactBetween(raw,start,end){const a=raw.indexOf(start),b=raw.indexOf(end,a);if(a<0||b<a)throw Error('Frozen source boundaries changed');return raw.slice(a,b);}
const s=source('financingPolicy.ts'),r=source('recordsContract.ts');
const pure=exactBetween(s,'function validate(','\nexport function financingDebt')+'\n'+exactBetween(s,'export function financingDebt','\nexport function enforceFinancingLimit');
const originalError=exactBetween(r,'export class RecordsError','\nexport function recordsDiscovery');
(async()=>{
 const plain=stripTypeScriptTypes((originalError+';let rates={USD:1};function recordedFinancingRates(){return rates;}'+pure).replace(/\bexport /g,''),{mode:'transform'});
 const m=new Function(plain+';return{validate,financingDebt,setRates(value){rates=value;}}')();
 const currencies=['USD','EUR','HKD','MOP','CNY','JPY','KRW','SGD','GBP','AUD','CAD','TWD','CHF','INR','BRL'];
 const policies=currencies.map(currency=>m.validate({currency,limit:100,initialMargin:20,maintenanceMargin:10}));
 const debts=[];for(const [currency,balances,rates] of [['USD',{USD:-100,JPY:-15000,GBP:100},{USD:1,JPY:150}],['JPY',{USD:-100,JPY:-15000},{USD:1,JPY:150}],['CHF',{USD:-100,JPY:-15000},{USD:1,JPY:150,CHF:.9}],['CHF',{USD:100,JPY:100},{USD:1}]]){m.setRates(rates);debts.push({currency,balances,rates,value:m.financingDebt(balances,currency)});}
 m.setRates({USD:1});let missing;try{m.financingDebt({JPY:-1},'USD')}catch(error){missing={message:error.message,status:error.status};}
 let invalidMargin;try{m.validate({currency:'USD',initialMargin:1,maintenanceMargin:2})}catch(error){invalidMargin={message:error.message,status:error.status};}
 const hashes=Object.fromEntries(['financingPolicy.ts','recordsContract.ts'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(lib,file))).digest('hex')]));
 process.stdout.write(JSON.stringify({source:'exact frozen pure original functions; no DB/config/network imports',sha256:hashes,policies,debts,missing,invalidMargin},null,2)+'\n');
})();
