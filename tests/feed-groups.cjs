// Run the actual parent and keyed group views with delayed, read-only fixture requests.
module.exports=async function checkGroupSwitches(snapshot) {
  const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),file=path.resolve(__dirname,'../components/views/FeedView.tsx');
  const client=require('../lib/feedClient.ts'),originalLoad=Module._load,requests=[],pending=[],parents=[],seen=new Map();
  let hooks=parents,cursor=0,query=new URLSearchParams(),mounted=null,parentTree,tree,locationActive=true;
  const historyWrites=[];
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
  const hookReact={...React,
    useState(initial){const target=hooks,index=cursor++;if(!target[index])target[index]={value:typeof initial==='function'?initial():initial};if(!target[index].set)target[index].set=value=>{target[index].value=typeof value==='function'?value(target[index].value):value;};return [target[index].value,target[index].set];},
    useRef(initial){const index=cursor++;if(!hooks[index])hooks[index]={current:initial};return hooks[index];},
    useCallback(fn,deps){const index=cursor++,previous=hooks[index];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps[i])))hooks[index]={deps,fn};return hooks[index].fn;},
    useMemo(fn,deps){const index=cursor++,previous=hooks[index];if(!previous||deps.some((v,i)=>!Object.is(v,previous.deps[i])))hooks[index]={deps,value:fn()};return hooks[index].value;},
    useEffect(fn,deps){const target=hooks,index=cursor++,previous=target[index];if(!previous||!deps||deps.some((v,i)=>!Object.is(v,previous.deps?.[i]))){target[index]={deps,cleanup:previous?.cleanup};pending.push(()=>{target[index].cleanup?.();target[index].cleanup=fn();});}}
  };
  Module._load=function(id,parent,...rest){
    if(parent?.filename===file){
      if(id==='react')return hookReact;
      if(id==='next/navigation')return {useRouter:()=>({replace(){}})};
      if(id==='@/lib/workspacePanel')return {useWorkspaceLocationGuard:()=>()=>locationActive,useWorkspaceSearchParams:()=>query};
      if(id==='@/lib/usePersistedState')return {usePersistedState:(key,initial)=>[seen.get(key)||initial,value=>{seen.set(key,typeof value==='function'?value(seen.get(key)||initial):value);} ]};
      if(id==='@/lib/panelVisibility')return {panelIsShown:()=>true,observePanelVisibility:()=>()=>{}};
      if(id==='@/lib/toast')return {showToast(){}};
      if(id==='@/lib/feedClient')return {...client,feedRequest:(url,method,body,signal)=>new Promise((resolve,reject)=>requests.push({url,method,body,signal,resolve,reject}))};
    }
    return originalLoad.call(this,id,parent,...rest);
  };
  let Parent,Group;
  try{
    const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));
    compiled._compile(ts.transpileModule(fs.readFileSync(file,'utf8')+'\nexport { GroupFeedView };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);
    Parent=compiled.exports.default;Group=compiled.exports.GroupFeedView;
  }finally{Module._load=originalLoad;}
  const saved={document:global.document,window:global.window,matchMedia:global.matchMedia},events={addEventListener(){},removeEventListener(){}};
  global.document={...events,hidden:false};global.window={...events,history:{replaceState(state,unused,url){historyWrites.push({state,url});global.window.location.href=new URL(url,global.window.location.href).href;}},location:{href:'https://groups.test.example/trading?keep=1#feed'}};global.matchMedia=()=>({...events,matches:true});
  const groups=[{id:'default',name:'美国动态',mode:'news',people:[],revision:1,subscriptions:[],updatedAt:null},{...snapshot.group,name:'名人动态'}];
  const newsPost={...snapshot.posts[0],id:'fixture-news',title:'美国测试动态',original:undefined,segments:[{text:'美国新闻正文'}],sources:[],media:[]};
  const news={...snapshot,group:groups[0],groups,posts:[newsPost],nextCursor:null,job:null};
  const people={...snapshot,group:groups[1],groups,posts:snapshot.posts.slice(0,10),nextCursor:'fixture-second-page',job:null};
  const effects=()=>{while(pending.length)pending.shift()();};
  const settle=async()=>{await Promise.resolve();await Promise.resolve();};
  const render=(group='default',author='')=>{
    query=new URLSearchParams({...group==='default'?{}:{feedGroup:group},...author?{feedPerson:author}:{}});
    hooks=parents;cursor=0;parentTree=Parent({initial:news,initialNow:Date.now()});
    const node=nodes(parentTree).find(node=>node.type===Group);
    if(mounted?.key!==node.key){for(const slot of mounted?.hooks||[])slot?.cleanup?.();mounted={key:node.key,hooks:[]};}
    hooks=mounted.hooks;cursor=0;tree=Group(node.props);cursor=0;tree=Group(node.props);return renderToStaticMarkup(tree);
  };
  const button=name=>nodes(tree).find(node=>node.type==='button'&&node.props.children===name);
  try{
    let html=render();assert(html.includes('美国测试动态'));effects();
    button('名人动态').props.onClick();assert.equal(historyWrites.at(-1).state,null);assert.equal(historyWrites.at(-1).url,`/trading?keep=1&feedGroup=${groups[1].id}#feed`,'view switches retain URL state without a server navigation');
    button('美国动态').props.onClick();assert.equal(historyWrites.at(-1).url,'/trading?keep=1#feed','a rapid reversal uses the live URL before React catches up');button('名人动态').props.onClick();
    nodes(parentTree).find(node=>node.type?.name==='Mascot').props.onClick();assert(historyWrites.at(-1).url.includes(`feedGroup=${groups[1].id}`),'opening the profile preserves a just-selected group');assert(historyWrites.at(-1).url.endsWith('#feed'));
    locationActive=false;const writes=historyWrites.length;button('名人动态').props.onClick();assert.equal(historyWrites.length,writes,'a hidden workspace cannot rewrite the visible page URL');locationActive=true;
    const mascot=nodes(parentTree).find(node=>node.type?.name==='Mascot');
    html=render(groups[1].id);assert(html.includes('<h1>名人动态</h1>'));assert(html.includes('动态信息组'));assert(html.includes('全部动态'));assert(html.includes('正在加载动态'));assert(!html.includes('美国新闻正文'));effects();
    const latePeople=requests.at(-1);assert(latePeople.url.includes('group='+groups[1].id));
    html=render();assert(html.includes('美国测试动态'));assert(!html.includes('正在加载动态'));effects();assert(latePeople.signal.aborted);
    latePeople.resolve(people);await settle();html=render();effects();assert(!html.includes('特朗普的原帖'));
    const updated={...news,posts:[{...newsPost,title:'美国已同步动态'}]};requests.at(-1).resolve(updated);await settle();html=render();effects();assert(html.includes('美国已同步动态'));
    html=render(groups[1].id);effects();requests.at(-1).resolve(people);await settle();html=render(groups[1].id);effects();assert(html.includes('特朗普的原帖'));
    button('查看更早动态').props.onClick();const older=requests.at(-1);assert(older.url.includes('cursor=fixture-second-page'));
    older.resolve({...people,posts:snapshot.posts.slice(10,16),nextCursor:null});await settle();html=render(groups[1].id);effects();assert.equal(nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost').length,16);
    html=render();assert(html.includes('美国已同步动态'));assert(!html.includes('正在加载动态'));effects();
    html=render(groups[1].id);assert(!html.includes('正在加载动态'));assert.equal(nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost').length,16);effects();assert(requests.at(-1).url.includes('limit=16'),'restoring a group revalidates its expanded range');
    const count=requests.length;for(let i=0;i<4;i++){render(groups[1].id);effects();}assert.equal(requests.length,count,'snapshot publication must not create a read loop');
    requests.at(-1).reject(new client.FeedRequestError('background unavailable'));await settle();html=render(groups[1].id);effects();assert(html.includes('特朗普的原帖'));assert(!html.includes('正在加载动态'));assert(!html.includes('background unavailable'));
    const stableMascot=nodes(parentTree).find(node=>node.type?.name==='Mascot');assert.equal(stableMascot.type,mascot.type);assert.equal(stableMascot.key,mascot.key);assert.equal(stableMascot.props.image,mascot.props.image);
    const card=nodes(tree).find(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost'),liked=card.props.post.liked;card.props.onLike(card.props.post);
    const pendingLike=requests.at(-1);render(groups[1].id);effects();render();effects();render(groups[1].id);effects();
    html=render(groups[1].id);assert(html.includes('正在加载动态'),'a write invalidates stale group snapshots before a return');assert(!html.includes('特朗普的原帖'),'an optimistic write is never cached');
    pendingLike.resolve({...card.props.post,liked:!liked});await settle();requests.at(-1).resolve({...people,posts:snapshot.posts.slice(0,16)});await settle();render(groups[1].id);effects();
    render();effects();html=render(groups[1].id,'duan');effects();assert(html.includes('正在加载动态'));assert(!html.includes('特朗普的原帖'),'another author cannot inherit a cached group timeline');
    requests.at(-1).resolve({...people,posts:snapshot.posts.filter(post=>post.original.person.id==='duan').slice(0,10),nextCursor:null});await settle();render(groups[1].id,'duan');effects();
    render();effects();html=render(groups[1].id);effects();assert(!html.includes('正在加载动态'));assert.equal(nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost').length,16,'a filtered view must not overwrite the cached all-person timeline');
    html=render(groups[1].id,'duan');assert(html.includes('段永平的原帖'));assert(!html.includes('正在加载动态'),'a visited author restores before committing a skeleton');effects();const lateAuthor=requests.at(-1);
    html=render(groups[1].id);assert(!html.includes('正在加载动态'));assert.equal(nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost').length,16);effects();assert(lateAuthor.signal.aborted);
    const cards=nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost');
    const refreshed={...people,posts:JSON.parse(JSON.stringify(snapshot.posts.slice(0,16)))};requests.at(-1).resolve(refreshed);await settle();render(groups[1].id);effects();
    const stableCards=nodes(tree).filter(node=>(node.type?.name||node.type?.type?.name)==='FeedOriginalPost');
    assert.equal(stableCards[0].props.post,cards[0].props.post,'unchanged checks reuse card content');assert.equal(stableCards[0].props.onLike,cards[0].props.onLike,'card actions remain stable across quiet checks');
    lateAuthor.resolve({...people,posts:[]});await settle();html=render(groups[1].id);effects();assert(!html.includes('feed-empty'));
    console.log('PASS visited authors restore immediately, keep expanded ranges and stable cards, and reject superseded reads');
    console.log('PASS group switches preserve navigation and mascot, restore expanded posts, revalidate quietly, and reject late/cross-author results');
  }finally{
    for(const slot of mounted?.hooks||[])slot?.cleanup?.();for(const slot of parents)slot?.cleanup?.();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}
  }
};
