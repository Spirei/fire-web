// Component interactions with a disposable hook harness and mocked API; no browser/account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
const original={useState:React.useState,useRef:React.useRef,useEffect:React.useEffect,fetch:global.fetch,document:global.document,createObjectURL:URL.createObjectURL,revokeObjectURL:URL.revokeObjectURL};
let index=0,cells=[],effects=[],blobId=0,revoked=[];
const listeners=new Map();
global.document={addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);}};
URL.createObjectURL=()=>`blob:preview-${++blobId}`;URL.revokeObjectURL=url=>revoked.push(url);
React.useState=initial=>{const i=index++;cells[i]??={value:typeof initial==='function'?initial():initial};return [cells[i].value,value=>{cells[i].value=typeof value==='function'?value(cells[i].value):value;}];};
React.useRef=initial=>{const i=index++;cells[i]??={value:{current:initial}};return cells[i].value;};
React.useEffect=(fn,deps)=>{const i=index++,previous=cells[i];if(!previous||!deps||deps.some((value,j)=>!Object.is(value,previous.deps?.[j]))){cells[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{cells[i].cleanup?.();cells[i].cleanup=fn();});}};
const Panel=require('../components/FeedAgentPanel.tsx').default;
let tree,calls=[],profile={name:'Alcor',image:null,revision:3,updatedAt:null};
const data={agent:profile,preferences:{instructions:'',revision:1,enabled:true,intervalMinutes:5,updatedAt:null},job:null,group:{id:'default',mode:'people'},capabilities:{generate:false,search:'news-rss',avatar:{image:'',video:null}}};
const props={data,tab:'identity',onTabChange(){},onClose(){},onProfileChange(value){data.agent=value;},onRefresh(){},refreshDisabled:false};
function render(){index=0;effects=[];tree=Panel(props);effects.forEach(effect=>effect());index=0;effects=[];tree=Panel(props);return tree;}
function nodes(node=tree){if(!node||typeof node!=='object')return [];return [node,...React.Children.toArray(node.props?.children).flatMap(child=>nodes(child))];}
function text(node){if(typeof node==='string')return node;if(!node||typeof node!=='object')return '';return React.Children.toArray(node.props?.children).map(text).join('');}
function button(label){const result=nodes().find(node=>node.type==='button'&&text(node)===label);assert(result,'button '+label);return result;}
async function settle(){for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));render();}
global.fetch=async(url,init)=>{
  const body=init.body instanceof FormData?init.body:init.body?JSON.parse(init.body):undefined;calls.push({url,method:init.method,body});
  if(init.method==='GET')return Response.json({code:0,data:profile});
  if(Number(body instanceof FormData?body.get('revision'):body.revision)!==profile.revision)return Response.json({code:40901,message:'名称已在另一端修改'},{status:409});
  profile={...profile,...(body instanceof FormData?{image:'/uploads/avatar/1/agent-new.png'}:body.resetAvatar?{image:null}:{name:body.name}),revision:profile.revision+1};return Response.json({code:0,data:profile});
};
(async()=>{
  render();button('名称Alcor').props.onClick();render();assert.equal(button('保存').props.disabled,true);nodes().find(node=>node.type==='form').props.onSubmit({preventDefault(){}});assert.equal(calls.length,0,'unchanged names cannot write');
  nodes().find(node=>node.type==='input').props.onChange({target:{value:'我的草稿'}});render();
  profile={...profile,name:'另一端名称',revision:5};data.agent=profile;render();
  assert.equal(nodes().find(node=>node.type==='input').props.value,'我的草稿','background data cannot replace an active draft');
  nodes().find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert.equal(calls[0].body.revision,3,'save uses the revision captured when editing opened');
  assert.equal(calls[0].body.name,'我的草稿');assert.equal(button('保存').props.disabled,true);
  button('重新读取').props.onClick();await settle();
  assert.equal(nodes().find(node=>node.type==='input').props.value,'我的草稿','explicit reread preserves intended name');
  assert.equal(button('保存').props.disabled,false);
  nodes().find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();
  assert.equal(calls[2].body.revision,5);assert.equal(profile.name,'我的草稿');assert.equal(profile.revision,6);
  console.log('PASS profile polling preserves drafts and captured revisions; explicit reread recovers conflict without replay');
  function cleanup(){cells.forEach(cell=>cell?.cleanup?.());cells=[];effects=[];calls=[];listeners.clear();}
  function fileInput(){return nodes().find(node=>node.type==='input'&&node.props.type==='file');}
  function preview(){return nodes().find(node=>node.type==='img'&&node.props.alt.endsWith('形象预览'));}
  function choose(file){fileInput().props.onChange({target:{files:[file],value:'selected'}});render();}
  const {File}=require('node:buffer');
  cleanup();profile={name:'Alcor',image:'/uploads/avatar/1/agent-old.png',revision:7,updatedAt:null};data.agent=profile;render();
  button('虚拟形象自定义形象').props.onClick();render();button('默认形象').props.onClick();render();
  assert.equal(calls.length,0,'default selection only stages a preview');assert.equal(button('保存').props.disabled,false);
  button('取消').props.onClick();render();assert.equal(data.agent.image,'/uploads/avatar/1/agent-old.png');assert.equal(calls.length,0);
  button('虚拟形象自定义形象').props.onClick();render();
  choose(new File(['x'],'bad.svg',{type:'image/svg+xml'}));assert.equal(preview(),undefined);assert.equal(calls.length,0);
  choose(new File([Buffer.alloc(2*1024*1024+1)],'large.png',{type:'image/png'}));assert.equal(preview(),undefined);
  choose(new File(['png'],'avatar.png',{type:'image/png'}));const draftUrl=preview().props.src;
  assert.equal(calls.length,0,'choosing an image cannot upload');assert.equal(button('保存').props.disabled,true,'decode must succeed first');
  preview().props.onLoad();render();assert.equal(button('保存').props.disabled,false);
  profile={...profile,revision:8};data.agent=profile;render();assert.equal(preview().props.src,draftUrl,'polling preserves the avatar draft');
  const save=button('保存');save.props.onClick();save.props.onClick();await settle();
  assert.equal(calls.length,1,'two fast clicks send exactly one upload');assert(calls[0].body instanceof FormData);assert.equal(calls[0].body.get('revision'),'7');
  assert.equal(preview().props.src,draftUrl);assert.equal(button('保存').props.disabled,true);
  button('重新读取').props.onClick();await settle();assert.equal(preview().props.src,draftUrl,'conflict reread preserves selected file');
  button('保存').props.onClick();await settle();assert.equal(calls[2].body.get('revision'),'8');assert.equal(calls[2].body.get('file').name,'avatar.png');assert.equal(profile.revision,9);assert(revoked.includes(draftUrl),'saved preview is released');
  button('虚拟形象自定义形象').props.onClick();render();choose(new File(['one'],'one.png',{type:'image/png'}));const obsolete=preview();
  choose(new File(['two'],'two.png',{type:'image/png'}));const replacement=preview();assert(revoked.includes(obsolete.props.src));
  obsolete.props.onError();render();assert.equal(nodes().filter(node=>node.props?.role==='alert').length,0,'stale image failure cannot poison current draft');
  replacement.props.onError();render();assert.equal(button('保存').props.disabled,true);assert.equal(preview(),undefined,'bad image falls back without a broken portrait');
  choose(new File(['three'],'three.png',{type:'image/png'}));const canceled=preview().props.src,priorCalls=calls.length;
  for(const listener of listeners.get('keydown'))listener({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});render();
  assert.equal(fileInput(),undefined);assert(revoked.includes(canceled));assert.equal(calls.length,priorCalls,'Escape cancels without a write');
  console.log('PASS avatar preview, explicit save/cancel, decode/size/type guards, upload lock, draft conflict recovery and object URL cleanup');

  cleanup();props.tab='activity';data.group={id:'group-a',mode:'people'};data.job=null;const pending=[];
  global.fetch=(url,init)=>{calls.push({url,method:init.method});return new Promise(resolve=>pending.push({url,resolve}));};
  const job=(id)=>({id,status:'done',added:1,error:null,createdAt:'2026-10-02T09:00:00.000Z',updatedAt:'2026-10-02T09:00:00.000Z',revision:0});
  const page=(ids,nextCursor=null)=>Response.json({code:0,data:{jobs:ids.map(job),nextCursor}});
  render();data.group={id:'group-b',mode:'people'};render();assert.equal(pending.length,2);
  pending[1].resolve(page(['b-current'],'older-b'));await settle();pending[0].resolve(page(['a-obsolete']));await settle();
  assert.equal(nodes().filter(node=>node.type==='article').length,1);assert.equal(calls.length,2);
  const older=button('查看更早记录');older.props.onClick();older.props.onClick();assert.equal(pending.length,3,'older requests lock synchronously');
  data.group={id:'group-c',mode:'people'};render();assert.equal(nodes().filter(node=>node.type==='article').length,0,'old group is hidden before the new read finishes');
  pending[2].resolve(page(['b-older']));pending[3].resolve(page(['c-current']));await settle();
  assert.equal(nodes().filter(node=>node.type==='article').length,1);assert(nodes().some(node=>node.type===React.Fragment&&node.key.includes('c-current')),'only the current group response is rendered');
  assert(!nodes().some(node=>node.type==='button'&&text(node)==='查看更早记录'));
  cleanup();console.log('PASS history ignores canceled groups and duplicate older clicks; new group replaces prior records');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{cells.forEach(cell=>cell?.cleanup?.());Object.assign(React,{useState:original.useState,useRef:original.useRef,useEffect:original.useEffect});global.fetch=original.fetch;global.document=original.document;URL.createObjectURL=original.createObjectURL;URL.revokeObjectURL=original.revokeObjectURL;});
