// Component interactions with a disposable hook harness and mocked API; no browser/account writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,file);
const original={useState:React.useState,useRef:React.useRef,useEffect:React.useEffect,fetch:global.fetch};
let index=0,cells=[],effects=[];
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
  const body=init.body?JSON.parse(init.body):undefined;calls.push({url,method:init.method,body});
  if(init.method==='GET')return Response.json({code:0,data:profile});
  if(body.revision!==profile.revision)return Response.json({code:40901,message:'名称已在另一端修改'},{status:409});
  profile={...profile,name:body.name,revision:profile.revision+1};return Response.json({code:0,data:profile});
};
(async()=>{
  render();button('名称Alcor').props.onClick();render();
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
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{Object.assign(React,{useState:original.useState,useRef:original.useRef,useEffect:original.useEffect});global.fetch=original.fetch;});
