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
require('node:dns/promises').lookup=async()=>{throw new Error('External DNS disabled');};
const load=file=>require(path.join(root,file)), origin=process.env.FIRE_APP_ORIGIN;
const skillDir=path.join(temp,'lib/skills/alcor-feed-editor');fs.mkdirSync(skillDir,{recursive:true});fs.copyFileSync(path.join(root,'lib/skills/alcor-feed-editor/SKILL.md'),path.join(skillDir,'SKILL.md'));
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
    const highlighted=store.normalizeGeneratedPosts([{title:'有来源的正文',segments:[{text:'公司本季度营收增长10%，同时披露了未来业务风险，结果与预测应分开看。',sourceId:'s1',linkText:'营收增长10%'}]}],[source]);
    assert.equal(highlighted[0].segments[0].linkText,'营收增长10%');
    const whole=store.normalizeGeneratedPosts([{title:'整段不得跳转',segments:[{text:'整段不能成为链接。',sourceId:'s1',linkText:'整段不能成为链接。'}]}],[source]);
    assert.equal(whole[0].segments[0].linkText,undefined);assert.equal(whole[0].sources.length,1);
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
    assert.equal(store.listFeedPosts(user.id).posts.length,10);assert.equal(generation.feedSnapshot(user.id).posts.length,10);
    assert.equal((await (await call()).json()).data.posts.length,10);
    const first=store.listFeedPosts(user.id,null,10),second=store.listFeedPosts(user.id,first.nextCursor,10);
    assert.equal(new Set([...first.posts,...second.posts].map(p=>p.id)).size,20);assert.deepEqual(store.listFeedPosts(other.id,first.nextCursor).posts,[]);
    assert.throws(()=>store.listFeedPosts(user.id,'x'.repeat(300)),/游标/);
    assert.equal((await call('?limit=51')).status,400);assert.equal((await call('?limit=1.5')).status,400);
  });
  await test('XML is parsed without external entities and dates/links are source-owned',()=>{
    const rows=generation.parseNewsRss('<rss><channel><item><title>Example &amp; headline</title><link>https://news.example/test</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate><source>Example</source><description><![CDATA[<a>text</a>]]></description></item></channel></rss>');
    assert.equal(rows[0].title,'Example & headline');assert.equal(rows[0].excerpt,'text');assert.equal(rows[0].publishedAt,source.publishedAt);
    assert.throws(()=>generation.parseNewsRss('<!DOCTYPE rss SYSTEM "file:///private"><rss/>'),/格式/);
    assert.throws(()=>generation.parseNewsRss('<html><body>gateway failure</body></html>'),/格式/);
    assert.throws(()=>generation.parseNewsRss('<rss><item></rss>'),/格式/);
  });
  await test('publisher-page evidence captures current report, declared date and real media, not model URLs',async()=>{
    const evidence=load('lib/feedEvidence.ts'),body='Current fiscal quarter revenue is 54.23 billion, compared with 41.46 billion last quarter. The next quarter guidance is separate from actual results. ';
    const html=`<meta content="2026-09-30T20:01:00Z" property="article:published_time"><article><script>ignore these fake numbers</script><p>${body}</p><img src="/photos/report.jpg" alt="Official &amp; report" width="800"><video poster="https://investors.micron.com/photos/report.jpg"><source src="/media/report.mp4"></video></article>`;
    const parsed=evidence.parsePrimaryFeedArticle(html,'https://investors.micron.com/report');assert.equal(parsed.publishedAt,'2026-09-30T20:01:00.000Z');assert(!parsed.excerpt.includes('fake numbers'));assert.equal(parsed.media[0].url,'https://investors.micron.com/photos/report.jpg');assert.equal(parsed.media[1].type,'video');
    assert.equal(evidence.parsePrimaryFeedArticle('<html>Please sign in or complete a challenge.</html>'),null);
    const unsafe=evidence.parsePrimaryFeedArticle(`<article>${body}<img src="https://127.0.0.1/private.png"><img src="/logo.png"><video src="javascript:evil()"></video></article>`,'https://investors.micron.com/report');assert.deepEqual(unsafe.media,[]);
    const before=global.fetch;global.fetch=async(url,init)=>{assert.equal(init.redirect,'error');assert(!init.headers.Authorization&&!init.headers.Cookie);return new Response(html,{headers:{'content-type':'text/html'}});};
    try{const rows=await evidence.enrichFeedEvidence([{...source,url:'https://investors.micron.com/report'}]);assert.equal(rows[0].evidence,'publisher-page');assert.equal(rows[0].media.length,2);const normalized=store.normalizeGeneratedPosts([{title:'Report',segments:[{text:'Verified',sourceId:'s1'}],media:[{url:'https://evil.example/invented.jpg'}]}],rows);assert.deepEqual(normalized[0].media,rows[0].media);}finally{global.fetch=before;}
    const drupal=evidence.parsePrimaryFeedArticle(`<article><div class="field--name-field-nir-news-date"><div class="field__item">September 30, 2026 at 4:01 PM EDT</div></div>${body}</article>`);assert.equal(drupal.publishedAt,'2026-09-30T20:01:00.000Z');
  });
  await test('custom RSS and Atom preserve articles, photos/video, source dates and reject XML attacks',()=>{
    const subscriptions=load('lib/feedSubscriptions.ts');
    const rss=subscriptions.parseSubscriptionFeed('<rss><channel><title>Official feed</title><item><title>Report</title><link>https://news.example/report</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Revenue rose and costs remain uncertain.</p>]]></description><enclosure url="https://news.example/report.jpg" type="image/jpeg"/><enclosure url="https://news.example/report.mp4" type="video/mp4"/></item></channel></rss>','https://news.example/rss');assert.equal(rss.title,'Official feed');assert.equal(rss.sources[0].media.length,2);assert.equal(rss.sources[0].publishedAt,source.publishedAt);
    const atom=subscriptions.parseSubscriptionFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Event</title><link rel="alternate" href="/story"/><published>2026-09-30T12:00:00Z</published><summary>Actual event details.</summary></entry></feed>','https://news.example/atom');assert.equal(atom.sources[0].url,'https://news.example/story');assert.equal(atom.sources[0].excerpt,'Actual event details.');
    for(const xml of ['<!DOCTYPE rss SYSTEM "file:///private"><rss/>','<html>not rss</html>','<rss><item></rss>'])assert.throws(()=>subscriptions.parseSubscriptionFeed(xml,'https://news.example/feed'));
    assert.throws(()=>subscriptions.normalizeFeedSubscriptions([{name:'Private',url:'https://news.example/feed?token=secret'}]));assert.throws(()=>subscriptions.normalizeFeedSubscriptions([{name:'Private',url:'https://127.0.0.1/feed'}]));assert.throws(()=>subscriptions.normalizeFeedSubscriptions(Array.from({length:9},(_,i)=>({name:'x',url:'https://news.example/'+i}))));
  });
  await test('public feed fetch pins DNS, checks each redirect and blocks private/mapped destinations',async()=>{
    const network=load('lib/feedPublicFetch.ts'),dns=require('node:dns/promises'),undici=require('undici'),lookup=dns.lookup,fetch=undici.fetch;
    for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.100.100.200','198.18.0.1','::1','::ffff:127.0.0.1','64:ff9b::7f00:1','fe80::1'])assert.throws(()=>network.publicFeedAddresses([{address,family:address.includes(':')?6:4}]));
    assert.equal(network.publicFeedAddresses([{address:'1.1.1.1',family:4}]).address,'1.1.1.1');let requests=0;
    dns.lookup=async()=>[{address:'1.1.1.1',family:4}];undici.fetch=async(url,init)=>{requests++;assert.equal(init.redirect,'manual');assert(!init.headers.Authorization&&!init.headers.Cookie);assert(init.dispatcher);return requests===1?new Response(null,{status:302,headers:{location:'https://other.example/rss'}}):new Response('<rss/>',{headers:{'content-type':'application/rss+xml'}});};
    try{assert.equal((await network.fetchPublicFeedDocument('https://news.example/rss')).url,'https://other.example/rss');assert.equal(requests,2);requests=0;undici.fetch=async()=>{requests++;return new Response(null,{status:302,headers:{location:'https://127.0.0.1/private'}});};await assert.rejects(()=>network.fetchPublicFeedDocument('https://news.example/rss'));assert.equal(requests,1);dns.lookup=async()=>[{address:'10.0.0.1',family:4}];requests=0;await assert.rejects(()=>network.fetchPublicFeedDocument('https://private.example/rss'));assert.equal(requests,0);}finally{dns.lookup=lookup;undici.fetch=fetch;}
  });
  await test('named groups isolate preferences/history, keep default API and preserve source ownership',async()=>{
    const created=await call('groups','POST',{name:'科技与财报'});assert.equal(created.status,200);const group=(await created.json()).data;
    assert.equal((await call('preferences?group='+group.id,'PUT',{instructions:'科技新闻',revision:0,name:'我的科技',subscriptions:[{name:'Public',url:'https://news.example/rss'}]})).status,200);
    assert.equal(store.feedGroup(user.id,group.id).name,'我的科技');assert.equal(store.feedGroup(user.id,group.id).subscriptions.length,1);assert.equal(store.feedPreferences(user.id,group.id).revision,1);assert.equal(store.feedPreferences(user.id).revision,1);
    assert.equal(store.appendFeedPosts(user.id,normalized(),group.id),1);assert.equal(store.appendFeedPosts(user.id,normalized(),group.id),0);assert.equal(store.listFeedPosts(user.id,null,20,group.id).posts.length,1);
    assert.throws(()=>store.feedGroup(other.id,group.id),/不存在/);assert.equal((await call('?group='+group.id)).status,200);assert.equal((await call('preferences?group='+group.id,'PUT',{instructions:'stale',revision:0})).status,409);
    const token=connect('portfolio.read feed.read');assert.equal((await call('groups','POST',{name:'No permission'},token.access_token)).status,401);
    const {job}=store.createFeedJob(user.id,group.id);assert.equal(job.groupId,group.id);assert.equal(store.getFeedJob(user.id,undefined,group.id).id,job.id);assert.throws(()=>store.createFeedJob(user.id),/另一动态组/);db.prepare("UPDATE feed_jobs SET status='error' WHERE id=?").run(job.id);
  });
  await test('search has fixed endpoints, strict budgets and does not transmit credential-like queries',async()=>{
    let requests=[];global.fetch=async(url,init)=>{requests.push([String(url),init]);return new Response('<rss><channel><item><title>Test</title><link>https://news.example/article</link></item></channel></rss>');};
    assert.deepEqual(await generation.searchFeedSources(['secret@example.test','https://private.example','密码:secret']),[]);assert.equal(requests.length,0);
    assert.equal((await generation.searchFeedSources(['technology'])).length,1);assert.equal(new URL(requests[0][0]).hostname,'news.google.com');assert.equal(requests[0][1].redirect,'error');
    global.fetch=async()=>new Response('x'.repeat(1_500_001));await assert.rejects(()=>generation.searchFeedSources(['technology']),e=>e.status===502&&e.diagnostics[0].provider==='news-rss'&&!e.message.includes('x'.repeat(20)));
  });
  const settings=load('lib/settings.ts');
  const search=load('lib/feedSearch.ts');
  await test('runtime skill and cross-month earnings hints drive independent company searches without invented results',async()=>{
    const skill=load('lib/feedSkill.ts'),folder=path.join(temp,'data/earnings-cache');fs.mkdirSync(folder,{recursive:true});
    const calendar=path.join(folder,'US:2026-09.json'),today=new Date('2026-10-01T08:00:00Z');
    fs.writeFileSync(calendar,JSON.stringify({at:today.getTime()-86400_000,items:[{symbol:'MU',name:'Micron Technology',date:'2026-09-30',time:'time-after-hours',marketCap:100_000_000_000},{symbol:'FAKE',name:'Old',date:'2026-09-20',marketCap:999_000_000_000},{symbol:'SMALL',name:'Small',date:'2026-09-30',marketCap:10},{symbol:'NEXT',name:'Future',date:'2026-10-02',marketCap:999_000_000_000}]}));
    assert.deepEqual(skill.feedEventHints('美股大事件与公司财报',today).map(s=>s.symbol),['MU']);assert.deepEqual(skill.feedEventHints('欧洲天气',today),[]);
    assert(skill.feedSkill('Edit').includes('linkText'));assert(!skill.feedSkill('Plan').includes('"posts"'));
    let calls=[];settings.updateSiteSettings({modelServices:[{id:'skill-native',provider:'deepseek',name:'Native',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'isolated-native-key',models:['deepseek-flash']}]});
    store.saveFeedPreferences(other.id,{revision:0,instructions:'美股公司财报'});
    // Relative date keeps the scheduled company inside the runtime's own window.
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const nowCalendar=path.join(folder,'US:'+day.slice(0,7)+'.json');fs.writeFileSync(nowCalendar,JSON.stringify({at:Date.now(),items:[{symbol:'MU',name:'Micron Technology',date:day,time:'time-after-hours',marketCap:100_000_000_000}]}));
    global.fetch=async(url,init)=>{
      const u=new URL(url),body=init?.body?JSON.parse(init.body):null;
      if(u.hostname==='news.google.com')return new Response('<rss><channel/></rss>');
      calls.push(body);assert.equal(u.hostname,'api.deepseek.com');
      if(u.pathname==='/anthropic/v1/messages') {assert(body.system.includes('2–4'));assert.equal(body.tools[0].max_uses,1);return Response.json({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:source.url,title:source.title,page_age:source.publishedAt}]},{type:'text',citations:[{url:source.url,cited_text:'Revenue rose 10%.'},{url:source.url,cited_text:'Costs remain uncertain.'}]}]});}
      assert.deepEqual(body.thinking,{type:'disabled'});
      const planning=body.messages[0].content.includes('"queries"');
      return Response.json({choices:[{message:{content:JSON.stringify(planning?{queries:['US stock earnings']}:{posts:[{title:'公司发布业绩',segments:[{text:'公司公布业绩，营收增长10%，与此同时成本仍有不确定性，实际结果与未来预测需要区分。',sourceId:'s1',linkText:'营收增长10%'}]}]})}}]});
    };
    const {job}=generation.requestFeedGeneration(other.id);await generation.runFeedJob(other.id,job.id);
    assert.equal(store.getFeedJob(other.id,job.id).status,'done');const saved=store.listFeedPosts(other.id).posts[0];assert(saved.segments[0].linkText);assert.equal(saved.sources[0].excerpt,'Revenue rose 10%. Costs remain uncertain.');assert.equal(calls.length,5);assert(calls.some(b=>b.tools&&b.messages[0].content[0].text.includes('Micron Technology MU')&&b.messages[0].content[0].text.includes('results investor relations')));
    fs.unlinkSync(nowCalendar);if(nowCalendar!==calendar)fs.unlinkSync(calendar);
  });
  await test('native DeepSeek search trusts retrieval blocks, not generated prose or private/future links',()=>{
    const blocks={content:[{type:'text',text:'Invented https://evil.example/date',citations:[{url:source.url+'?utm_source=tracking',cited_text:'Verified <b>excerpt</b>'}]},{type:'web_search_tool_result',content:[{type:'web_search_result',url:source.url,title:source.title,page_age:source.publishedAt},{type:'web_search_result',url:source.url,title:'duplicate'},{type:'web_search_result',url:'https://127.0.0.1/private',title:'private'},{type:'web_search_result',url:'https://news.example/future',title:'Future',page_age:'2099-01-01'}]}]};
    const rows=search.parseDeepSeekSearch(blocks);assert.equal(rows.length,2);assert.equal(rows[0].excerpt,'Verified excerpt');assert.equal(rows[0].publishedAt,source.publishedAt);assert.equal(rows[1].publishedAt,null);
    assert.throws(()=>search.parseDeepSeekSearch({content:[{type:'text',text:'pretend results'}]}),/没有执行/);
    assert.throws(()=>search.parseDeepSeekSearch({content:[{type:'web_search_tool_result',content:{type:'web_search_tool_result_error'}}]}),/有效来源/);
    assert.deepEqual(search.feedSearchQueries(['topic','topic','https://private.example','x'.repeat(81),'key token:secret','second','third','fourth']),['topic','second','third','fourth']);
    assert.equal(search.feedSearchQueries(Array.from({length:10},(_,i)=>'topic '+i)).length,6);
    const groups=[Array.from({length:20},(_,i)=>({...source,title:'US '+i})),[{...source,title:'Stocks'}],[{...source,title:'Companies'}]];
    assert.deepEqual(search.balanceFeedSources(groups).slice(0,3).map(s=>s.title),['US 0','Stocks','Companies']);
  });
  await test('official native search is wired, audited and bounded; gateway keys never leave their host',async()=>{
    settings.updateSiteSettings({modelServices:[{id:'native',provider:'deepseek',name:'DeepSeek',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'isolated-native-key',models:['deepseek-flash']}]});
    let calls=0;global.fetch=async(url,init)=>{calls++;if(new URL(url).hostname==='news.google.com')return new Response('<rss><channel><item><title>Independent dated report</title><link>https://news.example/dated</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>');assert.equal(String(url),'https://api.deepseek.com/anthropic/v1/messages');assert.equal(init.headers['x-api-key'],'isolated-native-key');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.tools[0].name,'web_search');assert.equal(body.tools[0].max_uses,1);assert(body.system.includes('2–4'));assert(!body.messages[0].content[0].text.includes('private'));return Response.json({content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:source.url,title:source.title}]}]});};
    const rows=await search.searchFeedSources(['technology'],user.id);assert.equal(rows[0].id,'s1');assert.equal(rows[0].publishedAt,null,'do not borrow a different article date');assert.equal(rows[1].publishedAt,source.publishedAt);assert.equal(calls,2);assert.equal(generation.feedCapabilities().searchProvider,'deepseek');assert.equal(generation.feedCapabilities().search,'news-rss','legacy enum remains compatible');
    settings.updateSiteSettings({modelServices:[{id:'gateway',provider:'deepseek',name:'Gateway',apiUrl:'https://gateway.example/v1/chat/completions',apiKey:'gateway-key',models:['deepseek-flash']}]});
    assert.equal(search.officialFeedSearch(),undefined);
  });
  await test('native and Brave failure fall through to RSS; no-results and outages are distinguishable',async()=>{
    settings.updateSiteSettings({modelServices:[{id:'native',provider:'deepseek',name:'DeepSeek',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'isolated-native-key',models:['deepseek-flash']}]});
    const previous=process.env.BRAVE_SEARCH_API_KEY;process.env.BRAVE_SEARCH_API_KEY='isolated-brave-key';
    try {
      let hosts=[];global.fetch=async(url)=>{const host=new URL(url).hostname;hosts.push(host);return host==='news.google.com'?new Response('<rss><channel><item><title>Verified</title><link>https://news.example/fallback</link></item></channel></rss>'):Response.json({error:'private diagnostic'},{status:503});};
      assert.equal((await search.searchFeedSources(['technology'])).length,1);assert.deepEqual(hosts,['api.deepseek.com','api.search.brave.com','news.google.com']);
      global.fetch=async()=>{throw new Error('private credential diagnostics');};await assert.rejects(()=>search.searchFeedSources(['technology']),e=>e.diagnostics.length===3&&e.message.includes('网络')&&!e.message.includes('private'));
    } finally {if(previous===undefined)delete process.env.BRAVE_SEARCH_API_KEY;else process.env.BRAVE_SEARCH_API_KEY=previous;}
    settings.updateSiteSettings({modelServices:[]});global.fetch=async()=>new Response('<rss><channel/></rss>');await assert.rejects(()=>search.searchFeedSources(['technology']),e=>e.diagnostics[0].outcome==='empty'&&e.message.includes('没有找到'));
  });
  settings.updateSiteSettings({modelServices:[{id:'test-model',provider:'custom',name:'Isolated',apiUrl:'https://model.example/v1/chat/completions',apiKey:'isolated-test-key',models:['test-model']}]});
  await test('one persisted task per account, changing instructions invalidates old jobs',()=>{
    const first=store.createFeedJob(user.id),again=store.createFeedJob(user.id);assert.equal(first.job.id,again.job.id);assert.equal(again.created,false);
    store.saveFeedPreferences(user.id,{instructions:'new public topic',revision:1});assert.equal(store.getFeedJob(user.id,first.job.id).status,'error');
    const next=store.createFeedJob(user.id);assert.notEqual(next.job.id,first.job.id);assert.equal(next.job.revision,2);
    db.prepare("UPDATE feed_jobs SET status='error' WHERE user_id=?").run(user.id);
  });
  await test('generation uses actual fetched source IDs, stores history and finishes persisted jobs',async()=>{
    let models=0;global.fetch=async(url,init)=>{
      if(String(url).startsWith('https://news.google.com/'))return new Response('<rss><channel><item><title>Verified</title><link>https://news.example/generated</link><pubDate>Wed, 30 Sep 2026 12:00:00 GMT</pubDate><description>Verified company earnings show actual revenue growth with ongoing cost uncertainty.</description></item></channel></rss>');
      assert.equal(new URL(url).hostname,'model.example');models++;
      return Response.json({choices:[{message:{content:JSON.stringify(models===1?{queries:['technology']}:{posts:[{title:'Verified generated',icon:'technology',segments:[{text:'Verified',sourceId:'s1'}]}]})}}]});
    };
    const {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);
    assert.equal(store.getFeedJob(user.id,job.id).status,'done');assert.equal(store.getFeedJob(user.id,job.id).added,1);assert.equal(models,3);
    const after=store.listFeedPosts(user.id,null,50);assert(after.posts.some(p=>p.title==='Verified generated'));assert(after.posts.some(p=>p.id===post.id));
    await generation.runFeedJob(user.id,job.id);assert.equal(models,3,'finished jobs cannot replay');
  });
  await test('evidence reviewer can reject a draft without publishing it or replacing history',async()=>{
    const before=store.listFeedPosts(user.id,null,50).posts.length;let models=0;
    global.fetch=async(url,init)=>{
      if(new URL(url).hostname==='news.google.com')return new Response('<rss><channel><item><title>New earnings</title><link>https://news.example/review</link><description>The company reported earnings without any evidence of after-hours stock movement.</description></item></channel></rss>');
      const body=JSON.parse(init.body);models++;
      if(models===3){assert(body.messages[0].content.includes('独立证据编辑'));assert(JSON.parse(body.messages[1].content).drafts.length);return Response.json({choices:[{message:{content:'{"posts":[]}'}}]});}
      return Response.json({choices:[{message:{content:JSON.stringify(models===1?{queries:['technology']}:{posts:[{title:'Unverified movement',segments:[{text:'盘后股价大涨50%，这一变化没有来源依据。',sourceId:'s1',linkText:'股价大涨50%'}]}]})}}]});
    };
    const {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);
    assert.equal(models,3);assert.equal(store.getFeedJob(user.id,job.id).status,'error');assert.equal(store.listFeedPosts(user.id,null,50).posts.length,before);
  });
  await test('provider failure and revision races preserve history, never insert fake fallback posts',async()=>{
    const before=store.listFeedPosts(user.id,null,50).posts.length;global.fetch=async()=>{throw new Error('private provider diagnostic');};
    const {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);assert.equal(store.getFeedJob(user.id,job.id).status,'error');assert(!store.getFeedJob(user.id,job.id).error.includes('private'));
    assert.equal(store.listFeedPosts(user.id,null,50).posts.length,before);
  });
  await test('invalid JSON retries once, truncated output cannot publish, and plain discussion stays plain',async()=>{
    settings.updateSiteSettings({modelServices:[{id:'native',provider:'deepseek',name:'DeepSeek',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'isolated-native-key',models:['deepseek-flash']}]});
    const searchFn=search.searchFeedSources;search.searchFeedSources=async()=>[{...source,url:'https://news.example/json-retry'}];
    let requests=0;
    global.fetch=async(url,init)=>{const body=JSON.parse(init.body);requests++;assert.equal(body.response_format.type,'json_object');assert.equal(body.max_tokens,6500);
      if(requests===1)return Response.json({choices:[{finish_reason:'length',message:{content:'{"queries":['}}]});
      if(requests===2){assert(body.messages[0].content.includes('上次输出'));return Response.json({choices:[{message:{content:'{"queries":["technology"]}'}}]});}
      return Response.json({choices:[{message:{content:JSON.stringify({posts:[{title:'JSON retry verified',segments:[{text:'Verified',sourceId:'s1'}]}]})}}]});};
    try {
      let {job}=generation.requestFeedGeneration(user.id);await generation.runFeedJob(user.id,job.id);assert.equal(requests,4);assert.equal(store.getFeedJob(user.id,job.id).status,'done');
      const before=store.listFeedPosts(user.id,null,50).posts.length;requests=0;
      global.fetch=async()=>{requests++;return Response.json({choices:[{message:{content:'invalid private response'}}]});};
      ({job}=generation.requestFeedGeneration(user.id));await generation.runFeedJob(user.id,job.id);assert.equal(requests,2);assert.equal(store.getFeedJob(user.id,job.id).error,'模型返回格式无效，请重试');assert.equal(store.listFeedPosts(user.id,null,50).posts.length,before);
      global.fetch=async(url,init)=>{assert.equal(JSON.parse(init.body).response_format,undefined);return Response.json({choices:[{message:{content:'Plain response'}}]});};
      await generation.discussFeed(user.id,post.id,'plain');db.prepare('DELETE FROM feed_messages WHERE user_id=?').run(user.id);
    } finally {search.searchFeedSources=searchFn;settings.updateSiteSettings({modelServices:[{id:'test-model',provider:'custom',name:'Isolated',apiUrl:'https://model.example/v1/chat/completions',apiKey:'isolated-test-key',models:['test-model']}]});}
  });
  await test('scheduler retries failed updates after 15 minutes, respects success intervals and recovers orphaned jobs',async()=>{
    db.prepare('UPDATE users SET is_test=1').run();db.prepare('UPDATE users SET is_test=0 WHERE id=?').run(user.id);
    db.prepare('UPDATE feed_group_preferences SET enabled=0').run();db.prepare('DELETE FROM feed_jobs WHERE user_id=?').run(user.id);
    const {job}=store.createFeedJob(user.id),ago=minutes=>new Date(Date.now()-minutes*60_000).toISOString();
    db.prepare("UPDATE feed_jobs SET status='error',created_at=?,updated_at=? WHERE id=?").run(ago(60),ago(1),job.id);
    let calls=0;global.fetch=async()=>{calls++;throw new Error('unavailable');};
    await generation.tickFeedScheduler();assert.equal(calls,0,'wait from failure completion, not creation');
    db.prepare('UPDATE feed_jobs SET updated_at=? WHERE id=?').run(ago(16),job.id);
    await generation.tickFeedScheduler();assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM feed_jobs WHERE user_id=?').get(user.id).n,2);
    db.prepare("UPDATE feed_jobs SET status='done',created_at=?,updated_at=? WHERE user_id=?").run(ago(30),ago(29),user.id);
    await generation.tickFeedScheduler();assert.equal(calls,1,'successful updates retain configured interval');
    db.prepare("UPDATE feed_jobs SET status='error' WHERE user_id=?").run(user.id);
    const orphan=store.createFeedJob(user.id).job;db.prepare('UPDATE feed_jobs SET updated_at=? WHERE id=?').run(ago(6),orphan.id);
    await generation.tickFeedScheduler();assert.equal(store.getFeedJob(user.id,orphan.id).status,'error');assert.equal(calls,1,'recover without duplicating live work');
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
