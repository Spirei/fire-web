/* Geometry regression: real GLBs, no renderer, textures or user data writes. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const ts = require('typescript');
const THREE = require('three');
const filename = path.resolve('components/showcase/wheels.ts');
const mod = new Module(filename, module);
mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, filename);
const { splitWheelGeometry } = mod.exports;

async function loadGeometry(filename) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const input = fs.readFileSync(filename);
  const length = input.readUInt32LE(12);
  const json = JSON.parse(input.subarray(20, 20 + length));
  json.materials = (json.materials ?? []).map(material => ({ name: material.name }));
  delete json.textures; delete json.images; delete json.samplers;
  const raw = Buffer.from(JSON.stringify(json));
  const chunk = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(chunk);
  const binary = input.subarray(20 + length);
  const output = Buffer.alloc(20 + chunk.length + binary.length);
  input.copy(output, 0, 0, 12); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(chunk.length, 12); output.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(output, 20); binary.copy(output, 20 + chunk.length);
  return (await new GLTFLoader().parseAsync(output.buffer, '')).scene;
}

(async () => {
  const models = [
    ['MCL35M', 'public/mclaren/mcl35m.glb', /rim|tread|tyrewall/i, 1, 10],
    ['MP4/5', 'public/uploads/mclaren/models/mclaren_mp45__formula_1.glb', /wheels/i, 2, 4],
    ['MP4/6', 'public/uploads/mclaren/models/mclaren_mp46.glb', /tyre/i, 2, 4],
    ['Gulf', 'public/uploads/mclaren/models/gulf_mclaren_f1_2022_car.glb', /rim|tyre/i, 1, 8]
  ];
  for (const [name, filename, pattern, longitudinal, expected] of models) {
    if (!fs.existsSync(filename)) { assert.notEqual(name, 'MCL35M'); console.log(`SKIP ${name}: imported asset absent`); continue; }
    const scene = await loadGeometry(filename); scene.updateMatrixWorld(true);
    let rotating = 0;
    scene.traverse(mesh => {
      if (!mesh.isMesh || !pattern.test(mesh.material?.name ?? '')) return;
      const original = Array.from(mesh.geometry.index.array);
      const parts = splitWheelGeometry(mesh, 0, longitudinal);
      // MP4/5's same material also covers nonrotating suspension and brake calipers.
      if (name === 'MP4/5') assert.equal(parts.size, /Object_(10|27)$/.test(mesh.name) ? 2 : 0, mesh.name);
      if (!parts.size) return;
      rotating += parts.size;
      const partition = [...parts.values()].flatMap(part => Array.from(part.geometry.index.array));
      assert.equal(partition.length, original.length, 'No triangles dropped or duplicated');
      const triangles = indices => Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i*3, i*3+3).join(',')).sort();
      assert.deepEqual(triangles(partition), triangles(original), 'Original triangle winding and topology retained');
      for (const part of parts.values()) {
        assert.deepEqual(Object.keys(part.geometry.attributes), Object.keys(mesh.geometry.attributes));
        assert(part.radius > 0);
        const expectedCenter = part.center.clone().applyMatrix4(mesh.matrixWorld);
        // A quarter / half / three-quarter turn must never move the axle in world space.
        for (const angle of [0, Math.PI/2, Math.PI, Math.PI*1.5]) {
          const transform = mesh.matrixWorld.clone()
            .multiply(new THREE.Matrix4().makeTranslation(...part.center.toArray()))
            .multiply(new THREE.Matrix4().makeRotationX(angle))
            .multiply(new THREE.Matrix4().makeTranslation(...part.center.clone().negate().toArray()));
          assert(part.center.clone().applyMatrix4(transform).distanceTo(expectedCenter) < 1e-7);
        }
      }
      assert.deepEqual(Array.from(mesh.geometry.index.array), original, 'Input geometry remains unchanged');
    });
    assert.equal(rotating, expected, name);
    console.log(`PASS ${name}: ${rotating} circular wheel parts, complete topology, fixed axles`);
  }
  const single = new THREE.CylinderGeometry(.34, .34, .22, 16).rotateZ(Math.PI/2).toNonIndexed();
  assert.equal(splitWheelGeometry(new THREE.Mesh(single), 0, 2).size, 1);
  console.log('PASS unindexed single wheel');
})().catch(error => { console.error(error); process.exitCode = 1; });
