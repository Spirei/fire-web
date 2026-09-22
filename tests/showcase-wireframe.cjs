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
 assert.equal(wheel.children.length, 2, 'color changes keep one live overlay plus one shared muted full-wire overlay');
 assert.equal(overlay.children[0].material.color.getHexString(), color.slice(1));
}
view.set('wireframe', '#00ff00');
assert.equal(wheel.material.colorWrite, false);
assert.equal(overlay.material.wireframe, true);
assert.equal(overlay.visible, true);
assert.equal(overlay.material.color.getHexString(), '00ff00');
assert.equal(overlay.children[0].material, overlay.material, 'detail layer follows pure-wire material');
view.focus(() => false);
assert.equal(wheel.children[1].visible, true, 'unselected meshes use the dedicated full pure-wire overlay');
assert.equal(wheel.children[1].geometry, geometry, 'muted pure-wire mode wraps the complete source geometry, including tyre triangles');
assert.equal(wheel.children[1].material.color.getHexString(), 'cccccc', 'muted pure-wire mode reuses the existing light-gray color');
view.focus(null);
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
const mirrorIndex = mirrorMesh.children[0].children[0].geometry.getIndex();
assert.equal(mirrorIndex.count, 2 * 16 * 3, 'mirrored source triangles retain the same visible subdivision topology');
assert(mirrorPosition.count < mirrorIndex.count, 'indexed detail wire shares vertices instead of triplicating every triangle');
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
assert.equal(trimMesh.children[0].children[0].geometry.getIndex().count, 12 * 16 * 3, 'main part remains wired while the cucumber-like trim outline is omitted');
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
assert.equal(connectedMesh.children[0].children[0].geometry.getIndex().count, 2 * 16 * 3, 'every face in an arbitrarily oriented sparse component shares one capped subdivision level');
assert(connectedDetail.count < 2 * 16 * 3, 'connected detail triangles share indexed vertices');
connectedView.configure({ maxDepth: 1, maxEdge: .14 });
assert.equal(connectedMesh.children[0].children[0].geometry.getIndex().count, 2 * 4 * 3, 'import tuning rebuilds the live wire view with the selected density');
connectedView.dispose(); connectedGeometry.dispose();
const seamGeometry = new THREE.BufferGeometry();
seamGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  0,0,0, .1,0,0, 2,.5,0,       // long half of one wing panel
  0,0,0, .1,0,0, 0,.1,0        // adjoining face duplicates both seam vertices (UV / normal split)
], 3));
seamGeometry.setIndex([0,1,2, 3,4,5]);
const seamMesh = new THREE.Mesh(seamGeometry, paint), seamRoot = new THREE.Group(); seamRoot.add(seamMesh);
const seamView = m.exports.createWireframeView({ maxDepth: 2, maxEdge: .25, filterThinTrim: false });
seamView.attach(seamRoot); seamView.set('overlay', '#00ff00');
assert.equal(seamMesh.children[0].children[0].geometry.getIndex().count, 2 * 16 * 3,
  'position-identical seam vertices are welded for component analysis so an MP4/6 wing subdivides as one panel');
