// Shared UI contracts only. No requests, account changes or business writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const root=path.resolve(__dirname,'..'),resolve=Module._resolveFilename;
Module._resolveFilename=function(id,parent,...rest){return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest);};
for(const ext of ['.ts','.tsx'])require.extensions[ext]=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,f);
const {Capsule,IconButton,CloseButton,CapsuleLink}=require('../components/Capsule.tsx');
const html=(Type,props)=>renderToStaticMarkup(React.createElement(Type,props));
let s=html(Capsule,{busy:true,children:'保存'});assert(s.includes('type="button"')&&s.includes('disabled=""')&&s.includes('aria-busy="true"'));
s=html(Capsule,{variant:'secondary',selected:true,type:'submit',children:'美股'});assert(s.includes('aria-pressed="true"')&&s.includes('data-capsule-variant="secondary"')&&s.includes('type="submit"'));
assert(html(Capsule,{variant:'danger',children:'删除'}).includes('data-capsule-variant="danger"'));
s=html(IconButton,{label:'编辑此用户',title:'编辑资料',busy:true,children:React.createElement('svg')});assert(s.includes('aria-label="编辑此用户"')&&s.includes('title="编辑资料"')&&s.includes('disabled=""'));
assert(html(CloseButton,{}).includes('aria-label="关闭"'));
assert(html(CapsuleLink,{href:'/login',children:'登录'}).includes('href="/login"'));
console.log('PASS shared controls retain native form actions, selected labels, busy locks and accessible icon titles');
const original=global.document;
try{
const {trapModalTab}=require('../lib/overlayLifecycle.ts');let active;
const make=()=>({tabIndex:0,closest:()=>null,getAttribute:()=>null,getClientRects:()=>[{}],focus(){active=this;}}),first=make(),last=make(),hidden={...make(),getClientRects:()=>[]};
const panel={querySelectorAll:()=>[first,hidden,last],contains:n=>[panel,first,last].includes(n),focus(){active=panel;}};
global.document={get activeElement(){return active;}};
const press=shift=>{let prevented=false;trapModalTab({key:'Tab',shiftKey:shift,preventDefault(){prevented=true;}},panel);return prevented;};
active=last;assert(press(false)&&active===first);active=first;assert(press(true)&&active===last);active=panel;assert(press(true)&&active===last);active=first;assert(!press(false));panel.querySelectorAll=()=>[];active=last;assert(press(false)&&active===panel);
console.log('PASS modal focus wraps both directions, ignores hidden controls and supports empty dialogs');
}finally{global.document=original;}
const roots=fs.readdirSync(path.join(root,'components/views')).filter(f=>f.endsWith('.tsx'));
const known=new Set(['Capsule','AppModal','AppSelect','Pagination','RefreshButton','CollectionToolbar']);
function shared(file,seen=new Set()){if(seen.has(file)||!fs.existsSync(file))return false;seen.add(file);const source=fs.readFileSync(file,'utf8');if([...known].some(name=>source.includes(`@/components/${name}`)))return true;return [...source.matchAll(/from ["'](@\/components\/[^"']+)["']/g)].some(m=>shared(path.join(root,m[1].slice(2)+'.tsx'),seen));}
for(const f of roots)assert(shared(path.join(root,'components/views',f)),f+' delegates controls to shared components');
for(const f of ['VersionModal','LoginModal','FundEntryDialog','CelebsManageModal'])assert(fs.readFileSync(path.join(root,'components',f+'.tsx'),'utf8').includes('import AppModal'),f+' uses the common modal');
const capsuleCss=fs.readFileSync(path.join(root,'styles/capsules.css'),'utf8');assert(capsuleCss.includes('.capsule-control[data-capsule-variant="primary"]:is([data-selected="true"],[aria-current="page"]) { background:var(--capsule-hover)'),'current filled page must remain visually distinct');
const css=fs.readFileSync(path.join(root,'app/globals.css'),'utf8');assert(css.includes('.app-modal-body')&&css.includes('100dvh - 2 * var(--modal-gutter)'));
console.log('PASS all '+roots.length+' workspace views reach shared controls; migrated dialogs share the bounded modal frame');
const DeleteIcon=require('../components/DeleteIcon.tsx').default;
const trash=html(DeleteIcon,{size:16});
assert(trash.includes('<svg')&&!trash.includes('<img')&&!trash.includes('/icons/'),'deletion never depends on mounted files');

const Avatar=require('../components/Avatar.tsx').default;
const avatar=html(Avatar,{name:'Synthetic',size:24});assert(avatar.includes('flex:0 0 24px')&&avatar.includes('max-width:24px')&&avatar.includes('aspect-ratio:1'),'placeholder and image avatars retain square dimensions');

const AppSelect=require('../components/AppSelect.tsx').default;
const selectProps={value:5,options:[{value:'5',label:'五秒',swatch:'#123456'}],onChange(){},ariaLabel:'刷新间隔',className:'original-trigger',menuClassName:'original-menu'};
const selectHtml=html(AppSelect,selectProps);
assert(selectHtml.includes('五秒')&&selectHtml.includes('original-trigger')&&selectHtml.includes('app-select-swatch')&&selectHtml.includes('aria-expanded="false"'));
assert(!selectHtml.includes('role="listbox"'),'server render contains no hidden menu tree');
assert(html(AppSelect,{...selectProps,disabled:true}).includes('disabled=""'));
assert(html(AppSelect,{...selectProps,triggerContent:React.createElement('span',null,'自定义')}).includes('自定义'));
assert(html(AppSelect,{...selectProps,value:'unlisted'}).includes('unlisted'));
console.log('PASS select SSR preserves numeric values, labels, swatches, custom content, missing-value fallback and caller classes with the shared trigger');

const ServiceIcon=require('../components/ServiceIcon.tsx').default;
for(const kind of ['postgresql','redis','worker','broker','quotes','fx','earnings']) assert(html(ServiceIcon,{kind}).includes('data-kind="'+kind+'"'));
const StatusIndicator=require('../components/StatusIndicator.tsx').default;
assert(html(StatusIndicator,{state:'unknown'}).includes('未检测'));
assert(html(StatusIndicator,{state:'up'}).includes('已连接'));
assert(html(StatusIndicator,{state:'down'}).includes('连接失败'));
console.log('PASS service identity colors stay independent of truthful connection state');

// Read the real state text colors against every supported palette.
const palettes=require('../lib/palettes.ts').SITE_PALETTES;
const rgb=hex=>hex.replace('#','').match(/../g).map(v=>parseInt(v,16));
const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
for(const mode of ['light','dark'])for(const palette of palettes){
 const bg=rgb(palette[mode][0]);
 for(const state of ['up','down','warning']){
  const selector=(mode==='dark'?'.dark ':'')+`.interface-check-card[data-state=${state}] .interface-check-samples strong{color:`;
  const at=css.indexOf(selector);assert(at>=0,selector);const color=rgb(css.slice(at+selector.length).match(/^#[\da-f]{6}/)[0]);
  assert(contrast(color,bg)>=4.5,`${palette.id} ${mode} ${state} text contrast`);
 }
}
console.log('PASS detector state text remains readable in every light and dark palette');
