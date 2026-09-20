const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Module = require('node:module');
const THREE = require('three');
const m = new Module(__filename, module);
m.paths = module.paths;
m._compile(ts.transpileModule(fs.readFileSync('components/showcase/wireframe.ts', 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, __filename);
const view = m.exports.createWireframeView();
const root = new THREE.Group();
const geometry = new THREE.BoxGeometry();
const paint = new THREE.MeshStandardMaterial();
const wheel = new THREE.Mesh(geometry, paint);
wheel.position.set(2, 1, -3);
wheel.scale.set(2, 3, 4);
root.add(wheel);
const hidden = new THREE.Mesh(geometry, paint);
hidden.visible = false;
root.add(hidden);
view.attach(root);
assert.equal(wheel.children.length, 0, 'native must not allocate extra meshes');
view.set('overlay', '#00ff00');
const overlay = wheel.children[0];
assert.equal(overlay.geometry, geometry);
assert.equal(wheel.material, paint);
for (const angle of [0, .5, 2, 4]) {
 wheel.rotation.x = angle;
 root.updateMatrixWorld(true);
 assert.deepEqual(overlay.matrixWorld.elements, wheel.matrixWorld.elements, 'wire must follow the complete wheel transform');
}
assert.equal(hidden.visible, false);
for (const mode of ['overlay','wireframe']) for (const color of ['#000000','#cccccc','#ff0000','#0000ff','#00ff00','#ffff00']) {
 view.set(mode, color);
 assert.equal(overlay.material.color.getHexString(), color.slice(1));
 assert.equal(wheel.children.length, 1, 'color changes must not grow geometry');
}
view.set('wireframe', '#00ff00');
assert.equal(wheel.material.colorWrite, false);
assert.equal(overlay.material.wireframe, true);
assert.equal(overlay.visible, true);
assert.equal(overlay.material.color.getHexString(), '00ff00');
view.set('native', '#00ff00');
assert.equal(wheel.material, paint);
view.set('wireframe', '#00ff00');
const next = new THREE.Group();
const nextPaint = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
const nextMesh = new THREE.Mesh(geometry, nextPaint);
next.add(nextMesh);
view.attach(next);
assert.equal(wheel.material, paint, 'restore materials before old model disposal');
assert.equal(wheel.children.length, 0);
assert.equal(nextMesh.children[0].material.wireframe, true, 'carry selected mode to new model');
let geometryDisposed = false;
geometry.addEventListener('dispose', () => { geometryDisposed = true; });
view.dispose();
assert.equal(nextMesh.material, nextPaint);
assert.equal(nextMesh.children.length, 0);
assert.equal(geometryDisposed, false, 'controller does not own model geometry');
console.log('PASS six colors, wheel transforms, hidden meshes, original/multi-material restoration, shared palette, model switch and disposal');
// Exercise the engine's real inspector transition: entering must not overwrite the home pose.
const engine = fs.readFileSync('components/showcase/engine.ts', 'utf8');
const transition = engine.slice(engine.indexOf('    setInspector: (on) => {'), engine.indexOf('    setWireframe: (mode, color)'));
const transitionModule = new Module(__filename, module);
transitionModule.paths = module.paths;
transitionModule._compile(ts.transpileModule(`
const THREE = require('three');
module.exports = () => {
 let inspectorOn = false, inspectorPose = null;
 let freeCamera = false, orbitOn = true, orbitYaw = 1, racing = true;
 let speed = 200, racingAmt = 1, carTravel = 5;
 let userYaw = 23, userPitch = .2, zoom = 1.6, zoomTarget = 1.6;
 let userYawVel = 4, userPitchVel = 2;
 const focusTarget = new THREE.Vector3(1,2,3), focusOffset = focusTarget.clone();
 const camera = new THREE.PerspectiveCamera(30, 1, .1, 400);
 const api = { ${transition} };
 return { set: api.setInspector, state: () => ({ inspectorOn, freeCamera, orbitOn, orbitYaw, racing, speed, userYaw, userPitch, zoomTarget, far: camera.far, focus: focusTarget.toArray() }) };
};`, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, __filename);
const inspector = transitionModule.exports();
const before = inspector.state();
inspector.set(true);
assert.equal(inspector.state().far, 5000);
assert.equal(inspector.state().racing, false);
assert.equal(inspector.state().freeCamera, true);
inspector.set(true); // repeated open must not overwrite saved state
inspector.set(false);
const after = inspector.state();
for (const key of ['freeCamera','orbitOn','orbitYaw','userYaw','userPitch','zoomTarget','far','focus']) assert.deepEqual(after[key], before[key]);
console.log('PASS inspector isolates racing and restores camera, orbit, focus and clipping range');
