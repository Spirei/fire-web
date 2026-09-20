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
let palette='liquid', selected=[], captured=null, refs=[], renders=0, now=0, nextId=1;
const timers=new Map();
global.setTimeout=(fn,delay)=>{const id=nextId++;timers.set(id,{at:now+delay,fn});return id};
global.clearTimeout=id=>timers.delete(id);
global.requestAnimationFrame=fn=>setTimeout(()=>fn(now),1000/60);
global.cancelAnimationFrame=id=>clearTimeout(id);
function advance(ms){const end=now+ms;for(;;){const pending=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!pending)break;timers.delete(pending[0]);now=pending[1].at;pending[1].fn()}now=end}
const react={useEffect:()=>{},useId:()=>':test:',useRef:value=>{const r={current:value};refs.push(r);return r},useState:value=>[value,()=>renders++]};
const Control=load('components/LiquidGlassControl.tsx',{'react':react,'@/lib/liquidGlass':optics,'./PaletteProvider':{useSitePalette:()=>({palette})}}).default;
function mount() {
 refs=[];renders=0;timers.clear();now=0;selected=[];
 const el=Control({items:[{label:'native'},{label:'overlay'},{label:'wire'}],index:0,onChange:i=>selected.push(i),label:'mode'});
 el.props.ref.current={clientLeft:0,clientTop:0,dataset:{},style:{setProperty:()=>{}},getBoundingClientRect:()=>({left:100,top:0,width:308}),setPointerCapture:id=>captured=id,hasPointerCapture:id=>captured===id,releasePointerCapture:()=>captured=null};
 refs[2].current.bounds={left:104,top:4,width:300,height:44};refs[2].current.slot=100;
 return el.props;
}
const ev=(x,id=1)=>({isPrimary:true,button:0,pointerId:id,clientX:x,clientY:20});
let p=mount();
assert.equal(p.onPointerEnter,undefined,'plain hover has no lens interaction');
p.onPointerDown(ev(354));advance(319);assert.equal(refs[2].current.raised,false);p.onPointerUp(ev(354));advance(1000);assert.deepEqual(selected,[2]);assert.equal(captured,null);assert.equal(timers.size,0,'settled animation stops');
p=mount();p.onPointerDown(ev(154));advance(321);assert.equal(refs[2].current.raised,true,'threshold activates lens');
for(let i=0;i<120;i++){p.onPointerMove(ev(154+150*Math.sin(i/20)));advance(1000/60)}
assert.equal(renders,0,'no React state updates during drag');assert.equal(selected.length,0,'preview cannot select');
p.onPointerUp(ev(354));advance(1000);assert.deepEqual(selected,[2]);assert.equal(refs[2].current.x.value,2);assert.equal(refs[2].current.lift.value,0);assert.equal(timers.size,0);
p=mount();p.onPointerDown(ev(154));p.onPointerMove(ev(180));advance(500);assert.equal(refs[2].current.raised,false);p.onPointerUp(ev(354));assert.equal(selected.length,0,'cancelled drag cannot accidentally select');
p=mount();p.onPointerDown(ev(154));p.onPointerDown(ev(354,2));p.onPointerUp(ev(354,2));assert.equal(selected.length,0);p.onPointerCancel();advance(600);assert.equal(selected.length,0);assert.equal(captured,null);
p=mount();p.onPointerDown(ev(154));p.onLostPointerCapture();advance(600);p.onPointerUp(ev(354));assert.equal(selected.length,0);
p=mount();p.onPointerDown(ev(354));advance(60);p.onPointerUp(ev(354));assert.deepEqual(selected,[2],'short click commits immediately');advance(90);assert(refs[2].current.lift.value>.3,'short click briefly raises lens');advance(1000);assert.equal(refs[2].current.lift.value,0,'click lens returns to rest');
p=mount();refs[2].current.reduced=true;p.onPointerDown(ev(154));advance(321);p.onPointerMove(ev(354));assert.equal(refs[2].current.x.value,2);assert.equal(refs[2].current.lift.value,0);p.onPointerUp(ev(354));assert.deepEqual(selected,[2]);
palette='neutral';p=mount();p.onPointerDown(ev(354));p.onPointerUp(ev(354));assert.equal(selected.length,0);
for(const solid of ['neutral','ocean','forest','amber','dusk']){
 palette=solid;p=mount();p.children[0].props.children[2].props.onClick({detail:1});
 assert.deepEqual(selected,[2]);assert.equal(refs[2].current.lift.value,0);assert.equal(timers.size,0,`${solid} has no glass animation`);
}
let cleanup;
const listeners=new Set();const events={addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
global.document={...events};global.window={...events};global.matchMedia=()=>({...events,matches:true});
const GlobalGlass=load('components/LiquidGlassInteractions.tsx',{'react':{useEffect:fn=>{cleanup=fn()}},'@/lib/liquidGlass':optics}).default;
GlobalGlass({enabled:false});assert.equal(listeners.size,0,'solid palette installs no global handlers');
GlobalGlass({enabled:true});assert(listeners.size>0);cleanup();assert.equal(listeners.size,0,'palette change removes every global handler');
for(const hz of [30,60,90,120,144,240]){
 let x={value:0,velocity:0};for(let i=0;i<hz;i++)x=optics.stepGlassSpring(x,2,1/hz,28);
 assert(Math.abs(x.value-2)<1e-8,`refresh-independent settling ${hz}Hz`);
}
for(let i=0;i<600;i++){
 const f=optics.glassFrame(i/300,Math.sin(i/100)**2,Math.cos(i/20)*8,84.66,44);
 assert(Math.abs(f.left+f.copyX)<1e-10,'every frame shares content origin');assert(f.height>=44 && f.height<=57.2+1e-9);assert(f.width>=84.66 && f.width<105);
}
console.log('PASS 600 alignment frames, 30–240Hz spring, zero drag renders, activation threshold, snap, cleanup, cancelled gesture, reduced motion');
