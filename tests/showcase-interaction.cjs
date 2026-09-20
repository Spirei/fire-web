const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const m = new Module(__filename, module);
m._compile(ts.transpileModule(fs.readFileSync('components/showcase/interaction.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,__filename);
const {coastStep,boundedZoom,wheelPixels}=m.exports;
assert.equal(wheelPixels(3,1,800),wheelPixels(48,0,800));
assert.equal(wheelPixels(1,2,800),800);
assert.equal(wheelPixels(NaN,0,800),0);
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
const harness = `module.exports = function(boundedZoom, inspectorOn=false) {
 let dragPan=false,dragZoom=false,panX=0,panY=0;
 let now=1000, dragging=false, dragPointer=null, dragByTouch=false, dragX=0,dragY=0,dragTime=0;
 let tapX=0,tapY=0,tapDownAt=0,tapTravel=0,lastTapX=0,lastTapY=0,lastTapAt=0,lastTouchFocusAt=-Infinity;
 let userYaw=0,userPitch=0,userYawVel=0,userPitchVel=0,zoomTarget=1,focusCount=0;
 const touches=new Map(), freeCamera=true,racing=false,MIN_ZOOM=.55,INSPECTOR_MIN_ZOOM=.015,INSPECTOR_MAX_ZOOM=400;
 const zoomLimit=()=>5,clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const performance={now:()=>now},canvas={setPointerCapture(){},hasPointerCapture(){return true},releasePointerCapture(){}};
 const panCamera=(x,y)=>{panX+=x;panY+=y};
 const focusAt=()=>{focusCount++};
 ${dragSource}
 ${touchSource}
 ${doubleSource}
 return {event(type,id,x,y,dt=16,extra={}){now+=dt;const e={type,pointerId:id,clientX:x,clientY:y,pointerType:'touch',button:0,...extra};
 if(type==='pointerdown'){onCanvasDown(e);onTouchDown(e)}
 else if(type==='pointermove'){onPointerMove(e);onTouchMove(e)}
 else {onDragEnd(e);onTouchEnd(e)}},dblclick:()=>onDoubleClick({}),read:()=>({userYaw,userPitch,userYawVel,userPitchVel,zoomTarget,focusCount,dragging,panX,panY})};
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

const touch=hmod.exports(boundedZoom,true);
touch.event('pointerdown',1,100,100);touch.event('pointerdown',2,200,100);
touch.event('pointermove',1,130,120);touch.event('pointermove',2,230,120);
assert.equal(touch.read().panX,30);assert.equal(touch.read().panY,20);
assert(Math.abs(touch.read().zoomTarget-1)<1e-10);
assert.equal(touch.read().userYaw,0);
touch.event('pointerup',2,230,120);touch.event('pointermove',1,140,120);
assert(Math.abs(touch.read().userYaw+4.2)<1e-8);
console.log('PASS two-finger pan preserves scale and switches back to one-finger orbit');

// The actual focus handler must never jump back to the home-page minimum distance.
const THREE=require('three');
const focusSource=source.slice(source.indexOf('  const focusAt ='),source.indexOf('  const panCamera ='));
const focusModule=new Module(__filename,module);
focusModule._compile(ts.transpileModule(`module.exports=function(THREE){
 const freeCamera=true,inspectorOn=true,racing=false,racingAmt=0,MIN_ZOOM=.55,INSPECTOR_MIN_ZOOM=.015,INSPECTOR_MAX_ZOOM=400;
 let zoom=.02,zoomTarget=.02,userYawVel=1,userPitchVel=1,hitOn=true;
 const lookAt=new THREE.Vector3(),focusOffset=new THREE.Vector3(),focusTarget=new THREE.Vector3(),focusPointer=new THREE.Vector2();
 const camera={updateMatrixWorld(){},position:new THREE.Vector3(0,0,.2)};
 const carRoot={updateMatrixWorld(){}};
 const canvas={getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})};
 const focusRay={setFromCamera(){},intersectObject:()=>hitOn?[{point:new THREE.Vector3(0,0,.1),distance:.1,object:{visible:true,parent:carRoot}}]:[]};
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const applyZoom=f=>zoomTarget=clamp(zoomTarget*f,INSPECTOR_MIN_ZOOM,INSPECTOR_MAX_ZOOM);
 ${focusSource}
 return {focus(){focusAt(50,50);return zoomTarget},background(){hitOn=false;focusAt(50,50);return zoomTarget}};
};`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,__filename);
const focus=focusModule.exports(THREE);
assert.equal(focus.focus(),.015);
assert(focus.background()>.015);
console.log('PASS close-up double-click stays close; background double-click dollies out');

const mouse=hmod.exports(boundedZoom,true);
mouse.event('pointerdown',1,100,100,16,{pointerType:'mouse',button:2});
mouse.event('pointermove',1,130,120,16,{pointerType:'mouse',button:2});
assert.equal(mouse.read().panX,30);assert.equal(mouse.read().panY,20);
assert.equal(mouse.read().userYaw,0);
mouse.event('pointerup',1,130,120,16,{pointerType:'mouse',button:2});
assert.equal(mouse.read().dragging,false);
console.log('PASS right-drag pans the target without orbiting');
const poleStart=source.indexOf('    if (inspectorOn) {\n      // 边界约束');
const poleEnd=source.indexOf('    const elev =',poleStart);
assert(poleStart>=0 && poleEnd>poleStart);
const constrainPitch=new Function('baseElev','userPitch', `const inspectorOn=true;let userPitchVel=1;const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));${source.slice(poleStart,poleEnd)};return {elev:baseElev+userPitch,velocity:userPitchVel};`);
for(const base of [-.4,0,.4]) for(const requested of [-3,3]) {
 const pose=constrainPitch(base,requested);
 assert(Math.abs(pose.elev-Math.sign(requested)*1.56)<1e-12);
 assert.equal(pose.velocity,0);
}
console.log('PASS both pole limits use absolute elevation and stop outward inertia');
