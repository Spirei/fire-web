// Celebrity template uses real handlers/SQLite and public-cache fixtures; never writes live business data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-feed-people-'));
process.chdir(temp);process.env.STOCKLOG_FUTU='off';process.env.STOCKLOG_PROXY='off';process.env.FIRE_APP_ORIGIN='https://people.test.example';
global.fetch=async()=>{throw Error('External network disabled');};
const resolve=Module._resolveFilename,load=Module._load,background=[];
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
Module._load=function(id,parent,...rest){const value=load.call(this,id,parent,...rest);return id==='next/server'?{...value,after:callback=>background.push(callback)}:value;};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
const get=file=>require(path.join(root,file)),auth=get('lib/auth.ts'),store=get('lib/feedStore.ts'),generation=get('lib/feedGeneration.ts'),collector=get('lib/tradingSquareRefresh.ts'),translate=get('lib/tradingSquareTranslate.ts'),route=get('app/api/v1/feed/[[...action]]/route.ts');
const user=auth.createUser('people_owner','People-test-123'),other=auth.createUser('people_other','People-test-123'),session=auth.createSession(user.id),db=get('lib/db.ts').getDb();
const call=(action='',method='GET',body)=>route[method](new Request(process.env.FIRE_APP_ORIGIN+'/api/v1/feed'+action,{method,headers:{cookie:'fire_session='+session,origin:process.env.FIRE_APP_ORIGIN,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{params:Promise.resolve({action:action.split('?')[0].split('/').filter(Boolean)})});
const image='/uploads/trading-square/trump/0123456789abcdef.png',duanImage='/uploads/trading-square/duan/abcdef0123456789.png';
const fixtureTime=Date.now()-3600_000;
const time=index=>new Date(fixtureTime+index*1000).toISOString();
fs.mkdirSync('data',{recursive:true});
for(const url of [image,duanImage]){const file=path.join(temp,'public',url);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'local image fixture');}
const trump=Array.from({length:14},(_,i)=>({id:String(i),date:time(i*2),text:i===13?'':'Original '+i,originalUrl:'https://truthsocial.com/@realDonaldTrump/'+i,images:i===13?[image]:undefined}));
const duan=Array.from({length:12},(_,i)=>({id:String(i),date:time(i*2+1),text:'段永平原帖 '+i,originalUrl:'https://xueqiu.com/1247347556/'+i,categories:['original'],...(i===11?{replyTo:'提问者',quote:{name:'原作者',text:'引用内容',url:'https://xueqiu.com/100/200',images:[duanImage]}}:{})}));
function caches(){fs.writeFileSync('data/trump-posts.json',JSON.stringify(trump));fs.writeFileSync('data/duan-posts.json',JSON.stringify(duan));}
caches();
let passed=0;async function test(name,run){await run();passed++;console.log('PASS '+name);}
(async()=>{
  let group;
  await test('built-in template is explicit, account-owned and usable without model/instructions',async()=>{
    assert.equal(generation.feedCapabilities().generate,false);
    const response=await call('/groups','POST',{name:'名人动态',mode:'people',people:['trump','duan']});assert.equal(response.status,200);group=(await response.json()).data;
    assert.equal(group.mode,'people');assert.deepEqual(group.people,['trump','duan']);assert.equal(store.feedPreferences(user.id,group.id).instructions,'');assert.equal(store.feedPreferences(user.id,group.id).enabled,true);assert.equal(store.feedPreferences(user.id,group.id).intervalMinutes,5);
    assert.equal(background.length,1);assert.throws(()=>store.feedGroup(other.id,group.id),/不存在/);
    for(const invalid of [{mode:'unknown'},{people:[]},{people:['trump','trump']},{people:['invented']},{people:['trump'],userId:other.id}])assert.equal((await call('/groups','POST',{name:'bad',mode:'people',...invalid})).status,400);
  });
  await test('original caches backfill one post per platform ID, including pure image and quote/reply posts',async()=>{
    const response=await call('?group='+group.id);assert.equal(response.status,200);const first=(await response.json()).data;
    assert.equal(first.posts.length,10);assert(first.nextCursor);assert(first.posts.every(post=>post.original));
    const all=generation.feedSnapshot(user.id,null,50,group.id).posts;assert.equal(all.length,26);
    assert.equal(all.filter(post=>post.original.platformPostId==='0').length,2,'same numeric ID on different platforms stays distinct');
    const pure=all.find(post=>post.original.person.id==='trump'&&post.original.platformPostId==='13');assert.equal(pure.original.text,'');assert.equal(pure.media[0].url,image);assert.equal(pure.segments.length,0);
    const reply=all.find(post=>post.original.person.id==='duan'&&post.original.platformPostId==='11');assert.equal(reply.original.replyTo,'提问者');assert.equal(reply.original.quote.text,'引用内容');assert.equal(reply.original.quote.media[0].url,duanImage);
    assert(all.some(post=>post.original.text==='Original 0'));assert.equal(generation.feedSnapshot(user.id,null,50,group.id).posts.length,26);
  });
  await test('timeline follows original time, cursor has no overlap, server author filter spans all history',async()=>{
    const first=generation.feedSnapshot(user.id,null,10,group.id),second=generation.feedSnapshot(user.id,first.nextCursor,10,group.id);
    assert.equal(new Set([...first.posts,...second.posts].map(post=>post.id)).size,20);
    const all=generation.feedSnapshot(user.id,null,50,group.id).posts;for(let i=1;i<all.length;i++)assert(all[i-1].publishedAt>=all[i].publishedAt);
    const filtered=(await (await call('?group='+group.id+'&author=duan')).json()).data;assert.equal(filtered.posts.length,10);assert(filtered.posts.every(post=>post.original.person.id==='duan'));assert(filtered.nextCursor);
    assert.equal(generation.feedSnapshot(user.id,filtered.nextCursor,10,group.id,'duan').posts.length,2);
    assert.equal((await call('?group='+group.id+'&author=unknown')).status,400);
    assert.equal((await call('?group='+group.id+'&cursor='+first.nextCursor.replace(/./g,'x'))).status,400);
  });
  await test('later translation updates the same row while likes, hidden state and original time survive',()=>{
    const original=generation.feedSnapshot(user.id,null,50,group.id).posts.find(post=>post.original.person.id==='trump'&&post.original.platformPostId==='12');
    store.updateFeedPost(user.id,original.id,{liked:true,hidden:true});
    fs.writeFileSync('data/trump-translations.json',JSON.stringify({'12':'原帖十二的完整译文'}));generation.feedSnapshot(user.id,null,50,group.id);
    const saved=store.getFeedPost(user.id,original.id);assert.equal(saved.original.textZh,'原帖十二的完整译文');assert.equal(saved.original.text,'Original 12');assert(saved.liked&&saved.hidden);assert.equal(saved.createdAt,original.createdAt);assert.equal(saved.publishedAt,original.publishedAt);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feed_posts WHERE user_id=? AND group_id=? AND kind='people'").get(user.id,group.id).n,26);
    store.updateFeedPost(user.id,original.id,{hidden:false});
  });
  await test('unread avatar state includes authors outside the current ten-item page',()=>{
    const snapshot=generation.feedSnapshot(user.id,null,10,group.id,'trump');
    assert(snapshot.posts.every(post=>post.original.person.id==='trump'));
    assert.equal(snapshot.peopleLatestAt.duan,time(23));assert.equal(snapshot.peopleLatestAt.trump,time(26));
    const {feedPersonHasUpdates}=get('lib/feedPeopleConfig.ts');
    assert(feedPersonHasUpdates('duan',snapshot.peopleLatestAt,{duan:time(1)}));
    assert(!feedPersonHasUpdates('duan',snapshot.peopleLatestAt,{}));
    assert(!feedPersonHasUpdates('duan',snapshot.peopleLatestAt,{duan:time(23)}));
    assert(!feedPersonHasUpdates('invented',{invented:time(23)},{invented:time(1)}));
    const {mergeFeedSeen}=get('lib/feedPeopleConfig.ts'),existing={trump:time(26),duan:time(1)};
    assert.equal(mergeFeedSeen(existing,{trump:time(2),duan:'invalid',invented:time(26)}),existing);
    assert.deepEqual(mergeFeedSeen(existing,{duan:time(23)}),{trump:time(26),duan:time(23)});
  });
  await test('avatar editing reuses shared management and refreshes catalog plus historical original cards',async()=>{
    const avatarRoute=get('app/api/celebs/avatar/route.ts'),png=Buffer.from('89504e470d0a1a0a','hex');
    const upload=(id='trump',bytes=png,origin=process.env.FIRE_APP_ORIGIN)=>{const form=new FormData();form.set('id',id);form.set('file',new File([bytes],'portrait.png',{type:'image/png'}));return avatarRoute.POST(new Request(process.env.FIRE_APP_ORIGIN+'/api/celebs/avatar',{method:'POST',headers:{cookie:'fire_session='+session,origin},body:form}));};
    assert.equal((await upload()).status,403);assert.equal(generation.feedSnapshot(user.id,null,10,group.id).capabilities.editPeopleAvatars,false);
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    assert.equal((await upload('invented')).status,400);assert.equal((await upload('trump',Buffer.from('<svg>not a PNG</svg>'))).status,400);assert.equal((await upload('trump',png,'https://foreign.example')).status,401);
    const before=generation.feedSnapshot(user.id,null,50,group.id).posts.find(post=>post.original.person.id==='trump'&&post.original.platformPostId==='12');
    const response=await upload();assert.equal(response.status,200);const result=await response.json();
    const snapshot=generation.feedSnapshot(user.id,null,50,group.id),after=snapshot.posts.find(post=>post.id===before.id);
    assert.equal(snapshot.peopleCatalog.find(person=>person.id==='trump').avatar,result.avatar);assert.equal(after.original.person.avatar,result.avatar);assert.equal(after.createdAt,before.createdAt);assert.equal(after.liked,before.liked);assert.equal(snapshot.posts.length,26);assert(snapshot.capabilities.editPeopleAvatars);
    assert.equal(get('lib/celebsData.ts').getCelebAvatars().trump,result.avatar);assert(fs.existsSync(path.join(temp,'public',result.avatar)));
    db.prepare("UPDATE users SET role='user' WHERE id=?").run(user.id);
  });
  await test('renaming never changes template and switching templates preserves each history',()=>{
    let pref=store.feedPreferences(user.id,group.id);store.saveFeedPreferences(user.id,{instructions:'旧新闻指示',revision:pref.revision,name:'我的人物',mode:'news',intervalMinutes:60},group.id);
    const source={id:'s1',title:'News',url:'https://news.example/story',publisher:'Publisher',publishedAt:time(1),excerpt:'News evidence'};
    store.appendFeedPosts(user.id,store.normalizeGeneratedPosts([{title:'新闻',segments:[{text:'新闻事实',sourceId:'s1'}]}],[source]),group.id);
    assert.equal(generation.feedSnapshot(user.id,null,50,group.id).posts.length,1);
    pref=store.feedPreferences(user.id,group.id);store.saveFeedPreferences(user.id,{instructions:'旧新闻指示',revision:pref.revision,mode:'people',people:['duan']},group.id);
    const result=generation.feedSnapshot(user.id,null,50,group.id);assert.equal(result.group.name,'我的人物');assert.equal(result.posts.length,12);assert(result.posts.every(post=>post.original.person.id==='duan'));assert.equal(result.preferences.intervalMinutes,5);
    assert.throws(()=>store.saveFeedPreferences(user.id,{instructions:'',revision:pref.revision,mode:'people'},group.id),/另一端/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM feed_posts WHERE user_id=? AND group_id=?").get(user.id,group.id).n,27);
  });
  await test('missing media keeps a pure image original and recovers when the upload volume returns',()=>{
    const missing='/uploads/trading-square/duan/1111111111111111.png';
    duan.push({id:'missing-media',date:time(-100),text:'',originalUrl:'https://xueqiu.com/1247347556/missing-media',images:[missing]});caches();
    let item=generation.feedSnapshot(user.id,null,50,group.id).posts.find(post=>post.original.platformPostId==='missing-media');
    assert(item.original.mediaUnavailable);assert.equal(item.media.length,0);
    fs.writeFileSync(path.join(temp,'public',missing),'restored image');
    item=generation.feedSnapshot(user.id,null,50,group.id).posts.find(post=>post.original.platformPostId==='missing-media');
    assert.equal(item.original.mediaUnavailable,undefined);assert.equal(item.media[0].url,missing);
    duan.pop();caches();
    // Original history is retained even when an upstream cache no longer includes an item.
    assert(store.getFeedPost(user.id,item.id));
  });
  await test('source failures remain distinct from successful empty changes and never erase originals',async()=>{
    // Test the actual collector fallback/status writing with networking disabled.
    await collector.refreshDuanPosts({includeComments:false,maxPages:1});
    const failed=collector.getTradingSquareSourceStatus(['duan'])[0];assert(failed.lastAttemptAt);assert.equal(failed.lastSuccessAt,null);assert(failed.error);
    const result=generation.feedSnapshot(user.id,null,50,group.id);assert.equal(result.posts.length,13);assert(result.peopleSources[0].error);
    const queued=store.getFeedJob(user.id,undefined,group.id);if(queued&&['queued','searching','writing'].includes(queued.status))db.prepare("UPDATE feed_jobs SET status='error' WHERE id=?").run(queued.id);
    const {job}=generation.requestFeedGeneration(user.id,group.id);await generation.runFeedJob(user.id,job.id);assert.equal(store.getFeedJob(user.id,job.id).status,'error');assert.equal(generation.feedSnapshot(user.id,null,50,group.id).posts.length,13);
  });
  await test('Xueqiu login rejection exposes an actionable safe status and preserves cached history',async()=>{
    const originalFetch=global.fetch;
    global.fetch=async()=>new Response(JSON.stringify({error_code:'400016'}),{status:400,headers:{'content-type':'application/json'}});
    try{await collector.refreshDuanPosts({includeComments:false,maxPages:1});assert.match(collector.getTradingSquareSourceStatus(['duan'])[0].error,/登录验证.*Cookie/);assert.equal(generation.feedSnapshot(user.id,null,50,group.id).posts.length,13);}
    finally{global.fetch=originalFetch;}
  });
  await test('translation keeps full input and refuses truncated output or a partial fallback',async()=>{
    const settings=get('lib/settings.ts'),originalFetch=global.fetch;
    settings.updateSiteSettings({modelServices:[{id:'translation',provider:'deepseek',name:'Test',apiUrl:'https://api.deepseek.com/chat/completions',apiKey:'isolated-key',models:['deepseek-flash']}],translationEnabled:true});
    const calls=[],text='Long original post. '.repeat(50);
    global.fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body?JSON.parse(init.body):null});return new Response(JSON.stringify({choices:[{message:{content:'被截断的译文'},finish_reason:'length'}]}),{headers:{'content-type':'application/json'}});};
    try{const translated=await translate.translateTrumpPostsNow([{id:'long-translation',text}]);assert.equal(translated[0].textZh,undefined);assert.equal(calls.length,1);assert.equal(calls[0].body.messages[1].content,text);assert.deepEqual(calls[0].body.thinking,{type:'disabled'});assert.equal(translate.readTranslations()['long-translation'],undefined);}
    finally{global.fetch=originalFetch;settings.updateSiteSettings({modelServices:[]});}
  });
  await test('successful original ingestion completes before background translation and without news search/model',async()=>{
    collector.refreshDuanPosts=async()=>{duan.push({id:'new-original',date:time(120),text:'刚取得的新原帖',originalUrl:'https://xueqiu.com/1247347556/new-original'});caches();};
    collector.getTradingSquareSourceStatus=ids=>ids.map(personId=>({personId,lastAttemptAt:null,lastSuccessAt:new Date().toISOString(),error:null}));
    translate.backfillTrumpTranslations=async()=>new Promise(()=>{});
    const {job}=generation.requestFeedGeneration(user.id,group.id);await generation.runFeedJob(user.id,job.id);const done=store.getFeedJob(user.id,job.id);assert.equal(done.status,'done');assert.equal(done.added,1);assert.equal(generation.feedSnapshot(user.id,null,10,group.id).posts[0].original.text,'刚取得的新原帖');
  });
  await test('the scheduler updates enabled people templates with no model and no prompt',async()=>{
    db.prepare('UPDATE users SET is_test=0 WHERE id=?').run(user.id);
    db.prepare('UPDATE feed_jobs SET created_at=?,updated_at=? WHERE user_id=?').run(time(-1000000),time(-1000000),user.id);
    const before=db.prepare('SELECT COUNT(*) AS n FROM feed_jobs WHERE user_id=? AND group_id=?').get(user.id,group.id).n;
    await generation.tickFeedScheduler();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM feed_jobs WHERE user_id=? AND group_id=?').get(user.id,group.id).n,before+1);
    assert.equal(store.getFeedJob(user.id,undefined,group.id).status,'done');assert.equal(generation.feedCapabilities().generate,false);
  });
  await test('original card renders identity, real original time, local media and escaped original text',()=>{
    const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
    const item=generation.feedSnapshot(user.id,null,10,group.id).posts[0];item.original.text='<script>alert(1)</script>';
    const Component=get('components/FeedOriginalPost.tsx').default;
    const html=renderToStaticMarkup(React.createElement(Component,{post:item,isNew:true,busy:false,canDiscuss:false,onMenu(){},onLike(){},onDiscuss(){}}));
    assert(html.includes('段永平')&&html.includes('@slowisquick'));assert(!html.includes('href="'+item.original.originalUrl+'"'));assert(!html.includes('feed-original-links'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>alert'));assert(html.includes('dateTime="')||html.includes('datetime="'));assert(html.includes('aria-label="新动态"'));
    const translated={...item,original:{...item.original,textZh:'完整译文',quote:{name:'引用作者',text:'引用正文',url:'https://xueqiu.com/quote/retained',media:[]}}};
    const translatedHtml=renderToStaticMarkup(React.createElement(Component,{post:translated,isNew:false,busy:false,canDiscuss:false,onMenu(){},onLike(){},onDiscuss(){}}));
    assert(translatedHtml.includes('完整译文'));assert(translatedHtml.includes('aria-pressed="false">原文</button>'));assert(!translatedHtml.includes('href="'+item.original.originalUrl+'"'));assert(translatedHtml.includes('href="https://xueqiu.com/quote/retained"'));assert(translatedHtml.includes('查看转发原帖'));
    const viewSource=fs.readFileSync(path.join(root,'components/views/FeedView.tsx'),'utf8');assert(!viewSource.includes('role="status">{FEED_PEOPLE.find'));assert(!viewSource.includes('data?.peopleSources'));assert(viewSource.includes('<FeedAgentPanel'));
    const agentSource=fs.readFileSync(path.join(root,'components/FeedAgentPanel.tsx'),'utf8');assert(agentSource.includes('data.peopleSources?.filter'));assert(agentSource.includes('i===0&&sourceErrors.map'));
    const Badge=get('components/FeedPersonBadge.tsx').default;
    assert.equal(renderToStaticMarkup(React.createElement(Badge,{personId:'invented'})),'');
    assert(renderToStaticMarkup(React.createElement(Badge,{personId:'trump'})).includes('#f43f6b'));
    assert(renderToStaticMarkup(React.createElement(Badge,{personId:'duan'})).includes('#1d9bf0'));
    const Filter=get('components/FeedPeopleFilter.tsx').default,profiles=generation.feedSnapshot(user.id,null,10,group.id).peopleCatalog;
    const filter=renderToStaticMarkup(React.createElement(Filter,{profiles,selected:'duan',unread:{trump:true,duan:false},onSelect(){}}));
    assert(filter.includes('全部动态')&&filter.includes('特朗普有新动态')&&!filter.includes('段永平有新动态'));
    const Picker=get('components/FeedTemplatePicker.tsx').default;
    const picker=renderToStaticMarkup(React.createElement(Picker,{mode:'people',people:['duan'],onMode(){},onPeople(){}}));assert(picker.includes('名人原帖')&&picker.includes('关注段永平')&&picker.includes('雪球认证'));
    const editable=renderToStaticMarkup(React.createElement(Picker,{mode:'people',people:['duan'],profiles,onMode(){},onPeople(){},onAvatarFile(){}}));assert(editable.includes('修改特朗普头像'));assert(!picker.includes('type="file"'));assert(!editable.includes('<button type="button" data-capsule="off" role="checkbox" aria-label="关注特朗普" aria-checked="false" disabled'));
  });
  await test('person switching never flashes empty state and ignores delayed superseded responses',async()=>{
    const preferences=store.feedPreferences(user.id,group.id);
    store.saveFeedPreferences(user.id,{instructions:preferences.instructions,revision:preferences.revision,people:['trump','duan']},group.id);
    await require('./feed-transitions.cjs')(generation.feedSnapshot(user.id,null,50,group.id));
  });
  await test('group switching keeps shared layout and restores isolated snapshots',async()=>{
    await require('./feed-groups.cjs')(generation.feedSnapshot(user.id,null,50,group.id));
  });
  await test('quiet snapshots reuse unchanged cards while edits, translation, avatar and media update immediately',()=>{
    const {reconcileFeedPayload,feedChromeKey}=get('lib/feedSnapshots.ts');
    const original=generation.feedSnapshot(user.id,null,10,group.id),clone=()=>JSON.parse(JSON.stringify(original));
    assert.equal(reconcileFeedPayload(original,clone()),original);
    const changed=clone();changed.posts[0].liked=!original.posts[0].liked;
    const result=reconcileFeedPayload(original,changed);assert.notEqual(result.posts[0],original.posts[0]);assert.equal(result.posts[1],original.posts[1]);assert.equal(result.posts[0].liked,changed.posts[0].liked);
    for(const edit of [post=>post.original.textZh='新译文',post=>post.original.person.avatar='/new-avatar.webp',post=>post.media.push({type:'image',url:'/new-image.webp',alt:'新配图'}),post=>post.hidden=true]){
      const updated=clone();edit(updated.posts[0]);const next=reconcileFeedPayload(original,updated);assert.deepEqual(next.posts[0],updated.posts[0]);assert.notEqual(next.posts[0],original.posts[0]);assert.equal(next.posts[1],original.posts[1]);
    }
    const reordered=clone();reordered.posts.reverse();assert.deepEqual(reconcileFeedPayload(original,reordered).posts.map(post=>post.id),reordered.posts.map(post=>post.id));
    const status=clone();status.job={id:'new-job',status:'searching',revision:status.preferences.revision};assert.equal(reconcileFeedPayload(original,status).posts,original.posts);assert.equal(feedChromeKey(status),feedChromeKey(original));
    const renamed=clone();renamed.agent={name:'新名称',image:null,revision:2,updatedAt:null};assert.notEqual(feedChromeKey(renamed),feedChromeKey(original));
  });
  console.log(`${passed} celebrity-template suites passed; disposable data only`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();fs.rmSync(temp,{recursive:true,force:true});});
