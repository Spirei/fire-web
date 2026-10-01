// Real handlers, disposable SQLite. No requests or fixtures touch the running site.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root,id.slice(2)) : id,parent,...rest); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'alcor-feed-')); process.chdir(temp);
process.env.STOCKLOG_FUTU='off'; process.env.STOCKLOG_PROXY='off'; process.env.FIRE_APP_ORIGIN='https://feed.test.example';
global.fetch=async()=>{throw new Error('External network disabled');};
const load=file=>require(path.join(root,file)), origin=process.env.FIRE_APP_ORIGIN;
const auth=load('lib/auth.ts'), native=load('lib/appAuth.ts'), db=load('lib/db.ts').getDb();
const store=load('lib/feedStore.ts'), generation=load('lib/feedGeneration.ts'), route=load('app/api/v1/feed/[[...action]]/route.ts');
const user=auth.createUser('feed_owner','Feed-test-123'), other=auth.createUser('feed_other','Feed-test-123');
const browser=auth.createSession(user.id);
global.fetch=async()=>{throw new Error('External network disabled');};
const req=(action='',method='GET',body,token)=>new Request(origin+'/api/v1/feed'+(action?'/'+action:''),{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{cookie:'fire_session='+browser,origin})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const call=(action='',method='GET',body,token)=>route[method](req(action,method,body,token),{params:Promise.resolve({action:action.split('?')[0].split('/').filter(Boolean)})});
function connect(scope=native.APP_SCOPE) {
  const verifier=crypto.randomBytes(32).toString('base64url');
  const values={client_id:native.APP_CLIENT_ID,redirect_uri:native.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
  const code=native.issueAppCode(native.parseAppAuthorization(values),user.id,browser);
  return native.exchangeAppCode({...values,code,code_verifier:verifier});
}
const source={id:'s1',title:'Example verified update',url:'https://news.example/story',publisher:'Example',publishedAt:'2026-09-30T12:00:00.000Z',excerpt:'Verified headline only.'};
const normalized=()=>store.normalizeGeneratedPosts([{title:'测试动态',icon:'market',segments:[{text:'已核实的摘要',sourceId:'s1'}]}],[source]);
let count=0;
async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();console.log('PASS '+name);count++;}
(async()=>{
  await test('empty SSR/API snapshot is private, owner-only and contains no invented news',async()=>{
    const response=await call(); assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
    const data=(await response.json()).data;assert.deepEqual(data.posts,[]);assert.equal(data.preferences.revision,0);assert.equal(data.capabilities.search,'news-rss');assert.equal(data.capabilities.avatar.video,null);
    assert.equal((await route.GET(new Request(origin+'/api/v1/feed'),{params:Promise.resolve({})})).status,401);
  });
  await test('preferences persist by account, compare revisions and reject arbitrary fields',async()=>{
    assert.equal((await call('preferences','PUT',{instructions:'关注公开科技新闻',revision:0,enabled:true})).status,200);
    assert.equal(store.feedPreferences(user.id).instructions,'关注公开科技新闻');assert.equal(store.feedPreferences(other.id).instructions,'');
    assert.equal((await call('preferences','PUT',{instructions:'stale',revision:0})).status,409);
    for(const body of [{instructions:'x'.repeat(4001),revision:1},{instructions:'x',revision:1,userId:other.id},{instructions:'x',revision:1,intervalMinutes:1},[],{}])assert.equal((await call('preferences','PUT',body)).status,400);
    assert.equal(store.feedPreferences(user.id).revision,1);
  });
  await test('mascot capability uses real local media and Docker fallback, never invents a video URL',()=>{
    const folder=path.join(temp,'resource-default/feature/feed');fs.mkdirSync(folder,{recursive:true});
    const target=path.join(folder,'alcor-idle.mp4');fs.copyFileSync(path.join(root,'public/uploads/feature/feed/alcor-idle.mp4'),target);
    assert.equal(generation.feedCapabilities().avatar.video,'/uploads/feature/feed/alcor-idle.mp4');
    fs.unlinkSync(target);assert.equal(generation.feedCapabilities().avatar.video,null);
  });
  let post;
  await test('sources/citations are bounded, no model-created URL/date/media can enter a post',()=>{
    for(const url of ['javascript:alert(1)','http://news.example','https://127.0.0.1','https://10.0.0.1','https://192.168.1.1','https://[::1]','https://user:password@news.example','https://local.lan'])assert.equal(store.sourceUrl(url),null);
    assert.equal(store.sourceUrl('https://news.example/story?utm_source=x#tracking'),'https://news.example/story');
    assert.deepEqual(store.normalizeGeneratedPosts([{title:'not sourced',segments:[{text:'bad',sourceId:'invented'}]}],[source]),[]);
    const items=store.normalizeGeneratedPosts([{title:'测试',icon:'not-real',publishedAt:'2099-01-01',media:[{url:'http://evil.example'}],segments:[{text:'核实',sourceId:'s1'}]}],[source]);
    assert.equal(items[0].icon,'note');assert.equal(items[0].publishedAt,source.publishedAt);assert.deepEqual(items[0].media,[]);
    assert.equal(store.appendFeedPosts(user.id,normalized()),1);assert.equal(store.appendFeedPosts(user.id,normalized()),0);
    post=store.listFeedPosts(user.id).posts[0];assert.throws(()=>store.getFeedPost(other.id,post.id),/不存在/);
  });
  await test('App scopes are optional, read/write are separate and old grants never expand',async()=>{
    const old=connect(),read=connect('portfolio.read feed.read'),write=connect('portfolio.read feed.read feed.write');
    assert.equal((await call('','GET',undefined,old.access_token)).status,401);
    assert.equal((await call('','GET',undefined,read.access_token)).status,200);
    assert.equal((await call('preferences','PUT',{instructions:'bad',revision:1},read.access_token)).status,401);
    assert.equal((await call('posts/'+post.id,'PUT',{liked:true},write.access_token)).status,200);
    assert.equal(store.getFeedPost(user.id,post.id).liked,true);
    assert.equal(native.refreshAppTokens(native.APP_CLIENT_ID,old.refresh_token).scope,native.APP_SCOPE);
    assert.equal(auth.getAuthUser(new Request(origin+'/api/settings',{headers:{authorization:'Bearer '+write.access_token}})),null);
    assert.throws(()=>native.parseAppAuthorization({client_id:native.APP_CLIENT_ID,redirect_uri:native.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:'x'.repeat(43),state:'x'.repeat(32),scope:'portfolio.read feed.write'}));
  });
  await test('likes/hiding are reversible and cannot edit content or another account',async()=>{
    assert.equal((await call('posts/'+post.id,'PUT',{hidden:true})).status,200);assert.equal(store.listFeedPosts(user.id).posts.length,0);
    assert.equal((await call('posts/'+post.id,'PUT',{hidden:false})).status,200);assert.equal(store.listFeedPosts(user.id).posts.length,1);
    assert.equal((await call('posts/'+post.id,'PUT',{title:'injected'})).status,400);
    assert.throws(()=>store.updateFeedPost(other.id,post.id,{liked:true}),/不存在/);
  });
  await test('keyset pagination is stable, bounded and never crosses owners',async()=>{
    for(let i=0;i<25;i++)store.appendFeedPosts(user.id,store.normalizeGeneratedPosts([{title:'item '+i,segments:[{text:'summary',sourceId:'s1'}]}],[{...source,url:'https://news.example/item-'+i}]));
    const first=store.listFeedPosts(user.id,null,10),second=store.listFeedPosts(user.id,first.nextCursor,10);
    assert.equal(new Set([...first.posts,...second.posts].map(p=>p.id)).size,20);assert.deepEqual(store.listFeedPosts(other.id,first.nextCursor).posts,[]);
    assert.throws(()=>store.listFeedPosts(user.id,'x'.repeat(300)),/游标/);
    assert.equal((await call('?limit=51')).status,400);assert.equal((await call('?limit=1.5')).status,400);
  });
  await test('XML is parsed without external entities and dates/links are source-owned',()=>{
    const rows=generation.parseNewsRss('<rss><channel><item><title>Example &amp; headline</title><link>https://news.example/test</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate><source>Example</source><description><![CDATA[<a>text</a>]]></description></item></channel></rss>');
    assert.equal(rows[0].title,'Example & headline');assert.equal(rows[0].excerpt,'text');assert.equal(rows[0].publishedAt,source.publishedAt);
    assert.throws(()=>generation.parseNewsRss('<!DOCTYPE rss SYSTEM "file:///private"><rss/>'),/格式/);
  });
  await test('search has fixed endpoints, strict budgets and does not transmit credential-like queries',async()=>{
    let requests=[];global.fetch=async(url,init)=>{requests.push([String(url),init]);return new Response('<rss><channel><item><title>Test</title><link>https://news.example/article</link></item></channel></rss>');};
    assert.deepEqual(await generation.searchFeedSources(['secret@example.test','https://private.example','密码:secret']),[]);assert.equal(requests.length,0);
    assert.equal((await generation.searchFeedSources(['technology'])).length,1);assert.equal(new URL(requests[0][0]).hostname,'news.google.com');assert.equal(requests[0][1].redirect,'error');
    global.fetch=async()=>new Response('x'.repeat(1_500_001));assert.deepEqual(await generation.searchFeedSources(['technology']),[]);
  });
  const settings=load('lib/settings.ts');
  settings.updateSiteSettings({modelServices:[{id:'test-model',provider:'custom',name:'Isolated',apiUrl:'https://model.example/v1/chat/completions',apiKey:'isolated-test-key',models:['test-model']}]});
  await test('one persisted task per account, changing instructions invalidates old jobs',()=>{
    const first=store.createFeedJob(user.id),again=store.createFeedJob(user.id);assert.equal(first.job.id,again.job.id);assert.equal(again.created,false);
    store.saveFeedPreferences(user.id,{instructions:'new public topic',revision:1});assert.equal(store.getFeedJob(user.id,first.job.id).status,'error');
    const next=store.createFeedJob(user.id);assert.notEqual(next.job.id,first.job.id);assert.equal(next.job.revision,2);
    db.prepare("UPDATE feed_jobs SET status='error' WHERE user_id=?").run(user.id);
  });
  await test('generation uses actual fetched source IDs, stores history and finishes persisted jobs',async()=>{
    let models=0;global.fetch=async(url,init)=>{
      if(String(url).startsWith('https://news.google.com/'))return new Response('<rss><channel><item><title>Verified</title><link>https://news.example/generated</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>');
      assert.equal(new URL(url).hostname,'model.example');models++;
      return Response.json({choices:[{message:{content:JSON.stringify(models===1?{queries:['technology']}:{posts:[{title:'Verified generated',icon:'technology',segments:[{text:'Verified',sourceId:'s1'}]}]})}}]});
    };
    const {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);
    assert.equal(store.getFeedJob(user.id,job.id).status,'done');assert.equal(store.getFeedJob(user.id,job.id).added,1);assert.equal(models,2);
    const after=store.listFeedPosts(user.id,null,50);assert(after.posts.some(p=>p.title==='Verified generated'));assert(after.posts.some(p=>p.id===post.id));
    await generation.runFeedJob(user.id,job.id);assert.equal(models,2,'finished jobs cannot replay');
  });
  await test('provider failure and revision races preserve history, never insert fake fallback posts',async()=>{
    const before=store.listFeedPosts(user.id,null,50).posts.length;global.fetch=async()=>{throw new Error('private provider diagnostic');};
    const {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);assert.equal(store.getFeedJob(user.id,job.id).status,'error');assert(!store.getFeedJob(user.id,job.id).error.includes('private'));
    assert.equal(store.listFeedPosts(user.id,null,50).posts.length,before);
  });
  await test('discussion is post/account isolated and revocation after upstream work cannot save',async()=>{
    global.fetch=async()=>Response.json({choices:[{message:{content:'这是已核实来源支持的解释。'}}]});
    const turns=await generation.discussFeed(user.id,post.id,'解释一下');assert.equal(turns.length,2);assert.equal(turns[0].role,'user');assert.equal(turns[1].role,'assistant');
    assert.throws(()=>store.feedMessages(other.id,post.id),/不存在/);
    await assert.rejects(()=>generation.discussFeed(user.id,post.id,'not saved',undefined,()=>false),/失效/);assert.equal(store.feedMessages(user.id,post.id).length,2);
    const grant=connect('portfolio.read feed.read feed.write');global.fetch=async()=>{native.revokeAppGrant(grant.grant_id);return Response.json({choices:[{message:{content:'not saved'}}]});};
    assert.equal((await call('posts/'+post.id+'/discussion','POST',{text:'not saved'},grant.access_token)).status,401);assert.equal(store.feedMessages(user.id,post.id).length,2);
  });
  await test('mutation guards reject CSRF, oversized content and revoked token after input',async()=>{
    const context={params:Promise.resolve({action:['preferences']})};
    assert([401,403].includes((await route.PUT(new Request(origin+'/api/v1/feed/preferences',{method:'PUT',headers:{cookie:'fire_session='+browser,origin:'https://evil.example','content-type':'application/json'},body:JSON.stringify({instructions:'bad',revision:2})}),context)).status));
    assert.equal((await call('preferences','PUT',{instructions:'x'.repeat(21000),revision:2})).status,413);
    const grant=connect('portfolio.read feed.read feed.write'),bodies=load('lib/requestBody.ts'),read=bodies.readJsonBody;
    bodies.readJsonBody=async(...args)=>{const body=await read(...args);native.revokeAppGrant(grant.grant_id);return body;};
    try{assert.equal((await call('preferences','PUT',{instructions:'bad',revision:2},grant.access_token)).status,401);}finally{bodies.readJsonBody=read;}
    assert.equal(store.feedPreferences(user.id).instructions,'new public topic');
  });
  await test('stale jobs recover, task admission is bounded across accounts',()=>{
    const {job}=store.createFeedJob(user.id);db.prepare('UPDATE feed_jobs SET updated_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',job.id);assert.equal(store.getFeedJob(user.id,job.id).status,'error');
    for(let i=0;i<8;i++){const u=auth.createUser('feed_budget_'+i,'Feed-test-123');store.saveFeedPreferences(u.id,{instructions:'public news',revision:0});store.createFeedJob(u.id);}
    assert.throws(()=>store.createFeedJob(user.id),/较多/);
  });
  console.log(`Feed review: ${count} groups passed; all mutations stayed in disposable SQLite.`);
})().finally(()=>{db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
