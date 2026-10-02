// Native news-feed contracts exercise real handlers and a disposable database.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-app-feed-'));process.chdir(temp);
process.env.STOCKLOG_FUTU='off';process.env.STOCKLOG_PROXY='off';process.env.FIRE_APP_ORIGIN='https://feed.example.test:18520';
global.fetch=async()=>{throw Error('External network disabled');};require('node:dns/promises').lookup=async()=>{throw Error('External DNS disabled');};
const load=file=>require(path.join(root,file)),next=load('node_modules/next/server.js');next.after=()=>{};
const auth=load('lib/auth.ts'),native=load('lib/appAuth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/feedStore.ts'),subscriptions=load('lib/feedSubscriptions.ts'),bodies=load('lib/requestBody.ts');
const routes=[null,load('app/api/v1/feed/[[...action]]/route.ts'),load('app/api/v2/feed/[[...action]]/route.ts')],origin=process.env.FIRE_APP_ORIGIN;
const password='Feed-native-test-123',full='portfolio.read feed.read feed.write';let serial=0,count=0;
const grant=(user,scope=full)=>db.transaction(()=>native.createNativeAppGrant(user.id,scope,'Test iPhone')).immediate();
const fixture=()=>{const user=auth.createUser('feed_app_'+(++serial),password),other=auth.createUser('feed_other_'+serial,password);return {user,other,grant:grant(user),otherGrant:grant(other)};};
async function call(v,action='',method='GET',body,token,extra={}) {
 const request=new Request(origin+`/api/v${v}/feed`+(action?(action.startsWith('?')?'':'/')+action:''),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const response=await routes[v][method](request,{params:Promise.resolve({action:action.split('?')[0].split('/').filter(Boolean)})});
 return {status:response.status,headers:response.headers,...await response.json()};
}
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();count++;console.log('PASS '+name);}
(async()=>{
 await test('discovery freezes same-version group and subscription paths without enlarging login scope',async()=>{
  for(const v of [1,2]) {
   const result=await(await load(`app/api/v${v}/auth/config/route.ts`).GET(new Request(origin+`/api/v${v}/auth/config`))).json();
   assert.deepEqual(result.data.feed_contract,{version:1,groups_path:`/api/v${v}/feed/groups`,subscriptions_test_path:`/api/v${v}/feed/subscriptions/test`});
   assert.equal(result.data.scope,'portfolio.read portfolio.write');assert.deepEqual(result.data.feed_scopes,['feed.read','feed.write']);
  }
 });
 await test('both versions return 403 for missing optional scopes and never supplement an App grant with Cookies',async()=>{
  const f=fixture(),base=grant(f.user,native.APP_SCOPE),read=grant(f.user,'portfolio.read feed.read'),cookie=auth.createSession(f.user.id);
  for(const v of [1,2]) {
   for(const [action,method,body,token] of [['groups','GET',undefined,base.access_token],['groups','POST',{name:'Denied'},read.access_token],['groups/default','PUT',{name:'Denied',revision:0},read.access_token],['subscriptions/test','POST',{name:'Public',url:'https://news.example/rss'},read.access_token]]) {
    const result=await call(v,action,method,body,token,{cookie:'fire_session='+cookie});assert.equal(result.status,403);assert.equal(result.code,40301);
   }
   assert.equal((await call(v,'groups','GET',undefined,'fat_'+'a'.repeat(43),{cookie:'fire_session='+cookie})).status,401);
   assert.equal((await call(v,'groups','GET',undefined,read.access_token)).status,200);
  }
  for(const headers of [{cookie:'fire_session='+cookie},{authorization:'Bearer '+cookie}])assert.equal((await call(2,'groups','GET',undefined,undefined,headers)).status,401);
  assert.equal(native.authenticateAppAccess(base.access_token,new Request(origin+'/api/v2/auth/me')).scope,native.APP_SCOPE);
  assert.equal(store.listFeedGroups(f.user.id).length,1);
 });
 await test('explicit native upgrade keeps the old connection and grants the same identity access on either selected version',async()=>{
  const f=fixture(),old=grant(f.user,native.APP_SCOPE),permissions=load('app/api/v2/auth/permissions/route.ts');
  const upgrade=async(scope,currentPassword)=>{const response=await permissions.POST(new Request(origin+'/api/v2/auth/permissions',{method:'POST',headers:{authorization:'Bearer '+old.access_token,'content-type':'application/json'},body:JSON.stringify({client_id:'fire-ios',scope,currentPassword})}));return {status:response.status,...await response.json()};};
  assert.equal((await upgrade('feed.read feed.write','wrong')).code,40103);
  assert.equal((await upgrade('feed.write',password)).status,403);
  assert.equal((await call(1,'groups','GET',undefined,old.access_token)).status,403);
  const result=await upgrade('feed.read feed.write',password);assert.equal(result.status,200);assert.equal(result.data.apiVersion,2);assert.equal(result.data.replaces_grant_id,old.grant_id);
  assert.equal(result.data.user.id,f.user.id);assert.equal(result.data.user.capabilities.feedRead,true);assert.equal(result.data.user.capabilities.feedWrite,true);
  assert.equal(native.authenticateAppAccess(old.access_token,new Request(origin+'/api/v2/auth/me')).scope,native.APP_SCOPE);
  for(const v of [1,2])assert.equal((await call(v,'groups','GET',undefined,result.data.access_token)).status,200);
  native.revokeAppGrant(old.grant_id);
  assert.equal((await call(1,'groups','GET',undefined,result.data.access_token)).status,200);
 });
 await test('news groups and rename preserve disabled scheduling, subscriptions and CAS across versions',async()=>{
  for(const v of [1,2]) {
   const f=fixture(),token=f.grant.access_token,created=await call(v,'groups','POST',{name:'News',mode:'news'},token);assert.equal(created.status,200);
   const id=created.data.id;assert.match(id,/^fg-[a-f0-9]{24}$/);assert.equal(created.data.mode,'news');
   const saved=await call(v,'preferences?group='+id,'PUT',{instructions:'Verified news',revision:0,enabled:false,intervalMinutes:120,subscriptions:[{name:'Public',url:'https://news.example/rss'}]},token);assert.equal(saved.status,200);
   const renamed=await call(v,'groups/'+id,'PUT',{name:'My News',revision:saved.data.revision},token);assert.equal(renamed.status,200);assert.equal(renamed.data.name,'My News');
   const pref=store.feedPreferences(f.user.id,id);assert.equal(pref.enabled,false);assert.equal(pref.intervalMinutes,120);assert.equal(pref.instructions,'Verified news');assert.equal(renamed.data.subscriptions.length,1);
   assert.equal((await call(v,'groups/'+id,'PUT',{name:'Stale',revision:saved.data.revision},token)).status,409);
   assert.equal((await call(v,'groups/'+id,'PUT',{name:'Other',revision:pref.revision},f.otherGrant.access_token)).status,404);
   assert.equal((await call(v,'groups','GET',undefined,f.otherGrant.access_token)).data.groups.some(g=>g.id===id),false);
   assert.equal((await call(v,'groups','POST',{name:'Injection',userId:f.other.id},token)).status,400);
   assert.equal((await call(v,'groups/default','PUT',{name:'Default News',revision:0},token)).status,200);
  }
 });
 await test('one news group provides cursor pages, sources, media, likes, hiding and owner-only discussions',async()=>{
  const f=fixture(),group=store.createFeedGroup(f.user.id,{name:'News',mode:'news'});
  store.saveFeedPreferences(f.user.id,{instructions:'Verified news',revision:0,enabled:false},group.id);
  for(let i=0;i<11;i++) {
   const source={id:'s'+i,title:'Verified event '+i,url:'https://news.example/story/'+i,publisher:'Example',publishedAt:null,excerpt:'Known source details',media:i===0?[{type:'image',url:'https://news.example/image.jpg',alt:'Verified media'}]:[]};
   store.appendFeedPosts(f.user.id,store.normalizeGeneratedPosts([{title:'Event '+i,icon:'world',segments:[{text:'Verified event with enough contextual details and a limited linked phrase.',sourceId:source.id,linkText:'event'}]}],[source]),group.id);
  }
  let id;
  for(const v of [1,2]) {
   const first=await call(v,'?group='+group.id,'GET',undefined,f.grant.access_token);assert.equal(first.status,200);assert.equal(first.data.posts.length,10);assert(first.data.nextCursor);assert.equal(first.data.group.mode,'news');
   const last=await call(v,'?group='+group.id+'&cursor='+encodeURIComponent(first.data.nextCursor),'GET',undefined,f.grant.access_token);assert.equal(last.data.posts.length,1);assert.equal(last.data.nextCursor,null);
   const all=[...first.data.posts,...last.data.posts];assert.equal(new Set(all.map(p=>p.id)).size,11);assert(all.every(p=>p.publishedAt===null&&p.sources.length===1&&!p.original));assert(all.some(p=>p.media.length===1));
   id=all[0].id;assert.equal((await call(v,'posts/'+id,'PUT',{liked:true},f.grant.access_token)).data.liked,true);
   assert.equal((await call(v,'posts/'+id,'GET',undefined,f.otherGrant.access_token)).status,404);
   assert.equal((await call(v,'posts/'+id+'/discussion','GET',undefined,f.otherGrant.access_token)).status,404);
   assert.deepEqual((await call(v,'posts/'+id+'/discussion','GET',undefined,f.grant.access_token)).data.messages,[]);
  }
  await call(2,'posts/'+id,'PUT',{hidden:true},f.grant.access_token);
  assert.equal((await call(1,'?group='+group.id,'GET',undefined,f.grant.access_token)).data.posts.some(p=>p.id===id),false);
  assert.equal((await call(1,'posts/'+id,'GET',undefined,f.grant.access_token)).data.hidden,true);
  await call(1,'posts/'+id,'PUT',{hidden:false,liked:false},f.grant.access_token);
  assert.equal((await call(2,'posts/'+id,'GET',undefined,f.grant.access_token)).data.hidden,false);
 });
 await test('subscription tests validate public input and report results without saving account settings',async()=>{
  const read=subscriptions.readFeedSubscription;let calls=0;
  subscriptions.readFeedSubscription=async source=>{calls++;return {title:'Example feed',sources:[{url:source.url}]};};
  try {
   for(const v of [1,2]) {
    const f=fixture();
    const before=JSON.stringify(store.listFeedGroups(f.user.id));
    const result=await call(v,'subscriptions/test','POST',{name:'Public',url:'https://news.example/rss'},f.grant.access_token);
    assert.equal(result.status,200);assert.deepEqual(result.data,{title:'Example feed',count:1,url:'https://news.example/rss'});
    for(const body of [{name:'Private',url:'https://127.0.0.1/feed'},{name:'Private',url:'https://news.example/feed?token=secret'},{name:'Public',url:'https://news.example/rss',userId:f.other.id}])assert.equal((await call(v,'subscriptions/test','POST',body,f.grant.access_token)).status,400);
    assert.equal(JSON.stringify(store.listFeedGroups(f.user.id)),before);
   }
   assert.equal(calls,2);
  }finally{subscriptions.readFeedSubscription=read;}
 });
 await test('revocation during input cannot create a group; unknown paths remain ungranted',async()=>{
  const policy=load('lib/appApiV2Policy.ts');
  for(const v of [1,2]) {
   const f=fixture(),read=bodies.readJsonBody,cookie=auth.createSession(f.user.id);
   bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(f.grant.grant_id);return body;};
   try{assert.equal((await call(v,'groups','POST',{name:'Revoked'},f.grant.access_token,{cookie:'fire_session='+cookie})).status,401);}finally{bodies.readJsonBody=read;}
   assert.equal(store.listFeedGroups(f.user.id).length,1);
  }
  for(const [path,method] of [['feed/groups/bad','PUT'],['feed/groups/default','GET'],['feed/groups/default','DELETE'],['feed/subscriptions/test','GET'],['feed/groups','DELETE']])assert.equal(policy.appV2Access('/api/v2/'+path,method),null);
 });
 console.log(`${count} native news feed suites passed (isolated users, database and network)`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});});
