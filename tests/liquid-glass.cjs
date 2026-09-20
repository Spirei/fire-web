const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
function load(file, overrides = {}) {
 const m = new Module(__filename,module); m.paths = module.paths;
 const original = m.require.bind(m); m.require = id => overrides[id] ?? original(id);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,__filename);
 return m.exports;
}
const optics = load('lib/liquidGlass.ts');
for(const [w,h] of [[84,44],[42,44],[44,44],[24,44]]) {
 const a=optics.glassDisplacement(w,h), at=(x,y,c)=>a[(y*w+x)*4+c];
 assert.equal(a.length,w*h*4);
 let refracted=0;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
  assert.equal(at(x,y,3),255);
  assert(Math.abs(at(x,y,0)+at(w-1-x,y,0)-256)<=1,'horizontal optical symmetry');
  assert(Math.abs(at(x,y,1)+at(x,h-1-y,1)-256)<=1,'vertical optical symmetry');
  if(at(x,y,0)!==128 || at(x,y,1)!==128)refracted++;
 }
 assert(refracted>0 && refracted<w*h*.6,'distortion confined to rim');
 assert.equal(at(Math.floor(w/2),Math.floor(h/2),0),128,'clear lens center');
}
let palette='liquid', selected=[], captured=null;
let states=[];
const react={useEffect:()=>{},useId:()=>':test:',useRef:value=>({current:value}),useState:value=>{ const i=states.length;states.push(value);return [value,next=>states[i]=next]; }};
const Control=load('components/LiquidGlassControl.tsx',{'react':react,'@/lib/liquidGlass':optics,'./PaletteProvider':{useSitePalette:()=>({palette})}}).default;
function mount() {
 states=[];
 const el=Control({items:[{label:'native'},{label:'overlay'},{label:'wire'}],index:0,onChange:i=>selected.push(i),label:'mode'});
 el.props.ref.current={getBoundingClientRect:()=>({left:100,width:308}),setPointerCapture:id=>captured=id,hasPointerCapture:id=>captured===id,releasePointerCapture:()=>captured=null};
 return el.props;
}
const ev=(x,id=1)=>({isPrimary:true,button:0,pointerId:id,clientX:x,clientY:20});
let p=mount(); p.onPointerDown(ev(154));p.onPointerMove(ev(354));p.onPointerUp(ev(354));assert.deepEqual(selected,[2]);assert.equal(captured,null);
p=mount();p.onPointerDown(ev(154));p.onPointerMove(ev(-100));p.onPointerUp(ev(-100));assert.equal(selected.at(-1),0);
p=mount();p.onPointerDown(ev(154));p.onPointerDown(ev(354,2));p.onPointerUp(ev(354,2));assert.equal(selected.length,2,'second pointer cannot commit');p.onPointerCancel();p.onPointerUp(ev(354));assert.equal(selected.length,2,'cancel does not select');
p=mount();p.onPointerDown(ev(154));p.onLostPointerCapture();p.onPointerUp(ev(354));assert.equal(selected.length,2);
p=mount(); const mouse=x=>({...ev(x),pointerType:'mouse',buttons:0});
p.onPointerEnter(mouse(154));assert.equal(states[2],true,'hover raises lens');
p.onPointerMove(mouse(304));assert.equal(states[0],1.5,'hover follows continuously between options');
p.onPointerUp(mouse(304));assert.equal(selected.length,2,'hover cannot select');
p.onPointerLeave();assert.equal(states[0],0,'leave restores selection');assert.equal(states[2],false);
p.onPointerEnter({...mouse(254),pointerType:'touch'});assert.equal(states[2],false,'touch has no hover');
p.onPointerEnter(mouse(254));p.onPointerCancel();assert.equal(states[2],false,'cancel clears hover');
p.onPointerDown(mouse(154));p.onPointerLeave();p.onPointerMove(ev(354));p.onPointerUp(ev(354));assert.equal(selected.at(-1),2,'captured drag continues outside');
selected.pop();
p=mount();p.onPointerEnter(mouse(154));p.onPointerMove(mouse(304));p.onPointerMove(mouse(204));p.onPointerMove(mouse(354));
assert.equal(selected.length,2,'back-and-forth preview never commits');
p.onPointerDown(mouse(354));p.onPointerUp(mouse(354));assert.equal(selected.at(-1),2);
assert.equal(states[0],2);assert.equal(states[1],false);assert.equal(states[2],false,'click lands and deflates lens');
p.onPointerMove(mouse(356));assert.equal(states[2],false,'post-click mouse jitter does not reopen lens');
p.onPointerMove(mouse(330));assert.equal(states[2],true,'deliberate movement starts a new preview');
selected.pop();
palette='neutral';p=mount();p.onPointerEnter(mouse(254));assert.equal(states[2],false,'solid palette has no hover lens');p.onPointerDown(ev(354));p.onPointerUp(ev(354));assert.equal(selected.length,2,'solid palette uses normal button click');
console.log('PASS lens symmetry, narrow swatches, clear center, drag commit, limits, cancellation and multiple pointers');
