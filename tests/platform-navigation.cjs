const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname,'..'), resolve = Module._resolveFilename, load = Module._load;
Module._resolveFilename = function(id,parent,...rest){ return resolve.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,parent,...rest); };
Module._load = function(id,parent,...rest){ if (id==='@/lib/viewPreload') return {preloadView(){}}; return load.call(this,id,parent,...rest); };
for (const ext of ['.ts','.tsx']) require.extensions[ext]=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,file);
const Navigation = require('../components/PlatformNavigation.tsx').default;
const { PrefsProvider } = require('../lib/prefsContext.tsx');
const items=[['holdings','账户资产'],['trading','动态内容'],['library','素材库'],['global','全球经济'],['users','用户管理'],['activities','日志'],['settings','设置']].map(([key,label])=>({key,label,icon:null}));
function render(rows,prefs={}){ return renderToStaticMarkup(React.createElement(PrefsProvider,{initialPrefs:prefs},React.createElement(Navigation,{items:rows,activeKey:'holdings',onSelect(){},onSettings(){},onDrop(){},onDragStart(){},onDragEnd(){}}))); }
const full=render(items);
for(const label of ['投资','动态','资源','数据','管理','系统','个人'])assert(full.includes(`aria-label="${label}"`),label);
assert.equal((full.match(/aria-expanded="false"/g)||[]).length,7);
assert(full.includes('aria-current="page"'));
const opened=render(items,{'fire:platform-navigation-expanded':{investment:true,personal:true}});
assert.equal((opened.match(/aria-expanded="true"/g)||[]).length,2,'saved state is applied in server HTML');
assert(!opened.includes('通行密钥') && !opened.includes('管理授权'));
assert(opened.includes('用户管理'));
const ordinary=render(items.filter(item=>!['users','library','activities'].includes(item.key)));
assert(!ordinary.includes('用户管理')&&!ordinary.includes('素材库'),'private destinations do not reappear after filtering');
assert(!ordinary.includes('platform-group-management'),'empty groups are absent');
const {serializePrefs,parsePrefsCookie}=require('../lib/prefsCookie.ts');
const crowded=Object.fromEntries(Array.from({length:100},(_,i)=>['fire:optional-'+i,'saved']));
const layout={investment:true,feed:false,resources:true,data:false,management:false,system:true,personal:false};
crowded['fire:platform-navigation-expanded']=layout;
crowded['fire:platform-sidebar-collapsed']=false;
crowded['fire:tablet-sidebar-collapsed']=true;
const bounded=serializePrefs(crowded), restored=parsePrefsCookie(bounded);
assert(encodeURIComponent(bounded).length<=3000);
assert.deepEqual(restored['fire:platform-navigation-expanded'],layout,'a full cookie must not evict sidebar expansion');
assert.equal(restored['fire:platform-sidebar-collapsed'],false);
assert.equal(restored['fire:tablet-sidebar-collapsed'],true);
const refresh=render(items,restored);
assert.equal((refresh.match(/aria-expanded="true"/g)||[]).length,3,'refresh server HTML already contains every saved open group');
assert(refresh.includes('aria-label="系统" aria-expanded="true"'));
assert(refresh.includes('aria-label="动态" aria-expanded="false"'),'explicit closed state is preserved');
console.log('PASS platform navigation: seven groups, cookie pressure preserves saved first frame, active destination and filtered permissions');
// Exercise the actual detail shell, including a retained child draft, under both workspace states.
const settingsSource = fs.readFileSync(path.join(root,'components/views/SettingsView.tsx'),'utf8');
const parsed = ts.createSourceFile('SettingsView.tsx',settingsSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const shell = parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='SettingsDetailShell');
const shellCode = ts.transpileModule(shell.getText(parsed)+'\nexports.Detail = SettingsDetailShell;', {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
let active = true;
const result = {};
require('node:vm').runInNewContext(shellCode,{...React,require,exports:result,useWorkspaceActive:()=>active,createPortal(){throw Error('SSR must keep the initial shell inline');},lockScroll(){return ()=>{};}});
const props = {title:'外观',category:'设置',onClose(){},children:React.createElement('input',{defaultValue:'retained draft'})};
assert(!renderToStaticMarkup(React.createElement(result.Detail,props)).includes('display:none'));
active=false;
const hidden = renderToStaticMarkup(React.createElement(result.Detail,props));
assert(hidden.includes('display:none')&&hidden.includes('aria-hidden="true"'));
assert(hidden.includes('retained draft'),'hiding the portal must retain its draft subtree');
console.log('PASS settings detail: inactive workspace hides the actual shell and retains its draft');
const navigationIcons=require('../lib/navIcons.tsx').NAV_ICONS;
for(const key of ['profile-home','palette']) assert(renderToStaticMarkup(navigationIcons[key]).includes('<svg'),key+' has a registered icon');
const searchSource=fs.readFileSync(path.join(root,'components/PlatformSidebarHeader.tsx'),'utf8');
assert(!/key: "(?:profile-home|palette)"[^\n]*icon: null/.test(searchSource));
console.log('PASS search destinations share registered profile and appearance icons');
// Exercise the actual search component's state and actions without a browser or server writes.
const previousLoad=Module._load,previousDocument=global.document,previousHTMLElement=global.HTMLElement;
let searchStates=[],searchRefs=[],stateCursor=0,refCursor=0,historyActions=[],selected=[];
const historyItems=[{id:'one',query:'外观'},{id:'two',query:'市场色块'}];
Module._load=function(id,parent,...rest){
 if(parent?.filename.endsWith('/components/PlatformSidebarHeader.tsx')){
  if(id==='react')return {...React,useState(initial){const i=stateCursor++;if(!(i in searchStates))searchStates[i]=initial;return[searchStates[i],v=>{searchStates[i]=typeof v==='function'?v(searchStates[i]):v;}];},useRef(initial){const i=refCursor++;return searchRefs[i]??=( {current:initial});},useId:()=>':search:',useEffect(){}};
  if(id==='react-dom')return{createPortal:child=>child};
  if(id==='@/lib/useSearchHistory')return{useSearchHistory:()=>({items:historyItems,error:'',loading:false,busy:false,record:q=>historyActions.push(['record',q]),remove:id=>historyActions.push(['remove',id]),clear:()=>historyActions.push(['clear']),refresh(){}})};
 }
 return previousLoad.call(this,id,parent,...rest);
};
global.document={body:{},activeElement:null};global.HTMLElement=class{};
try{
 const Search=require('../components/PlatformSidebarHeader.tsx').default;
 const props={collapsed:false,onToggle(){},ownerId:'fixture',admin:true,items:[{key:'users',label:'用户管理',icon:navigationIcons.users}],onSelect:key=>selected.push(key),onSettings:(sub,anchor)=>selected.push([sub,anchor])};
 const flatten=node=>Array.isArray(node)?node.flatMap(flatten):node&&typeof node==='object'?[node,...flatten(node.props?.children)]:[];
 const view=(extra={})=>{stateCursor=0;refCursor=0;return flatten(Search({...props,...extra}));};
 let tree=view();tree.find(n=>n.props?.['aria-label']==='搜索功能').props.onClick();tree=view();
 assert(!tree.some(n=>n.props?.className==='platform-search-results'),'empty input must not show every destination');
 assert(tree.some(n=>n.props?.['aria-label']==='搜索历史'));
 tree.find(n=>n.props?.label==='删除搜索：外观').props.onClick();tree.find(n=>n.props?.children==='清空历史').props.onClick();
 assert.deepEqual(historyActions,[['remove','one'],['clear']]);
 let input=tree.find(n=>n.type==='input');input.props.onChange({target:{value:'市场色块'}});tree=view();
 let results=tree.find(n=>n.props?.className==='platform-search-results');assert.equal(results.props.children[0].length,1);results.props.children[0][0].props.onClick();
 assert.deepEqual(historyActions.at(-1),['record','市场色块']);assert.deepEqual(selected.at(-1),['stocks','market-badges']);
 searchStates=[true,'市场色块'];assert(!view({admin:false}).some(n=>n.props?.className==='platform-search-results'&&n.props.children[0].length),'ordinary users cannot search administrator settings');
 searchStates=[true,'不存在的功能'];tree=view();input=tree.find(n=>n.type==='input');input.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false},preventDefault(){}});assert.deepEqual(historyActions.at(-1),['record','不存在的功能']);
 input.props.onChange({target:{value:'正在输入'}});assert.deepEqual(historyActions.at(-1),['record','不存在的功能'],'typing never writes history');
 const settings=fs.readFileSync(path.join(root,'components/views/SettingsView.tsx'),'utf8');assert(!settings.includes('placeholder="搜索设置"')&&!settings.includes('fire:settings-cmd-open'));
 console.log('PASS global search: input first, history delete/clear, completed queries only, exact settings destination and permissions');
}finally{Module._load=previousLoad;global.document=previousDocument;global.HTMLElement=previousHTMLElement;}
