const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto'),ts=require('typescript');
const source=fs.readFileSync(require('node:path').join(process.argv[2],'lib/priceAlertMessengers.ts'),'utf8');
const hash=crypto.createHash('sha256').update(source).digest('hex');
const expected=JSON.parse(fs.readFileSync(process.argv[3],'utf8')).source_sha256['lib/priceAlertMessengers.ts'];
if(hash!==expected)throw Error('source changed');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
async function run(label,permit,accept){
 const calls=[],box={exports:{}};class RecordsError extends Error{}
 const settings={qqAppId:'12345678',qqAppSecret:'synthetic-only',qqEnabled:true};
 const ctx=vm.createContext({exports:box.exports,module:box,Buffer,AbortSignal,
 require(name){if(name==='node:crypto')return crypto;if(name==='./settings')return{getSiteSettings:()=>settings};if(name==='./secretStorage')return{hmacWithDataKey:v=>'fixture:'+v};if(name==='./socialChannels')return{qqReady:()=>true,feishuReady:()=>false,discordReady:()=>false};if(name==='./recordsContract')return{RecordsError};if(name==='./rateLimit')return{rateLimit:()=>true};throw Error('forbidden import '+name);},
 async fetch(url,options){const u=new URL(url);const payload=JSON.parse(options.body);calls.push({host:u.hostname,path:u.pathname,method:options.method,fields:Object.keys(payload).sort(),headerNames:Object.keys(options.headers).map(x=>x.toLowerCase()).sort(),appId:payload.appId||options.headers['X-Union-Appid']||null,authorizationScheme:(options.headers.Authorization||'').split(' ')[0],contentUtf16Units:typeof payload.content==='string'?payload.content.length:null,contentUtf16Sha:typeof payload.content==='string'?crypto.createHash('sha256').update(Buffer.from(payload.content,'utf16le')).digest('hex'):null,msg_type:payload.msg_type??null});if(u.hostname==='bots.qq.com')return new Response(JSON.stringify({access_token:'synthetic-access',expires_in:3600}),{status:200});if(u.hostname==='api.sgroup.qq.com')return new Response(JSON.stringify(accept?{id:'synthetic-receipt'}:{code:40001}),{status:200});throw Error('unapproved synthetic URL');}});
 new vm.Script(compiled).runInContext(ctx,{timeout:1000});let accepted=false,error=null;
 try{await box.exports.sendMessenger('qq','a'.repeat(20),'a'.repeat(1799)+'🙂x',()=>permit);accepted=true;}catch(e){error=e.constructor.name;}
 return{label,accepted,error,calls};
}
(async()=>{const results=[await run('explicit native action accepted',true,true),await run('authorization revoked after token',false,true),await run('provider rejects send',true,false)];if(!results[0].accepted||results[0].calls.length!==2||results[1].accepted||results[1].calls.length!==1||results[2].accepted)throw Error('vector failed');process.stdout.write(JSON.stringify({source_sha256:hash,results,real_network:false}));})().catch(e=>{process.stderr.write(String(e));process.exit(1)});
