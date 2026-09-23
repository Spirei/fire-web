const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const filename = path.resolve('components/showcase/cruiseSpeed.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const mod = {exports:{}};
new Function('module', 'exports', source)(mod, mod.exports);
const {cruiseTargetSpeed} = mod.exports;
const configSource = ts.transpileModule(fs.readFileSync(path.resolve('components/showcase/presets/models.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const configs = {exports:{}};
new Function('module', 'exports', 'require', configSource)(configs, configs.exports, id => {
  assert.equal(id, './mcl35m');
  return {MCL35M_SHOWCASE:{speed:{topKmh:340},assets:{},model:{}}};
});
const imported = configs.exports.buildImportedConfig;
assert.equal(imported({file:'gulf_mclaren_f1_2022_car.glb'}).speed.topKmh, 350);
assert.equal(imported({file:'mclaren_mp46.glb'}).speed.topKmh, 335);
assert.equal(imported({file:'other.glb'}).speed.topKmh, 340);
assert.equal(imported({file:'mclaren_mp46.glb',params:{topKmh:342}}).speed.topKmh, 342);
const maxSpeed = 34, dt = 1 / 60;
for (const topKmh of [335, 340, 350]) {
  let speed = 0, cruising = false;
  const samples = [];
  for (let frame = 0; frame < 60 * 40; frame += 1) {
    const elapsed = frame * dt;
    if (speed >= maxSpeed * 0.985) cruising = true;
    const target = cruising ? cruiseTargetSpeed(maxSpeed, topKmh, elapsed) : maxSpeed;
    speed += (target - speed) * (1 - Math.exp(-dt * 1.05));
    if (elapsed > 15) samples.push(Math.round(speed / maxSpeed * topKmh));
  }
  assert.equal(Math.max(...samples), topKmh, 'steady cruise still reaches this car’s advertised peak');
  assert(Math.min(...samples) >= topKmh - 4 && Math.min(...samples) <= topKmh - 2, 'steady cruise moves gently near this car’s peak');
  assert(new Set(samples).size >= 3, 'speed must not stick at one or two values');
  assert(cruiseTargetSpeed(maxSpeed, topKmh, Math.PI / 2 / 0.9) < maxSpeed);
  console.log(`PASS ${topKmh} km/h car cruises ${Math.min(...samples)}–${Math.max(...samples)} km/h`);
}
