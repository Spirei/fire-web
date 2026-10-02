// Exercise the actual view with delayed reads and persistent hooks, without a live account.
module.exports=async function checkTransitions(snapshot) {
  const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const file=path.resolve(__dirname,'../components/views/FeedView.tsx');
  const client=require('../lib/feedClient.ts'),originalLoad=Module._load;
  const slots=[],pending=[],requests=[],notices=[];let cursor=0,lastTree;
  let readSeen=Object.fromEntries(snapshot.peopleCatalog.map(person=>[person.id,'2000-01-01T00:00:00.000Z']));
  const persistSeen=value=>{readSeen=typeof value==='function'?value(readSeen):value;};
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
  const child=name=>nodes(lastTree).find(node=>(node.type?.name||node.type?.type?.name)===name);
  const hookReact={...React,
    useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};if(!slots[index].set)slots[index].set=value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;};return [slots[index].value,slots[index].set];},
    useRef(initial){const index=cursor++;if(!slots[index])slots[index]={current:initial};return slots[index];},
    useCallback(fn,deps){const index=cursor++,previous=slots[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))slots[index]={deps,fn};return slots[index].fn;},
    useMemo(fn,deps){const index=cursor++,previous=slots[index];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps[i])))slots[index]={deps,value:fn()};return slots[index].value;},
    useEffect(fn,deps){const index=cursor++,previous=slots[index];if(!previous||!deps||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]))){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[index].cleanup?.();slots[index].cleanup=fn();});}}
  };
  Module._load=function(id,parent,...rest){
    if(parent?.filename===file){
      if(id==='react')return hookReact;
      if(id==='next/navigation')return {useRouter:()=>({replace(){}})};
      if(id==='@/lib/workspacePanel')return {useWorkspaceLocationGuard:()=>()=>true,useWorkspaceSearchParams:()=>new URLSearchParams()};
      if(id==='@/lib/usePersistedState')return {usePersistedState:()=>[readSeen,persistSeen]};
      if(id==='@/lib/panelVisibility')return {panelIsShown:()=>true,observePanelVisibility:()=>()=>{}};
      if(id==='@/lib/toast')return {showToast:(text,type)=>notices.push({text,type})};
      if(id==='@/lib/feedClient')return {...client,feedRequest:(url,method,body,signal)=>new Promise((resolve,reject)=>requests.push({url,method,body,signal,resolve,reject}))};
    }
    return originalLoad.call(this,id,parent,...rest);
  };
  let View;
  try {
    const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));
    compiled._compile(ts.transpileModule(fs.readFileSync(file,'utf8')+'\nexport { GroupFeedView };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);
    View=compiled.exports.GroupFeedView;
  }finally{Module._load=originalLoad;}
  const saved={document:global.document,window:global.window,matchMedia:global.matchMedia,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout};
  const events={addEventListener(){},removeEventListener(){}};
  global.document={...events,hidden:false};global.window={...events,history:{replaceState(){}},location:{href:'https://people.test.example/trading?feedPerson=trump'}};global.matchMedia=()=>({...events,matches:true});
  const render=author=>{cursor=0;lastTree=View({initial:snapshot,initialNow:Date.now(),groupId:snapshot.group.id,author});return renderToStaticMarkup(lastTree);};
  const effects=()=>{while(pending.length)pending.shift()();};
  const settle=async()=>{await Promise.resolve();await Promise.resolve();};
  const select=id=>({...snapshot,posts:snapshot.posts.filter(post=>post.original.person.id===id)});
  try {
    assert(render('trump').includes('特朗普的原帖'));effects();
    assert.equal(readSeen.trump,snapshot.peopleLatestAt.trump,'reads persist before page unload');
    assert.equal(readSeen.duan,'2000-01-01T00:00:00.000Z','an unseen author stays unread');
    render('trump');child('FeedPeopleFilter').props.onSelect('duan');
    let html=render('duan');
    assert(html.includes('正在加载动态'));assert(!html.includes('没有可显示'));assert(!html.includes('特朗普的原帖'));assert(!html.includes('查看更早动态'));
    assert(html.includes('段永平有新动态'),'choosing an author does not mark an unconfirmed read');
    effects();const duan=requests.at(-1);assert(duan.url.includes('author=duan'));
    duan.reject(new client.FeedRequestError('读取超时'));await settle();
    html=render('duan');assert(html.includes('段永平有新动态'));assert.equal(readSeen.duan,'2000-01-01T00:00:00.000Z');effects();
    html=render('trump');effects();const oldTrump=requests.at(-1);assert(oldTrump.url.includes('author=trump'));
    render('duan');effects();const lateDuan=requests.at(-1);
    render('trump');effects();const trump=requests.at(-1);assert(lateDuan.signal.aborted&&oldTrump.signal.aborted);
    trump.resolve(select('trump'));await settle();
    lateDuan.resolve(select('duan'));oldTrump.resolve(select('trump'));await settle();
    html=render('trump');assert(html.includes('特朗普的原帖'));assert(!html.includes('段永平的原帖'));assert(!html.includes('feed-empty'));effects();
    html=render('duan');assert(html.includes('正在加载动态'));effects();
    requests.at(-1).resolve(select('duan'));await settle();
    html=render('duan');assert(html.includes('段永平的原帖'));assert(!html.includes('feed-empty'));effects();
    assert.equal(readSeen.duan,snapshot.peopleLatestAt.duan);assert(!render('duan').includes('段永平有新动态'));
    const card=child('FeedOriginalPost');card.props.onLike(card.props.post);const like=requests.at(-1);assert.equal(like.method,'PUT');
    html=render('trump');const before=requests.length;effects();assert.equal(requests.length,before,'switch waits for a pending write');
    like.resolve({...card.props.post,liked:true});await settle();render('trump');effects();
    assert.equal(requests.at(-1).method,'GET');assert(requests.at(-1).url.includes('author=trump'),'switch automatically resumes once the write finishes');
    requests.at(-1).resolve({...snapshot,posts:[],nextCursor:null});await settle();
    html=render('trump');assert(html.includes('feed-empty'));assert(!html.includes('正在加载动态'));effects();
    let pollTimer;
    global.setTimeout=(fn,ms,...args)=>ms===2500?(pollTimer={fn,fake:true}):saved.setTimeout(fn,ms,...args);
    global.clearTimeout=timer=>{if(!timer?.fake)saved.clearTimeout(timer);};
    const refreshButton=()=>nodes(lastTree).find(node=>node.type==='button'&&node.props['aria-label']==='更新动态');
    const queued={id:'manual-refresh-1',revision:snapshot.preferences.revision,status:'queued',added:0,error:null,createdAt:'2026-10-02T09:00:00.000Z',updatedAt:'2026-10-02T09:00:00.000Z'};
    const beforeRefresh=requests.length;refreshButton().props.onClick();refreshButton().props.onClick();
    assert.equal(requests.length,beforeRefresh+1,'two quick clicks start one manual job');assert.equal(requests.at(-1).method,'POST');
    html=render('trump');assert(html.includes('feed-refresh-button is-working'));assert.equal(refreshButton().props['aria-busy'],true);effects();
    requests.at(-1).resolve(queued);await settle();render('trump');effects();assert.equal(notices.length,0,'enqueue is not refresh success');
    const polling=pollTimer.fn();assert(requests.at(-1).url.endsWith('/jobs/'+queued.id));
    const completed={...queued,status:'done',added:2};requests.at(-1).resolve(completed);await polling;
    assert.equal(requests.at(-1).method,'GET');assert(requests.at(-1).url.includes('?limit='));
    html=render('trump');effects();assert(html.includes('feed-refresh-button is-working'));assert.equal(notices.length,0,'job completion waits for the feed snapshot');
    requests.at(-1).resolve({...snapshot,job:completed});await settle();html=render('trump');effects();
    assert(!html.includes('feed-refresh-button is-working'));assert.equal(refreshButton().props['aria-busy'],false);assert.deepEqual(notices,[{text:'已刷新',type:'ok'}]);
    render('trump');effects();assert.equal(notices.length,1,'renders cannot repeat the success toast');
    refreshButton().props.onClick();requests.at(-1).resolve({...queued,id:'manual-superseded'});await settle();render('trump');effects();
    render('duan');effects();const newer={...queued,id:'automatic-newer',status:'searching'};
    requests.at(-1).resolve({...select('duan'),job:newer});await settle();render('duan');effects();
    const supersededPoll=pollTimer.fn();assert(requests.at(-1).url.endsWith('/jobs/manual-superseded'),'poll follows the clicked job when a newer background job appears');
    requests.at(-1).resolve({...completed,id:'manual-superseded'});await supersededPoll;
    requests.at(-1).resolve({...select('duan'),job:{...newer,status:'done'}});await settle();html=render('duan');effects();
    assert(!html.includes('feed-refresh-button is-working'));assert.deepEqual(notices.at(-1),{text:'已刷新',type:'ok'});
    refreshButton().props.onClick();requests.at(-1).resolve({...completed,id:'manual-partial',error:'some sources failed'});await settle();
    requests.at(-1).resolve({...snapshot,job:{...completed,id:'manual-partial',error:'some sources failed'}});await settle();html=render('duan');effects();
    assert(!html.includes('feed-refresh-button is-working'));assert.deepEqual(notices.at(-1),{text:'部分来源未更新',type:'err'});
    refreshButton().props.onClick();requests.at(-1).resolve({...completed,id:'manual-read-failure'});await settle();
    requests.at(-1).reject(new client.FeedRequestError('snapshot unavailable'));await settle();html=render('duan');effects();
    assert(!html.includes('feed-refresh-button is-working'));assert.deepEqual(notices.at(-1),{text:'读取刷新结果失败',type:'err'});
    const beforeBackground=notices.length;
    render('trump');effects();requests.at(-1).resolve({...select('trump'),job:{...completed,id:'automatic-refresh'}});await settle();render('trump');effects();
    assert.equal(notices.length,beforeBackground,'background completions stay silent');
    console.log('PASS manual refresh spins unchanged icon, locks clicks, waits for committed results, reports partial/read failure, and keeps background reads silent');
  }finally {
    for(const slot of slots)slot?.cleanup?.();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}
  }
};
