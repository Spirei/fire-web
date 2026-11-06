// Actual old route/store/service, controlled memory SQLite and timers. No source IO.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');const ts=require('typescript');
const root=process.argv[2],input=JSON.parse(fs.readFileSync(0,'utf8'));
const DB=createRequire(path.join(root,'package.json'))('better-sqlite3');
const db=new DB(':memory:');if(!db.memory)throw Error('Memory DB required');
db.exec("CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES('synthetic-owner')");
let now=input.steps[0].now,syncCalls=0;
function compile(name,dependencies){
 const module={exports:{}};
 const context=vm.createContext({module,exports:module.exports,URL,Request,Response,Date:class extends Date{static now(){return now;}},
 require(name){if(!(name in dependencies))throw Error('Forbidden dependency '+name);return dependencies[name];}});
 vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(root,name),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);return module.exports;
}
const code=compile('lib/marketCode.ts',{}),demand=compile('lib/quoteDemand.ts',{'./marketCode':code});
compile('lib/quoteSubscriptionsSchema.ts',{}).installQuoteSubscriptions(db);
const {QuoteSubscriptionsStore}=compile('lib/quoteSubscriptionsStore.ts',{'./quoteDemand':demand});
const {QuoteSubscriptionService}=compile('lib/quoteSubscriptionService.ts',{});
const store=new QuoteSubscriptionsStore(db,{now:()=>now});
const service=new QuoteSubscriptionService({store:()=>store,namespace:()=>"controlled",sync:()=>syncCalls++},{now:()=>now,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
const ok=data=>Response.json({code:0,message:'ok',data}),fail=(code,message,status)=>Response.json({code,message},{status});
const route=compile('app/api/v2/quote-subscriptions/route.ts',{'@/lib/appApiV2':{appV2Response:(_request,fn)=>fn()},'@/lib/api':{ok,fail},'@/lib/auth':{getAuthUser:()=>({id:'synthetic-owner'})},'@/lib/quoteSubscriptionRequests':{quoteSubscriptionService:async()=>service},'@/lib/quoteDemand':demand,'@/lib/requestBody':{readJsonBody:request=>request.json(),RequestBodyTooLargeError:class extends Error{}},'@/lib/rateLimit':{rateLimit:()=>true}});
(async()=>{const results=[];for(const step of input.steps){now=step.now;const request=new Request('http://fixture.invalid/api/v2/quote-subscriptions',{method:step.method,headers:{'content-type':'application/json'},body:JSON.stringify(step.body)});const response=await route[step.method](request);results.push({status:response.status,body:await response.json()});}service.dispose();db.close();process.stdout.write(JSON.stringify({results,memoryOnly:true,syncCalls}));})().catch(error=>{console.error(error);process.exitCode=1;});
