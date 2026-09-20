const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const m = new Module(__filename, module);
m._compile(ts.transpileModule(fs.readFileSync('components/showcase/interaction.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,__filename);
const {coastStep,boundedZoom}=m.exports;
for(const fps of [30,60,90,120,144,240]) {
 let v=180,total=0;
 for(let i=0;i<fps*2;i++){const step=coastStep(v,1/fps);total+=step.distance;v=step.velocity;}
 assert(Math.abs(total-18*(1-Math.exp(-20)))<1e-10);
}
for(const start of [.55,1,2,5]){
 let z=start;
 for(let i=0;i<100;i++){const next=boundedZoom(z,1.25,.55,5);assert(next>=z&&next<=5);z=next;}
 assert.equal(z,5);
 for(let i=0;i<100;i++){const next=boundedZoom(z,.8,.55,5);assert(next<=z&&next>=.55);z=next;}
 assert.equal(z,.55);
 assert(boundedZoom(z,1.25,.55,5)>z);
}
console.log('PASS identical inertia at 30–240 Hz; monotonic soft zoom, reachable bounds, immediate reversal');
// Exercise the actual pointer handlers with deterministic event timing, including two-pointer transitions.
const source=fs.readFileSync('components/showcase/engine.ts','utf8');
const dragSource=source.slice(source.indexOf('  const onCanvasDown ='),source.indexOf('  const cancelInteraction ='));
const touchSource=source.slice(source.indexOf('  const onTouchDown ='),source.indexOf('  // 两指按下时阻止浏览器接管'));
const doubleSource=source.slice(source.indexOf('  const onDoubleClick ='),source.indexOf('  canvas.addEventListener("wheel",'));
const harness = `module.exports = function(boundedZoom) {
 let now=1000, dragging=false, dragPointer=null, dragByTouch=false, dragX=0,dragY=0,dragTime=0;
 let tapX=0,tapY=0,tapDownAt=0,tapTravel=0,lastTapX=0,lastTapY=0,lastTapAt=0,lastTouchFocusAt=-Infinity;
 let userYaw=0,userPitch=0,userYawVel=0,userPitchVel=0,zoomTarget=1,focusCount=0;
 const touches=new Map(), freeCamera=true,racing=false,inspectorOn=false,MIN_ZOOM=.55;
 const zoomLimit=()=>5,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const performance={now:()=>now},canvas={setPointerCapture(){},hasPointerCapture(){return true},releasePointerCapture(){}};
 const focusAt=()=>{focusCount++};
 ${dragSource}
 ${touchSource}
 ${doubleSource}
 return {event(type,id,x,y,dt=16){now+=dt;const e={type,pointerId:id,clientX:x,clientY:y,pointerType:'touch',button:0};
 if(type==='pointerdown'){onCanvasDown(e);onTouchDown(e)}
 else if(type==='pointermove'){onPointerMove(e);onTouchMove(e)}
 else {onDragEnd(e);onTouchEnd(e)}},dblclick:()=>onDoubleClick({}),read:()=>({userYaw,userPitch,userYawVel,userPitchVel,zoomTarget,focusCount,dragging})};
};`;
const hmod=new Module(__filename,module);
hmod._compile(ts.transpileModule(harness,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,__filename);
const h=hmod.exports(boundedZoom);
h.event('pointerdown',1,100,100);h.event('pointerdown',2,200,100);
h.event('pointermove',2,250,100);
assert.equal(h.read().userYaw,0);assert.equal(h.read().userPitch,0);assert(h.read().zoomTarget<1);
h.event('pointermove',1,90,110);assert.equal(h.read().userYaw,0);
h.event('pointerup',2,250,100);h.event('pointermove',1,100,120);
assert(Math.abs(h.read().userYaw+4.2)<1e-8);assert(h.read().userPitch>0);
h.event('pointercancel',1,100,120);assert.equal(h.read().dragging,false);assert.equal(h.read().userYawVel,0);
assert.equal(h.read().focusCount,0);
h.event('pointerdown',3,150,150);h.event('pointerup',3,150,150);
h.event('pointerdown',4,150,150);h.event('pointerup',4,150,150);assert.equal(h.read().focusCount,1);
console.log('PASS pinch does not rotate; one-finger continuation has no jump; cancellation clears inertia; double tap focuses once');

h.dblclick();assert.equal(h.read().focusCount,1);
console.log('PASS synthesized mouse double-click after touch does not focus twice');
h.event('pointerdown',5,100,100);h.event('pointermove',5,130,100);
h.event('pointerup',5,130,100,150);assert.equal(h.read().userYawVel,0);
console.log('PASS holding still before release does not restart inertia');
