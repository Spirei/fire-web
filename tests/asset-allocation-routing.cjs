const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, f);
const { allocationRoute, allocationCategoryRoute } = require('../lib/assetAllocationRouting.ts');

function sample(d) {
  const tokens = d.match(/[MLQC]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi), points = [];
  let at = { x: 0, y: 0 }, i = 0;
  while (i < tokens.length) {
    const command = tokens[i++], x = Number(tokens[i++]), y = Number(tokens[i++]);
    if (command === 'M') { at = { x, y }; points.push(at); continue; }
    const control = { x, y }, control2 = command === 'C' ? { x: Number(tokens[i++]), y: Number(tokens[i++]) } : control;
    const end = command === 'Q' || command === 'C' ? { x: Number(tokens[i++]), y: Number(tokens[i++]) } : control;
    for (let step = 1; step <= 100; step++) {
      const t = step / 100, u = 1 - t;
      points.push(command === 'C' ? { x: u*u*u*at.x + 3*u*u*t*control.x + 3*u*t*t*control2.x + t*t*t*end.x, y: u*u*u*at.y + 3*u*u*t*control.y + 3*u*t*t*control2.y + t*t*t*end.y } : command === 'Q' ? { x: u*u*at.x + 2*u*t*control.x + t*t*end.x, y: u*u*at.y + 2*u*t*control.y + t*t*end.y } : { x: u*at.x + t*end.x, y: u*at.y + t*end.y });
    }
    at = end;
  }
  return points;
}
function verify(source, hub, target, destinationTop, width) {
  const route = allocationRoute(source, hub, target, destinationTop);
  assert.deepEqual(sample(route.path).at(-1), { x: hub.l, y: (hub.t + hub.b) / 2 }, 'sources still converge on the left middle port');
  const categoryStart = target.l > hub.r ? { x: hub.r, y: (hub.t + hub.b) / 2 } : { x: (hub.l + hub.r) / 2, y: hub.b };
  assert.deepEqual(sample(allocationCategoryRoute(hub, target, destinationTop).forward)[0], categoryStart, 'categories still fan out from the shared hub port');
  for (const direction of ['forward', 'returning']) {
    assert(!/NaN|Infinity/.test(route[direction]));
    const points = sample(route[direction]);
    for (const p of points) {
      assert(p.x >= -1e-9 && p.x <= width + 1e-9, `route must stay inside the stage: ${JSON.stringify(p)} in ${route[direction]}`);
      assert(!(p.x > hub.l + 14 && p.x < hub.r - 14 && p.y > hub.t + 14 && p.y < hub.b - 14), 'pulse must follow the border and never cross the card interior');
    }
    const borderY = (source.t + source.b) / 2 < (hub.t + hub.b) / 2 ? hub.t : hub.b;
    assert(points.some(p => Math.abs(p.y - borderY) < .01 && p.x > hub.l + 14 && p.x < hub.r - 14), 'pulse follows the actual top/bottom edge, not a distant bypass');
    const from = direction === 'forward' ? source : target, to = direction === 'forward' ? target : source;
    assert.deepEqual(points[0], { x: direction === 'forward' ? from.r : from.l, y: (from.t + from.b) / 2 });
    assert.deepEqual(points.at(-1), { x: direction === 'forward' ? to.l : to.r, y: (to.t + to.b) / 2 });
  }
}
let count = 0;
for (const sy of [70, 240, 300, 520]) for (const ty of [80, 260, 450, 580]) {
  verify({ l: 0, r: 260, t: sy - 35, b: sy + 35 }, { l: 310, r: 560, t: 180, b: 420 }, { l: 610, r: 880, t: ty - 35, b: ty + 35 }, 25, 880); count++;
}
for (const sy of [70, 240, 450]) for (const ty of [620, 730, 1030]) {
  verify({ l: 0, r: 145, t: sy - 35, b: sy + 35 }, { l: 180, r: 340, t: 180, b: 380 }, { l: 25, r: 340, t: ty - 35, b: ty + 35 }, 560, 340); count++;
}
verify({ l: 0, r: 145, t: 20, b: 100 }, { l: 180, r: 340, t: 0, b: 280 }, { l: 25, r: 340, t: 340, b: 410 }, 320, 340); count++;
console.log(`Asset allocation routing: ${count} desktop/mobile geometries passed in both directions`);
