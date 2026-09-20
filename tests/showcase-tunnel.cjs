const fs = require('node:fs');
const assert = require('node:assert/strict');
const Module = require('node:module');
const ts = require('typescript');
const filename = require('node:path').resolve('components/showcase/presets/mcl35m.ts');
const mod = new Module(filename, module); mod.paths = module.paths;
mod._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, filename);
const {speed} = mod.exports.MCL35M_SHOWCASE;
const {tunnel} = speed;
const W=541,H=377;
function line(edge) {
 const theta=edge.angle*Math.PI/180;
 const x=edge.origin[0]*W, y=(1-edge.origin[1])*H;
 const m=-Math.tan(theta);
 return {y:x1=>y+m*(x1-x),x:y1=>x+(y1-y)/m};
}
const [ul,ll,ur,lr] = tunnel.bars.map(line), [bl,br]=tunnel.lanes.map(line);
function near(actual, expected){assert(Math.abs(actual-expected)<0.15,`${actual} vs ${expected}`)}
near(ul.y(38),58.4166); near(ll.y(38),225.6903);
near(ll.y(38)-ul.y(38),167.2738); near(bl.y(38)-ll.y(38),23.5526);
near(ll.y(92)-ul.y(92),140.2833);
near(lr.y(474)-ur.y(474),206.4485);
near(lr.x(292)-br.x(292),131.0793);
assert.deepEqual(tunnel.bars.map(b=>b.color),['#a6926d','#9f8366','#9e7f57','#836d51']);
assert.deepEqual(tunnel.lanes.map(b=>b.color),['#6e6d78','#568092']);
assert.equal(tunnel.referenceAspect,W/H);
console.log('PASS reference rail coordinates, asymmetric gaps, six sampled colors');
// Reference video sampled every 0.25s after the first rise, with 0.25s onset uncertainty.
const observed=[67,138,164,200,244,268,280,300,310,318,324,328,331,333,335,336];
const error=observed.map((v,i)=>speed.topKmh*(1-Math.exp(-speed.response.acceleration*(i+1)*.25))-v);
const rmse=Math.sqrt(error.reduce((a,v)=>a+v*v,0)/error.length);
assert(rmse<12,'Acceleration must stay close to the reference telemetry');
assert(Math.abs(Math.exp(-speed.response.braking*.25)-174/263)<.02);
console.log(`PASS reference acceleration / braking (sampled RMSE ${rmse.toFixed(1)} km/h)`);

// Left shoulder may narrow toward the vanishing point, but must never cross its yellow edge.
for (let x=0; x<=350; x++) assert(bl.y(x)>ll.y(x), `Left rails cross at x=${x}`);
assert.equal(tunnel.lanes[0].tailColor, '#32363d');
near(bl.y(92),231.9424);
console.log('PASS left shoulder stays separate and retains sampled core / tail colors');
