// Exercise the actual view with delayed reads and persistent hooks, without a live account.
module.exports=async function checkTransitions(snapshot) {
  const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const file=path.resolve(__dirname,'../components/views/FeedView.tsx');
  const client=require('../lib/feedClient.ts'),originalLoad=Module._load;
  const slots=[],pending=[],requests=[];let cursor=0;
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
      if(id==='@/lib/usePersistedState')return {usePersistedState:()=>[{},()=>{}]};
      if(id==='@/lib/panelVisibility')return {panelIsShown:()=>true,observePanelVisibility:()=>()=>{}};
      if(id==='@/lib/feedClient')return {...client,feedRequest:(url,_method,_body,signal)=>new Promise(resolve=>requests.push({url,signal,resolve}))};
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
  global.document={...events,hidden:false};global.window={...events};global.matchMedia=()=>({...events,matches:true});
  const render=author=>{cursor=0;return renderToStaticMarkup(View({initial:snapshot,initialNow:Date.now(),groupId:snapshot.group.id,author}));};
  const effects=()=>{while(pending.length)pending.shift()();};
  const settle=async()=>{await Promise.resolve();await Promise.resolve();};
  const select=id=>({...snapshot,posts:snapshot.posts.filter(post=>post.original.person.id===id)});
  try {
    assert(render('trump').includes('特朗普的原帖'));effects();
    let html=render('duan');
    assert(html.includes('正在加载动态'));assert(!html.includes('没有可显示'));assert(!html.includes('特朗普的原帖'));assert(!html.includes('查看更早动态'));
    effects();const duan=requests.at(-1);assert(duan.url.includes('author=duan'));
    html=render('trump');effects();const trump=requests.at(-1);assert(trump.url.includes('author=trump'));assert(duan.signal.aborted);
    trump.resolve(select('trump'));await settle();
    duan.resolve(select('duan'));await settle();
    html=render('trump');assert(html.includes('特朗普的原帖'));assert(!html.includes('段永平的原帖'));assert(!html.includes('feed-empty'));effects();
    html=render('duan');assert(html.includes('正在加载动态'));effects();
    requests.at(-1).resolve(select('duan'));await settle();
    html=render('duan');assert(html.includes('段永平的原帖'));assert(!html.includes('feed-empty'));effects();
    render('trump');effects();requests.at(-1).resolve({...snapshot,posts:[],nextCursor:null});await settle();
    html=render('trump');assert(html.includes('feed-empty'));assert(!html.includes('正在加载动态'));
  }finally {
    for(const slot of slots)slot?.cleanup?.();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}
  }
};
