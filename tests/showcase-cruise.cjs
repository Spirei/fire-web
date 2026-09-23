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
  let seed = 12971;
  const random = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  let speed = 0, cruising = false, sample = 0, changeAt = 0;
  const readings = [];
  for (let frame = 0; frame < 60 * 40; frame += 1) {
    const elapsed = frame * dt;
    if (!cruising && speed >= maxSpeed * 0.985) { cruising = true; changeAt = 0; }
    if (cruising && elapsed >= changeAt) {
      sample = random();
      changeAt = elapsed + 0.1 + random() * 0.18;
    }
    const target = cruising ? cruiseTargetSpeed(maxSpeed, topKmh, sample) : maxSpeed;
    speed += (target - speed) * (1 - Math.exp(-dt * (cruising ? 12 : 1.05)));
    if (elapsed > 15) readings.push(Math.round(speed / maxSpeed * topKmh));
  }
  const unique = readings.filter((value, i) => i === 0 || value !== readings[i - 1]);
  assert.equal(Math.max(...readings), topKmh, 'each car reaches its own advertised maximum');
  assert(Math.min(...readings) >= topKmh - 5, 'cruise stays close to this car’s maximum');
  assert(new Set(readings).size >= 4, 'cruise does not freeze at one or two values');
  assert(unique.some((value, i) => i > 2 && value === unique[i - 2]), 'readings can reverse direction without a full cycle');
  const reversals = unique.slice(2).filter((value, i) => (value - unique[i + 1]) * (unique[i + 1] - unique[i]) < 0).length;
  assert(reversals >= 8, 'readings change direction repeatedly before a scripted full cycle');
  assert(unique.length / 25 >= 2.5, 'readings react several times per second');
  console.log(`PASS ${topKmh} km/h car cruises ${Math.min(...readings)}–${Math.max(...readings)} km/h with irregular changes`);
}
assert(cruiseTargetSpeed(maxSpeed, 340, -1) <= maxSpeed);
assert(cruiseTargetSpeed(maxSpeed, 340, 2) >= maxSpeed * (1 - 4.6 / 340));
