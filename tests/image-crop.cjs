const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const exportsForCrop = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/imageCrop.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText, {exports:exportsForCrop});
const {cropGeometry} = exportsForCrop;
for (const image of [{width:4000,height:3000},{width:900,height:2000},{width:2048,height:512}]) {
  for (const frame of [{width:300,height:300},{width:500,height:250},{width:270,height:135}]) {
    for (const zoom of [1,1.5,4]) for (const x of [-1,0,1]) for (const y of [-1,0,1]) {
      const crop = cropGeometry(image,frame,zoom,{x,y});
      assert(crop.left <= 1e-8 && crop.top <= 1e-8);
      assert(crop.width+crop.left >= frame.width-1e-8 && crop.height+crop.top >= frame.height-1e-8);
      assert(crop.sx >= -1e-8 && crop.sy >= -1e-8);
      assert(crop.sx+crop.sw <= image.width+1e-8 && crop.sy+crop.sh <= image.height+1e-8);
      assert(Math.abs(crop.sw/crop.sh-frame.width/frame.height)<1e-8);
    }
  }
}
const left=cropGeometry({width:4000,height:2000},{width:300,height:300},1,{x:1,y:0});
const right=cropGeometry({width:4000,height:2000},{width:300,height:300},1,{x:-1,y:0});
assert(Math.abs(left.sx)<1e-8);assert.equal(right.sx,2000);
console.log('PASS image crop matches avatar/banner frames, pan endpoints and zoom without blank edges across desktop/mobile');
