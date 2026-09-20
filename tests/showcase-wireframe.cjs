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
assert.notEqual(overlay.geometry, geometry, 'refined source triangles are removed from the base wire layer');
assert.equal(overlay.geometry.getIndex().count, 0, 'replacement detail does not overlap the original sparse edges');
assert.equal(overlay.children.length, 1, 'sparse panels get a local display-only detail layer');
assert(overlay.children[0].geometry.getAttribute('position').count > geometry.getAttribute('position').count);
assert.equal(wheel.material, paint);
assert.equal(overlay.material.side, THREE.DoubleSide, 'thin wings need wire lines on both faces');
assert(overlay.renderOrder > 0, 'overlay renders after transparent GLB paint so camera-angle sorting cannot hide it');
assert.equal(overlay.children[0].renderOrder, overlay.renderOrder, 'generated detail uses the same stable render order');
for (const angle of [0, .5, 2, 4]) {
 wheel.rotation.x = angle;
 root.updateMatrixWorld(true);
 assert.deepEqual(overlay.matrixWorld.elements, wheel.matrixWorld.elements, 'wire must follow the complete wheel transform');
}
assert.equal(hidden.visible, false);
for (const mode of ['overlay','wireframe']) for (const color of ['#000000','#cccccc','#ff0000','#0000ff','#00ff00','#ffff00']) {
 view.set(mode, color);
 assert.equal(overlay.material.color.getHexString(), color.slice(1));
 assert.equal(wheel.children.length, 2, 'color changes must not grow geometry beyond the live overlay and muted-outline layers');
 assert.equal(overlay.children[0].material.color.getHexString(), color.slice(1));
}
view.set('wireframe', '#00ff00');
assert.equal(wheel.material.colorWrite, false);
assert.equal(overlay.material.wireframe, true);
assert.equal(overlay.visible, true);
assert.equal(overlay.material.color.getHexString(), '00ff00');
assert.equal(overlay.children[0].material, overlay.material, 'detail layer follows pure-wire material');
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
const skinView = m.exports.createWireframeView();
const skinGeometry = new THREE.BoxGeometry(1, 1, 1);
const skin = new THREE.SkinnedMesh(skinGeometry, paint);
const skinRoot = new THREE.Group(); skinRoot.add(skin);
skinView.attach(skinRoot); skinView.set('overlay', '#00ff00');
assert.equal(skin.children[0].geometry, skinGeometry, 'skinned geometry keeps vertex weights and original topology');
skinView.dispose();
const denseView = m.exports.createWireframeView();
const denseGeometry = new THREE.BufferGeometry();
denseGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 2,0,0, 0,2,0, 0.01,0,0], 3));
const denseIndex = new Uint32Array(600003);
denseIndex.set([0, 1, 2]); // one sparse endplate triangle inside a >200k-triangle combined mesh
for (let i = 3; i < denseIndex.length; i += 3) denseIndex.set([0, 3, 0], i);
denseGeometry.setIndex(new THREE.BufferAttribute(denseIndex, 1));
const denseMesh = new THREE.Mesh(denseGeometry, paint);
const denseRoot = new THREE.Group(); denseRoot.add(denseMesh);
denseView.attach(denseRoot); denseView.set('overlay', '#00ff00');
assert.equal(denseMesh.children[0].children.length, 1, 'large combined meshes still tessellate their sparse endplate triangles');
denseView.dispose(); denseGeometry.dispose();
const mirrorView = m.exports.createWireframeView();
const mirrorGeometry = new THREE.BufferGeometry();
mirrorGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  0,0,0, 2,0,0, 0,1,0,
  0,0,0, -2,0,0, 0,1,0
], 3));
const mirrorMesh = new THREE.Mesh(mirrorGeometry, paint), mirrorRoot = new THREE.Group(); mirrorRoot.add(mirrorMesh);
mirrorView.attach(mirrorRoot); mirrorView.set('overlay', '#00ff00');
const mirrorPosition = mirrorMesh.children[0].children[0].geometry.getAttribute('position');
assert.equal(mirrorPosition.count % 6, 0, 'mirrored source triangles receive the same subdivision count');
const half = mirrorPosition.count / 2;
for (let i = 0; i < half; i += 1) {
 assert(Math.abs(mirrorPosition.getX(i) + mirrorPosition.getX(i + half)) < 1e-7, 'left/right detail x coordinates mirror exactly');
 assert(Math.abs(mirrorPosition.getY(i) - mirrorPosition.getY(i + half)) < 1e-7, 'left/right detail y coordinates stay aligned');
 assert(Math.abs(mirrorPosition.getZ(i) - mirrorPosition.getZ(i + half)) < 1e-7, 'left/right detail z coordinates stay aligned');
}
mirrorView.dispose(); mirrorGeometry.dispose();
const trimView = m.exports.createWireframeView();
const trimGeometry = new THREE.BufferGeometry();
const trimPositions = [];
const trimIndices = [];
const addBox = (cx, sx, sy, sz) => {
 const start = trimPositions.length / 3;
 for (const x of [-sx / 2, sx / 2]) for (const y of [-sy / 2, sy / 2]) for (const z of [-sz / 2, sz / 2]) trimPositions.push(cx + x, y, z);
 const faces = [0,2,3,0,3,1, 4,5,7,4,7,6, 0,1,5,0,5,4, 2,6,7,2,7,3, 0,4,6,0,6,2, 1,3,7,1,7,5];
 trimIndices.push(...faces.map((value) => value + start));
};
addBox(0, .2, .2, .2); // ordinary model part remains wired
addBox(1, .02, .08, .6); // thin, elongated, disconnected endplate trim stays solid without green overlay
trimGeometry.setAttribute('position', new THREE.Float32BufferAttribute(trimPositions, 3));
trimGeometry.setIndex(trimIndices);
const trimMesh = new THREE.Mesh(trimGeometry, paint), trimRoot = new THREE.Group(); trimRoot.add(trimMesh);
trimView.attach(trimRoot); trimView.set('overlay', '#00ff00');
assert.notEqual(trimMesh.children[0].geometry, trimGeometry, 'thin disconnected rear-wing trim gets a display-only filtered wire index');
assert.equal(trimMesh.children[0].geometry.getIndex().count, 0, 'refined main part moves out of the base layer with no duplicate edges');
assert.equal(trimMesh.children[0].children[0].geometry.getAttribute('position').count, 12 * 16 * 3, 'main part remains wired while the cucumber-like trim outline is omitted');
assert.equal(trimGeometry.getIndex().count, 72, 'solid source topology is never modified');
trimView.dispose(); trimGeometry.dispose();
const connectedView = m.exports.createWireframeView();
const connectedGeometry = new THREE.BufferGeometry();
connectedGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  0,0,0, 2,1,1, 0,1,0, // one long triangle at an arbitrary 3D angle
  .05,0,0, 0,.05,0       // a tiny triangle connected only by vertex 0
], 3));
connectedGeometry.setIndex([0,1,2, 0,3,4]);
const connectedMesh = new THREE.Mesh(connectedGeometry, paint), connectedRoot = new THREE.Group(); connectedRoot.add(connectedMesh);
connectedView.attach(connectedRoot); connectedView.set('overlay', '#00ff00');
const connectedDetail = connectedMesh.children[0].children[0].geometry.getAttribute('position');
assert.equal(connectedDetail.count, 2 * 16 * 3, 'every face in an arbitrarily oriented sparse component shares one capped subdivision level');
connectedView.configure({ maxDepth: 1, maxEdge: .14 });
assert.equal(connectedMesh.children[0].children[0].geometry.getAttribute('position').count, 2 * 4 * 3, 'import tuning rebuilds the live wire view with the selected density');
connectedView.dispose(); connectedGeometry.dispose();
const cleanGeometry = new THREE.BufferGeometry();
cleanGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0], 3));
cleanGeometry.setIndex([0,1,2, 0,2,3]);
const cleanMesh = new THREE.Mesh(cleanGeometry, paint), cleanRoot = new THREE.Group(); cleanRoot.add(cleanMesh);
const cleanView = m.exports.createWireframeView({ enabled: false, cleanBaseEdges: true, edgeThreshold: 1 });
cleanView.attach(cleanRoot); cleanView.set('overlay', '#00ff00');
assert.equal(cleanMesh.children[0].isLineSegments, true, 'clean-base mode renders threshold edges instead of every triangle edge');
assert.equal(cleanMesh.children[0].geometry.getAttribute('position').count, 8, 'coplanar diagonal is removed while the four panel edges remain');
cleanView.dispose(); cleanGeometry.dispose();
console.log('PASS six colors, wheel transforms, hidden meshes, original/multi-material restoration, shared palette, model switch and disposal');
// Exercise the engine's real inspector transition: entering must not overwrite the home pose.
const engine = fs.readFileSync('components/showcase/engine.ts', 'utf8');
assert.match(engine, /const INSPECTOR_MIN_ZOOM = 0\.015;/, 'inspector must permit cockpit-scale zoom');
assert.match(engine, /const INSPECTOR_MAX_ZOOM = 400;/, 'inspector must permit Sketchfab-scale zoom out');
assert.match(engine, /clamp\(r \* 0\.003, 0\.0015, 0\.08\)/, 'near plane follows close camera distance');
assert.match(engine, /inspectorViewLight\.position\.copy\(camera\.position\)/, 'view light follows camera for underside highlights');
assert.match(engine, /const baseElev = Math\.atan2\(Math\.max\(0\.2, h\) - targetY, baseRadius\)/, 'dolly keeps a fixed orbit ray instead of curving toward target');
assert.match(engine, /if \(modelCameraOn\(\)\) \{ badFrames = 0; softTries = 0; return; \}/, 'extreme model-camera framing must not trip the render watchdog');
assert.match(engine, /floorUniforms\.uReflectIntensity\.value = wireframeMode === "native"[\s\S]*?: 0;/, 'homepage reflection must be disabled for overlay and pure wireframe modes');
assert.match(engine, /if \(mode === "native"\) reflectDirty = true;/, 'returning to native mode must refresh the reflection texture');
const transition = engine.slice(engine.indexOf('    setInspector: (on) => {'), engine.indexOf('    setWireframe: (mode, color)'));
const transitionModule = new Module(__filename, module);
transitionModule.paths = module.paths;
transitionModule._compile(ts.transpileModule(`
const THREE = require('three');
module.exports = () => {
 let inspectorOn = false, inspectorPose = null;
 let inspectorProgress = 0, START_P = 0;
 const homePose = { p: .42, yaw: -18, pitch: .12, zoom: 1.25 };
 let freeCamera = false, orbitOn = true, orbitYaw = 1, racing = true;
 let speed = 200, racingAmt = 1, carTravel = 5;
 let userYaw = 23, userPitch = .2, zoom = 1.6, zoomTarget = 1.6;
 let userYawVel = 4, userPitchVel = 2;
 const focusTarget = new THREE.Vector3(1,2,3), focusOffset = focusTarget.clone();
 const camera = new THREE.PerspectiveCamera(30, 1, .1, 400);
 const api = { ${transition} };
 return { set: api.setInspector, state: () => ({ inspectorOn, freeCamera, orbitOn, orbitYaw, racing, speed, userYaw, userPitch, zoomTarget, near: camera.near, far: camera.far, focus: focusTarget.toArray() }) };
};`, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, __filename);
const inspector = transitionModule.exports();
const before = inspector.state();
inspector.set(true);
assert.equal(inspector.state().far, 5000);
assert.equal(inspector.state().near, .01);
assert.equal(inspector.state().racing, false);
assert.equal(inspector.state().freeCamera, true);
assert.equal(inspector.state().userYaw, -18, 'inspector enters at configured home yaw');
assert.equal(inspector.state().userPitch, .12, 'inspector enters at configured home pitch');
assert.equal(inspector.state().zoomTarget, 1.25, 'inspector enters at configured home zoom');
inspector.set(true); // repeated open must not overwrite saved state
inspector.set(false);
const after = inspector.state();
for (const key of ['freeCamera','orbitOn','orbitYaw','userYaw','userPitch','zoomTarget','near','far','focus']) assert.deepEqual(after[key], before[key]);
console.log('PASS inspector isolates racing and restores camera, orbit, focus and clipping range');