seamView.dispose(); seamGeometry.dispose();
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
const importer = fs.readFileSync('components/showcase/ModelImporter.tsx', 'utf8');
const preview = fs.readFileSync('components/showcase/ModelPreview.tsx', 'utf8');
const stage = fs.readFileSync('components/showcase/ShowcaseStage.tsx', 'utf8');
const previewRoute = fs.readFileSync('app/api/showcase/models/preview-upload/route.ts', 'utf8');
const apiSpec = fs.readFileSync('docs/api-spec.md', 'utf8');
assert.match(importer, /fire\.showcase\.model-workbench\.v1/, 'model workbench keeps a versioned local draft');
assert.match(importer, /localStorage\.getItem\(WORKBENCH_STORAGE_KEY\)/, 'model workbench restores the active draft after reload');
assert.match(importer, /localStorage\.setItem\(WORKBENCH_STORAGE_KEY/, 'model workbench persists unsaved tuning changes');
assert.match(importer, /mp-restore-screen/, 'model workbench covers the server import page until the local draft is restored');
assert.match(importer, /version: previewFile/, 'parameter tuning keeps a stable asset cache key instead of redownloading the same GLB');
assert.match(preview, /setInspectRegion\(activeRegion/, 'live preview rebuild restores the selected tuning region');
assert.doesNotMatch(preview, /\[config, explore, onPartSelect/, 'live tuning reuses the existing WebGL scene instead of rebuilding it');
assert.match(fs.readFileSync("components/showcase/previewUpdates.ts", "utf8"), /handle\.setModel\(\{ asset: next\.assets\.model, model: next\.model \}\)/, 'live tuning swaps the model in the existing renderer');
assert.match(fs.readFileSync("components/showcase/previewUpdates.ts", "utf8"), /handle\.updateModelMaterials\(next\.model\)/, 'material-only tuning updates the mounted car without reparsing GLB');
assert.match(engine, /const INSPECTOR_MIN_ZOOM = 0\.015;/, 'inspector must permit cockpit-scale zoom');
assert.match(engine, /const INSPECTOR_MAX_ZOOM = 400;/, 'inspector must permit Sketchfab-scale zoom out');
assert.match(engine, /clamp\(r \* 0\.003, 0\.0015, 0\.08\)/, 'near plane follows close camera distance');
assert.match(engine, /inspectorViewLight\.position\.copy\(camera\.position\)/, 'view light follows camera for underside highlights');
assert.match(engine, /const baseElev = Math\.atan2\(Math\.max\(0\.2, h\) - targetY, baseRadius\)/, 'dolly keeps a fixed orbit ray instead of curving toward target');
assert.match(engine, /if \(modelCameraOn\(\)\) \{ badFrames = 0; softTries = 0; return; \}/, 'extreme model-camera framing must not trip the render watchdog');
assert.match(engine, /floorUniforms\.uReflectIntensity\.value = wireframeMode === "native"[\s\S]*?: 0;/, 'homepage reflection must be disabled for overlay and pure wireframe modes');
assert.match(engine, /if \(mode === "native"\) reflectDirty = true;/, 'returning to native mode must refresh the reflection texture');
assert.doesNotMatch(engine, /return frameCount % 2 === 0;/, 'a static homepage must not rerender its full reflection scene every other frame');
assert.match(engine, /inspectorOn && !inspectorMoving && !inspectorRenderDirty/, 'a static workbench skips redundant full-resolution frames');
assert.match(engine, /1000 \/ 32/, 'idle homepage reuses the previous full-resolution frame at an approximately 30 Hz cadence');
assert.match(engine, /EXT_disjoint_timer_query_webgl2/, 'GPU frame timing is collected through the WebGL2 timer-query extension');
assert.match(engine, /updateModelMaterials:/, 'engine exposes a material-only live tuning path');
assert.match(fs.readFileSync('components/showcase/wireframe.ts', 'utf8'), /generated\.setIndex\(generatedIndices\)/, 'refined wire geometry shares indexed vertices');
assert.match(stage, /handle\.setWireframe\(wireRef\.current\.mode, wireRef\.current\.color\)/, 'homepage restores the selected model appearance');
assert.doesNotMatch(stage, /setWireframe\("native", wireRef\.current\.color\)/, 'leaving model inspection preserves its wireframe appearance');
assert.match(stage, /cfg\.assets\.previewModel \?\? cfg\.assets\.model/, 'homepage mounts the lightweight model before the full inspector asset');
assert.match(stage, /fire:showcase:texture-quality/, 'homepage texture quality persists across reloads');
assert.match(stage, /fast: \{ label: "流畅", badge: "1K", size: 1024 \}/, 'fast quality uses 1K textures');
assert.match(stage, /balanced: \{ label: "均衡", badge: "2K", size: 2048 \}/, 'balanced quality uses 2K textures');
assert.match(stage, /fine: \{ label: "精细", badge: "4K", size: 4096 \}/, 'fine quality uses 4K textures');
assert.match(stage, /original: \{ label: "原画", badge: "RAW", size: 16384 \}/, 'original quality preserves 8K source textures');
assert.match(stage, /textureQuality !== "fast" \|\| wireMode !== "native" \? \(textureQuality === "original" \? config\.assets\.gpuModel \?\? config\.assets\.model : config\.assets\.model\)/, 'higher texture modes and wireframe appearances use the complete model');
assert.match(stage, /showcase-left-controls/, 'homepage control capsules use a collapsible left drawer');
assert.match(stage, /showcase-model-controls/, 'homepage model capsules use a collapsible right drawer');
assert.match(stage, /className="sc-row sc-texture-quality"/, 'texture quality remains independent below the homepage copy');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-quality-option \{[\s\S]*?pointer-events: auto;/, 'texture quality rail remains clickable inside the pointer-transparent HUD');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-drawer-toggle \{[\s\S]*?pointer-events: auto;/, 'edge drawer toggles remain clickable inside the pointer-transparent HUD');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-drawer-content \.fire-cap \{[\s\S]*?border-radius: 0 !important;[\s\S]*?background: transparent !important;/, 'expanded edge drawers use the same linear visual language as their rails');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-nav \.sc-camera-reset \{[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/, 'camera reset remains a lightweight rail action instead of a floating capsule');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-free-camera \.sc-nav-tick \{[^}]*height: 3px;[^}]*border-radius: 0;/, 'free-camera selector uses the same straight rail mark as chapter navigation');
assert.match(fs.readFileSync('components/showcase/ShowcaseStage.tsx', 'utf8'), /aria-label="自由镜头"[\s\S]*?<span className="sc-nav-label">自由镜头<\/span>/, 'free-camera control uses the concise label consistently');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /html:has\(\.showcase\) body \{[\s\S]*?overflow: hidden;/, 'homepage and model inspection stay in one viewport');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-scroll \{[\s\S]*?height: 100%;/, 'homepage scroll wrapper uses the available viewport');
assert.match(fs.readFileSync('styles/palettes.css', 'utf8'), /\.showcase:not\(\.light\) \{[\s\S]*?--material-fill: rgb\(38 40 49 \/ \.9\)/, 'dark model inspector keeps a dark panel under a light site palette');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.showcase\.sc-free canvas \{ touch-action: none; \}/, 'free camera canvas owns drag gestures instead of scrolling the page');
assert.match(fs.readFileSync('components/showcase/model-importer.css', 'utf8'), /@media \(max-width: 560px\)[\s\S]*?\.mp-form \{ grid-template-columns: minmax\(0, 1fr\);/, 'mobile workbench presents tuning fields in one readable column');
assert.match(stage, /setModel\(\{ asset: \(textureQualityRef\.current === "original" \? current\.assets\.gpuModel \?\? current\.assets\.model : current\.assets\.model\)/, 'entering model inspection promotes the preview to the full model');
assert.match(engine, /if \(envWeight > 0\.02\) void ensureDayEnvironment\(\)/, 'day HDR waits until the visible mode actually needs it');
assert.match(engine, /createWireframeView\(CFG\.model\.wireframe, true/, 'showcase wireframes are split across frames');
assert.match(engine, /options\.initialTheme \?\? "dark"/, 'WebGL scene uses the server theme before its first frame');
assert.match(engine, /setClearColor\(theme === "light" \? 0xf4f6f9 : 0x050506/, 'WebGL clear color matches the initial theme');
assert.match(fs.readFileSync('components/showcase/showcase.css', 'utf8'), /\.sc-stage \{[\s\S]*?background: var\(--sc-bg\)/, 'showcase stage does not expose a hard-coded black loading frame');
assert.match(previewRoute, /isAdmin\(user\)/, 'preview upload remains admin-only');
assert.match(previewRoute, /isTrustedMutationRequest\(request\)/, 'preview upload rejects cross-origin mutations');
assert.doesNotMatch(previewRoute, /child_process|build-showcase|spawn\(/, 'website never runs a model encoder');
assert.match(apiSpec, /POST \/api\/showcase\/models\/preview-upload/, 'local preview upload API is documented');
assert(!fs.existsSync('app/api/showcase/models/previews/route.ts'), 'server generation endpoint removed');
for (const endpoint of [
  '/api/showcase/models/upload',
  '/api/showcase/models/{id}',
  '/api/showcase/models/order',
  '/api/showcase/models/cover'
]) assert.ok(apiSpec.includes(endpoint), `${endpoint} is documented`);
const transition = engine.slice(engine.indexOf('    setInspector: (on) => {'), engine.indexOf('    setWireframe: (mode, color)'));
const transitionModule = new Module(__filename, module);
transitionModule.paths = module.paths;
transitionModule._compile(ts.transpileModule(`
const THREE = require('three');
module.exports = () => {
 let inspectorOn = false, inspectorPose = null;
 const invalidateInspector = () => {};
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

const cacheSource = fs.readFileSync('components/showcase/assetCache.ts', 'utf8');
const homeSource = fs.readFileSync('components/showcase/HomeShowcase.tsx', 'utf8');
const stageSource = fs.readFileSync('components/showcase/ShowcaseStage.tsx', 'utf8');
assert.match(cacheSource, /if \(db && !cachedByApi\)/, 'large models are stored in one browser cache, not twice');
assert.match(homeSource, /matchMedia\("\(hover: hover\) and \(pointer: fine\)"\)\.matches/, 'only hover-capable pointers may prefetch the full model before selection');
assert.match(fs.readFileSync('components/showcase/engine.ts', 'utf8'), /Math\.min\(CFG\.model\.maxTextureSize, renderer\.capabilities\.maxTextureSize\)/, 'original textures respect the device WebGL limit');
assert.match(stageSource, /qualityError && <button[^>]*className="sc-quality-retry"/, 'failed quality switches expose a retry control');
console.log('PASS mobile high-quality loading avoids duplicate caches and unsupported textures');

assert.match(stageSource, /if \(textureQualityRef\.current === "fast" && wireRef\.current\.mode === "native"\)/, 'leaving model inspection only restores the light preview in native mode');
assert.match(stageSource, /handle\.setWireframe\(wireRef\.current\.mode, wireRef\.current\.color\)/, 'a saved model appearance is restored on the homepage');
assert.match(stageSource, /const bootstrapPreview = !inspectorRef\.current && !!cfg\.assets\.previewModel && cfg\.assets\.previewModel !== requestedAsset;/, 'refresh with a saved wireframe mode starts with an interactive preview');
assert.match(stageSource, /wireRef\.current\.mode !== requestedWireMode/, 'a changed wireframe mode cancels the pending full-model promotion');
assert.doesNotMatch(stageSource, /handleRef\.current\?\.setWireframe\("native", wireRef\.current\.color\)/, 'returning home does not erase the selected model appearance');
console.log('PASS model appearance survives leaving inspection and reloading the homepage');

const showcaseCss = fs.readFileSync('components/showcase/showcase.css', 'utf8');
assert.match(showcaseCss, /\.sc-race \{[\s\S]*?touch-action: none;[\s\S]*?-webkit-user-select: none;[\s\S]*?-webkit-touch-callout: none;/, 'holding the race button does not select text or open the mobile callout');
assert.match(showcaseCss, /\.sc-ctr \{[\s\S]*?-webkit-user-select: none;/, 'race caption cannot be accidentally selected while holding the button');
console.log('PASS mobile long-press racing suppresses text selection');
