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
const react={useEffect:()=>{},useId:()=>':test:',useRef:value=>({current:value}),useState:value=>[value,()=>{}]};
const Control=load('components/LiquidGlassControl.tsx',{'react':react,'@/lib/liquidGlass':optics,'./PaletteProvider':{useSitePalette:()=>({palette})}}).default;
function mount() {
 const el=Control({items:[{label:'native'},{label:'overlay'},{label:'wire'}],index:0,onChange:i=>selected.push(i),label:'mode'});
 el.props.ref.current={getBoundingClientRect:()=>({left:100,width:308}),setPointerCapture:id=>captured=id,hasPointerCapture:id=>captured===id,releasePointerCapture:()=>captured=null};
 return el.props;
}
const ev=(x,id=1)=>({isPrimary:true,button:0,pointerId:id,clientX:x});
let p=mount(); p.onPointerDown(ev(154));p.onPointerMove(ev(354));p.onPointerUp(ev(354));assert.deepEqual(selected,[2]);assert.equal(captured,null);
p=mount();p.onPointerDown(ev(154));p.onPointerMove(ev(-100));p.onPointerUp(ev(-100));assert.equal(selected.at(-1),0);
p=mount();p.onPointerDown(ev(154));p.onPointerDown(ev(354,2));p.onPointerUp(ev(354,2));assert.equal(selected.length,2,'second pointer cannot commit');p.onPointerCancel();p.onPointerUp(ev(354));assert.equal(selected.length,2,'cancel does not select');
p=mount();p.onPointerDown(ev(154));p.onLostPointerCapture();p.onPointerUp(ev(354));assert.equal(selected.length,2);
palette='neutral';p=mount();p.onPointerDown(ev(354));p.onPointerUp(ev(354));assert.equal(selected.length,2,'solid palette uses normal button click');
console.log('PASS lens symmetry, narrow swatches, clear center, drag commit, limits, cancellation and multiple pointers');
