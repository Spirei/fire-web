const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const path=require('node:path');
function load(file){
 const context={exports:{},URLSearchParams,require:id=>load(path.resolve(path.dirname(file),id+'.ts'))};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
 return context.exports;
}
const bootstrap=load(path.resolve('lib/workspaceBootstrap.ts')).workspaceBootstrap;
const identity={user:{id:'owner-one',role:'admin'},csrf:'synthetic',instance_id:'synthetic'};
(async()=>{
 const calls=[],read=async path=>{calls.push(path);return {assets:[],items:[],total:0,page:1,revision:'1',marketCounts:{}};};
 const materials=await bootstrap('library',new URLSearchParams('tab=stock&market=HK&q=a%26b&page=2'),identity,read);
 assert.equal(materials.material.key,'owner-one|stock|HK|a&b|2|false');
 assert.equal(calls.length,1);const query=new URLSearchParams(calls[0].split('?')[1]);assert.equal(query.get('q'),'a&b');assert.equal(query.get('page'),'2');
 calls.length=0;await bootstrap('library',new URLSearchParams(),{...identity,user:{id:'reader',role:'user'}},read);assert.equal(calls.length,0,'Non-admin never gets material administration bootstrap');
 calls.length=0;await bootstrap('settings',new URLSearchParams('sub=palette'),identity,read);assert.equal(calls.length,0,'Appearance must not wait for records, funds or unrelated pages');
 const pending=[],gate=path=>new Promise(resolve=>pending.push({path,resolve}));
 const system=bootstrap('system-overview',new URLSearchParams(),identity,gate);
 assert.equal(pending.length,2,'Overview and tasks start in parallel');assert(!pending.some(p=>p.path.includes('session')),'Already-authenticated server session is reused within this request');
 pending.forEach(p=>p.resolve(p.path.includes('tasks')?{items:[],next_cursor:null}:{services:[],task_counts:{}}));
 const result=await system;assert.equal(result.system.identity.user.id,'owner-one');assert.equal(result.system.tasks.items.length,0);
 calls.length=0;await bootstrap('cards',new URLSearchParams(),identity,read);assert.deepEqual(calls,['/api/cards']);
 calls.length=0;const backup=await bootstrap('backup-recovery',new URLSearchParams('tab=migration'),identity,read);assert.equal(backup.backupRecovery.identity.user.id,'owner-one');assert.deepEqual(calls,['/api/fire/database-migration/connections','/api/fire/backups','/api/fire/database-migration/preparations']);
 calls.length=0;await bootstrap('backup-recovery',new URLSearchParams(),{...identity,user:{id:'reader',role:'user'}},read);assert.equal(calls.length,0,'Migration configuration is never bootstrapped for ordinary members');
 calls.length=0;
 const fx=await bootstrap('global',new URLSearchParams('section=convert'),identity,async path=>{calls.push(path);return path==='/api/rates'?{base:'USD',rates:{USD:1},quoted:[],updatedAt:null}:{assets:[{code:'EU',imageUrl:'/api/assets/images/custom-eu'}]};},{'fire:fx-order':['EUR','USD','CHF'],'fire:fx-hidden':['CHF']});
 assert.equal(calls.filter(path=>path.startsWith('/api/assets')).length,1,'All visible flags are read in one batch');
 const flags=new URLSearchParams(calls.find(path=>path.startsWith('/api/assets')).split('?')[1]).get('keys').split(',');
 assert(flags.includes('EU')&&flags.includes('US')&&!flags.includes('CH'));
 assert.equal(fx.global.flagIcons.EU,'/api/assets/images/custom-eu');
 assert.equal(fx.global.fx.data.rates.USD,1);assert.equal(fx.global.fx.data.quoted.length,0,'Missing rates remain missing in server bootstrap');assert(fx.global.fx.checkedAt>0);
 console.log('PASS refresh bootstrap reads only the current page, preserves URL filters and ownership, and avoids a second client session waterfall');
})().catch(error=>{console.error(error);process.exitCode=1;});
