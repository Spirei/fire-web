// Exercise the actual view with delayed reads and persistent hooks, without a live account.
module.exports=async function checkTransitions(snapshot) {
  const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const file=path.resolve(__dirname,'../components/views/FeedView.tsx');
  const client=require('../lib/feedClient.ts'),originalLoad=Module._load;
  const slots=[],pending=[],requests=[];let cursor=0,lastTree;
  let readSeen=Object.fromEntries(snapshot.peopleCatalog.map(person=>[person.id,'2000-01-01T00:00:00.000Z']));
  const persistSeen=value=>{readSeen=typeof value==='function'?value(readSeen):value;};
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
  const child=name=>nodes(lastTree).find(node=>node.type?.name===name);
  const hookReact={...React,
    useState(initial){const index=cursor++;if(!slots[index])slots[index]={value:typeof initial==='function'?initial():initial};return [slots[index].value,value=>{slots[index].value=typeof value==='function'?value(slots[index].value):value;}];},
    useRef(initial){const index=cursor++;if(!slots[index])slots[index]={current:initial};return slots[index];},
    useCallback(fn,deps){const index=cursor++,previous=slots[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i])))slots[index]={deps,fn};return slots[index].fn;},
    useEffect(fn,deps){const index=cursor++,previous=slots[index];if(!previous||!deps||deps.some((value,i)=>!Object.is(value,previous.deps?.[i]))){slots[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{slots[index].cleanup?.();slots[index].cleanup=fn();});}}
  };
  Module._load=function(id,parent,...rest){
    if(parent?.filename===file){
      if(id==='react')return hookReact;
      if(id==='next/navigation')return {useRouter:()=>({replace(){}})};
      if(id==='@/lib/workspacePanel')return {useWorkspaceSearchParams:()=>new URLSearchParams()};
      if(id==='@/lib/usePersistedState')return {usePersistedState:()=>[readSeen,persistSeen]};
      if(id==='@/lib/panelVisibility')return {panelIsShown:()=>true,observePanelVisibility:()=>()=>{}};
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
  const saved={document:global.document,window:global.window,matchMedia:global.matchMedia};
  const events={addEventListener(){},removeEventListener(){}};
  global.document={...events,hidden:false};global.window={...events,location:{href:'https://people.test.example/trading?feedPerson=trump'}};global.matchMedia=()=>({...events,matches:true});
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
    const card=child('FeedOriginalPost');card.props.onLike();const like=requests.at(-1);assert.equal(like.method,'PUT');
    html=render('trump');const before=requests.length;effects();assert.equal(requests.length,before,'switch waits for a pending write');
    like.resolve({...card.props.post,liked:true});await settle();render('trump');effects();
    assert.equal(requests.at(-1).method,'GET');assert(requests.at(-1).url.includes('author=trump'),'switch automatically resumes once the write finishes');
    requests.at(-1).resolve({...snapshot,posts:[],nextCursor:null});await settle();
    html=render('trump');assert(html.includes('feed-empty'));assert(!html.includes('正在加载动态'));
  }finally {
    for(const slot of slots)slot?.cleanup?.();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}
  }
};
