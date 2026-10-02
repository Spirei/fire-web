// Exercise browser media lifecycle with fake players; no real account or preferences change.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const file=path.resolve('components/FeedAgentPortrait.tsx'),originalLoad=Module._load;
let cells=[],effects=[],cursor=0,tree,media,observer,players=[],listeners=new Set();
const hookReact={...React,
  useState(initial){const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};return [cells[i].value,value=>{cells[i].value=typeof value==='function'?value(cells[i].value):value;}];},
  useRef(initial){const i=cursor++;cells[i]??={current:initial};return cells[i];},
  useEffect(fn,deps){const i=cursor++,old=cells[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){cells[i]={deps,cleanup:old?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=fn();});}}
};
Module._load=function(id,parent,...args){if(parent?.filename===file){if(id==='react')return hookReact;if(id==='./SafeAssetImage')return ()=>null;}return originalLoad.call(this,id,parent,...args);};
const compiled=new Module(file,module);compiled.filename=file;compiled.paths=Module._nodeModulePaths(path.dirname(file));
try{compiled._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);}finally{Module._load=originalLoad;}
const saved={document:global.document,matchMedia:global.matchMedia,IntersectionObserver:global.IntersectionObserver};
global.document={hidden:false,addEventListener(_name,fn){listeners.add(fn);},removeEventListener(_name,fn){listeners.delete(fn);}};
media={matches:false,addEventListener(_name,fn){this.listener=fn;},removeEventListener(){this.listener=null;}};global.matchMedia=()=>media;
global.IntersectionObserver=class{constructor(fn){this.fn=fn;observer=this;}observe(){}disconnect(){this.disconnected=true;}};
const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
const props={image:'/local/poster.png',video:'/local/loop.mp4',name:'Alcor'};
function render(){
  cursor=0;tree=compiled.exports.default(props);
  const video=nodes(tree).find(node=>node.type==='video');
  if(!video)for(const cell of cells)if(cell?.current?.play)cell.current=null;
  if(video&&!video.props.ref.current){const player={paused:true,play(){this.paused=false;return Promise.resolve();},pause(){this.paused=true;}};video.props.ref.current=player;players.push(player);}
  for(const effect of effects.splice(0))effect();return video;
}
function cleanup(){cells.forEach(cell=>cell?.cleanup?.());cells=[];effects=[];listeners.clear();}
try{
  assert.equal(render(),undefined,'server/first render stays on the poster');let video=render(),player=players.at(-1);
  assert(video&&video.props.muted&&video.props.loop&&video.props.playsInline);assert.equal(player.paused,false);assert.equal(video.props.style.opacity,0,'poster remains until playback begins');
  video.props.onPlaying();video=render();assert.equal(video.props.style.opacity,1);
  global.document.hidden=true;listeners.forEach(fn=>fn());assert.equal(player.paused,true);
  global.document.hidden=false;listeners.forEach(fn=>fn());assert.equal(player.paused,false);
  observer.fn([{isIntersecting:false}]);assert.equal(player.paused,true);observer.fn([{isIntersecting:true}]);assert.equal(player.paused,false);
  cleanup();assert.equal(player.paused,true);assert.equal(observer.disconnected,true);assert.equal(listeners.size,0,'closing releases observers and visibility listeners');
  render();video=render();player=players.at(-1);video.props.onError();assert.equal(render(),undefined);assert.equal(player.paused,true,'failed video falls back and stops playback');cleanup();
  media.matches=true;render();assert.equal(render(),undefined,'reduced motion keeps the image');cleanup();
  media.matches=false;props.video=null;render();assert.equal(render(),undefined,'a custom image never gets the default animation');cleanup();
  props.video='/local/loop.mp4';render();video=render();player=players.at(-1);media.matches=true;media.listener();assert.equal(render(),undefined);assert.equal(player.paused,true,'changing reduced motion pauses the mounted player');cleanup();
  console.log('PASS portrait waits for playback, pauses on close/background/offscreen/reduced motion, and preserves still/custom/error fallbacks');
}finally{cleanup();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete global[key];else global[key]=value;}}
