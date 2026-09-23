const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const source = fs.readFileSync('components/showcase/qualityAsset.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
let constrained = false;
const moduleUnderTest = { exports: {} };
new Function('require', 'module', 'exports', js)((name) => {
  assert.equal(name, './modelMemory');
  return { constrainedGraphics: () => constrained, requiresOriginalGpu: asset => asset.includes('mclaren_mp45__formula_1') };
}, moduleUnderTest, moduleUnderTest.exports);
const { fullQualityAsset } = moduleUnderTest.exports;
const config = (model, gpuTextureMax) => ({ assets: { model, gpuModel: 'compressed.glb', gpuTextureMax } });

assert.equal(fullQualityAsset(config('mcl35m.glb', 4096), 'original'), 'mcl35m.glb', 'desktop 4K and RAW reuse the same full model');
constrained = true;
assert.equal(fullQualityAsset(config('mcl35m.glb', 4096), 'original'), 'mcl35m.glb', 'mobile 4K source need not switch to a second file');
assert.equal(fullQualityAsset(config('gulf.glb', 8192), 'original'), 'compressed.glb', 'large mobile RAW can retain GPU compression');
assert.equal(fullQualityAsset(config('mclaren_mp45__formula_1.glb', 4096), 'original'), 'compressed.glb', 'MP4/5 keeps its required GPU copy');
assert.equal(fullQualityAsset(config('mcl35m.glb', 4096), 'fine'), 'mcl35m.glb', '4K uses the original full model');
console.log('PASS full-resolution quality chooses a reusable model without losing required mobile GPU copies');
