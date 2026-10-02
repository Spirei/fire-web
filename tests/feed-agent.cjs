// Real handlers and uploads, entirely inside a disposable account/database/filesystem.
const crypto=require('node:crypto');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'alcor-agent-'));process.chdir(temp);
process.env.STOCKLOG_FUTU='off';process.env.STOCKLOG_PROXY='off';process.env.FIRE_APP_ORIGIN='https://feed.test.example';
global.fetch=async()=>{throw new Error('network disabled');};require('node:dns/promises').lookup=async()=>{throw new Error('DNS disabled');};
const load=file=>require(path.join(root,file)),auth=load('lib/auth.ts'),db=load('lib/db.ts').getDb(),store=load('lib/feedStore.ts'),agent=load('lib/feedAgent.ts'),clean=load('lib/fileCleanup.ts'),route=load('app/api/v1/feed/[[...action]]/route.ts'),generation=load('lib/feedGeneration.ts');
const native=load('lib/appAuth.ts');
const user=auth.createUser('agent_owner','Agent-test-123'),other=auth.createUser('agent_other','Agent-test-123'),session=auth.createSession(user.id),otherSession=auth.createSession(other.id),origin=process.env.FIRE_APP_ORIGIN;
const request=(action,method='GET',body,cookie=session,site=origin)=>new Request(origin+'/api/v1/feed/'+action,{method,headers:{cookie:'fire_session='+cookie,origin:site,...(body instanceof FormData?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});
const call=(action,method='GET',body,cookie=session,site=origin)=>route[method](request(action,method,body,cookie,site),{params:Promise.resolve({action:action.split('?')[0].split('/')})});
function connect(scope) {
  const verifier=crypto.randomBytes(32).toString('base64url'),values={client_id:native.APP_CLIENT_ID,redirect_uri:native.APP_REDIRECT_URI,response_type:'code',code_challenge_method:'S256',code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),state:crypto.randomBytes(32).toString('base64url'),scope};
  const code=native.issueAppCode(native.parseAppAuthorization(values),user.id,session);return native.exchangeAppCode({...values,code,code_verifier:verifier});
}
const bearerCall=(action,method,body,token)=>route[method](new Request(origin+'/api/v1/feed/'+action,{method,headers:{authorization:'Bearer '+token,...(body instanceof FormData?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})}),{params:Promise.resolve({action:action.split('/')})});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSAAAAAASUVORK5CYII=','base64');
const upload=(rev,bytes=png,name='avatar.png')=>{const form=new FormData();form.set('revision',String(rev));form.set('file',new File([bytes],name,{type:'image/png'}));return form;};
let count=0;async function test(name,run){db.prepare('DELETE FROM rate_limit').run();await run();console.log('PASS '+name);count++;}
(async()=>{
  await test('profile defaults, authentication, strict fields and owner isolation',async()=>{
    assert.deepEqual(agent.feedAgentProfile(user.id),{name:'Alcor',image:null,revision:0,updatedAt:null});
    assert.equal((await call('profile','GET',undefined,'invalid')).status,401);
    assert([401,403].includes((await call('profile','PUT',{name:'Rocky',revision:0},session,'https://other.example')).status));
    assert.equal((await call('profile','PUT',{name:' Rocky ',revision:0})).status,200);
    assert.equal(agent.feedAgentProfile(user.id).name,'Rocky');assert.equal(agent.feedAgentProfile(other.id).name,'Alcor');
    for(const body of [{name:'',revision:1},{name:'x'.repeat(41),revision:1},{name:'x\n',revision:1},{name:'x',revision:-1},{name:'x',revision:1,userId:other.id},{image:'/uploads/avatar/other.png',revision:1},{name:'x',resetAvatar:true,revision:1}])assert.equal((await call('profile','PUT',body)).status,400);
    assert.equal((await call('profile','PUT',{name:'stale',revision:0})).status,409);
  });
  await test('profile changes preserve instructions and the running job',async()=>{
    store.saveFeedPreferences(user.id,{instructions:'private instructions',revision:0,enabled:true});
    const job=store.createFeedJob(user.id).job;
    await call('profile','PUT',{name:'Alcor Plus',revision:1});
    assert.equal(store.feedPreferences(user.id).revision,1);assert.equal(store.getFeedJob(user.id,job.id).status,'queued');
  });
  let first;
  await test('avatar bytes are validated, owner-scoped, persisted and stop default video',async()=>{
    assert.equal((await call('profile/avatar','POST',upload(2,Buffer.from('<svg/>'),'avatar.svg'))).status,400);
    assert.equal((await call('profile/avatar','POST',upload(2,Buffer.from('not an image')))).status,400);
    assert.equal((await call('profile/avatar','POST',upload(2,Buffer.alloc(2*1024*1024+1)))).status,413);
    const result=await call('profile/avatar','POST',upload(2));assert.equal(result.status,200);
    first=(await result.json()).data.image;
    assert.match(first,new RegExp('^/uploads/avatar/'+user.id+'/agent-[a-f0-9]{24}\\.png$'));
    assert(fs.existsSync(clean.localPathOf(first)));assert(clean.urlReferenced(first));assert.equal(clean.removeFileIfUnused(first),false);
    const snapshot=generation.feedSnapshot(user.id);assert.equal(snapshot.agent.image,first);assert.deepEqual(snapshot.capabilities.avatar,{image:first,video:null});
    assert.equal((await (await call('profile','GET',undefined,otherSession)).json()).data.image,null);
    fs.utimesSync(clean.localPathOf(first),new Date(0),new Date(0));clean.cleanupOrphanFiles();assert(fs.existsSync(clean.localPathOf(first)));
  });
  await test('stale uploads roll back files; replacement and restore clean only unreferenced images',async()=>{
    const dir=path.dirname(clean.localPathOf(first)),before=fs.readdirSync(dir);
    assert.equal((await call('profile/avatar','POST',upload(2))).status,409);assert.deepEqual(fs.readdirSync(dir),before);
    assert.equal((await call('profile/avatar','POST',upload(3))).status,200);assert.equal(fs.existsSync(clean.localPathOf(first)),false);
    const second=agent.feedAgentProfile(user.id).image;
    await call('profile','PUT',{resetAvatar:true,revision:4});assert.equal(agent.feedAgentProfile(user.id).image,null);assert.equal(fs.existsSync(clean.localPathOf(second)),false);
    assert.equal(generation.feedSnapshot(user.id).capabilities.avatar.image,'/uploads/feature/feed/alcor.png');
  });
  await test('native read/write scopes and post-body revocation also guard profile uploads',async()=>{
    const read=connect('portfolio.read feed.read'),write=connect('portfolio.read feed.read feed.write');
    assert.equal((await bearerCall('profile','GET',undefined,read.access_token)).status,200);
    assert.equal((await bearerCall('jobs','GET',undefined,read.access_token)).status,200);
    assert.equal((await bearerCall('profile','PUT',{name:'unauthorized',revision:5},read.access_token)).status,401);
    assert.equal((await bearerCall('profile/avatar','POST',upload(5),read.access_token)).status,401);
    const bodies=load('lib/requestBody.ts'),original=bodies.readFormBody;
    bodies.readFormBody=async(...args)=>{const form=await original(...args);native.revokeAppGrant(write.grant_id);return form;};
    try{assert.equal((await bearerCall('profile/avatar','POST',upload(5),write.access_token)).status,401);}finally{bodies.readFormBody=original;}
    assert.equal(agent.feedAgentProfile(user.id).revision,5);assert.equal(agent.feedAgentProfile(user.id).image,null);
  });
  await test('history has stable keyset pagination, group/owner boundaries and no private prompts',async()=>{
    db.prepare("UPDATE feed_jobs SET status='done' WHERE user_id=?").run(user.id);
    const otherGroup=store.createFeedGroup(user.id,{name:'Other'});
    store.saveFeedPreferences(user.id,{instructions:'other private',revision:0},otherGroup.id);
    const groupJob=store.createFeedJob(user.id,otherGroup.id).job;db.prepare("UPDATE feed_jobs SET status='done' WHERE id=?").run(groupJob.id);
    for(let i=0;i<65;i++){const job=store.createFeedJob(user.id).job;db.prepare("UPDATE feed_jobs SET status='done',created_at='2026-10-01T10:00:00.000Z' WHERE id=?").run(job.id);}
    const firstPage=agent.feedAgentJobs(user.id),secondPage=agent.feedAgentJobs(user.id,'default',firstPage.nextCursor),thirdPage=agent.feedAgentJobs(user.id,'default',secondPage.nextCursor);
    assert.equal(firstPage.jobs.length,30);assert.equal(secondPage.jobs.length,30);assert.equal(thirdPage.jobs.length,6);
    assert.equal(new Set([...firstPage.jobs,...secondPage.jobs,...thirdPage.jobs].map(j=>j.id)).size,66);assert.equal(thirdPage.nextCursor,null);
    assert.equal(JSON.stringify(firstPage).includes('private'),false);assert(firstPage.jobs.every(job=>job.groupId==='default'&&!('instructions' in job)));
    assert.deepEqual(agent.feedAgentJobs(other.id).jobs,[]);assert.throws(()=>agent.feedAgentJobs(other.id,otherGroup.id),/不存在/);
    assert.equal(agent.feedAgentJobs(user.id,otherGroup.id).jobs.length,1);
    assert.equal((await call('jobs?cursor=bad')).status,400);
    assert.equal((await call('jobs?group='+otherGroup.id,'GET',undefined,otherSession)).status,404);
  });
  await test('profile renders bounded local portrait, escaped name, real job and unique controls before effects',()=>{
    const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),panel=load('components/FeedAgentPanel.tsx'),data=generation.feedSnapshot(user.id);
    data.agent.name='<script>name</script>';
    const html=renderToStaticMarkup(React.createElement(panel.default,{data,tab:'activity',onTabChange(){},onClose(){},onProfileChange(){},onRefresh(){},refreshDisabled:false}));
    assert(html.includes('&lt;script&gt;name&lt;/script&gt;'));assert(!html.includes('<script>name'));
    assert(html.includes('role="dialog"'));assert(html.includes('width:100%;height:100%;object-fit:cover;border-radius:50%'));
    assert(html.includes('编辑小人')&&html.includes('更新记录')&&html.includes('完成动态更新'));
    assert.equal((html.match(/aria-label="(?:更新记录|关注来源|运行状态|更新计划|名称与形象)"/g)||[]).length,6);
    const timezone=process.env.TZ;
    try{process.env.TZ='UTC';const utc=renderToStaticMarkup(React.createElement(panel.default,{data,tab:'activity',onTabChange(){},onClose(){},onProfileChange(){},onRefresh(){},refreshDisabled:false}));process.env.TZ='America/Los_Angeles';const west=renderToStaticMarkup(React.createElement(panel.default,{data,tab:'activity',onTabChange(){},onClose(){},onProfileChange(){},onRefresh(){},refreshDisabled:false}));assert.equal(utc,west,'container/browser timezone cannot alter first-frame dates or groups');}finally{if(timezone===undefined)delete process.env.TZ;else process.env.TZ=timezone;}
    assert.equal(panel.validFeedAgentTab('invalid'),'activity');assert.equal(panel.validFeedAgentTab('schedule'),'schedule');
  });
  console.log(`${count} feed agent regression groups passed`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{db.close();process.chdir(root);fs.rmSync(temp,{recursive:true,force:true});});
