const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
const m = new Module(__filename, module); m.paths = module.paths;
m._compile(ts.transpileModule(fs.readFileSync('lib/palettes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);
const {SITE_PALETTES,resolvePalette,paletteVariables} = m.exports;
const lum = hex => [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
assert.equal(new Set(SITE_PALETTES.map(p=>p.id)).size,6);
for(const p of SITE_PALETTES){
 assert.equal(Object.keys(paletteVariables(p.id)).length,14);
 for(const mode of ['light','dark']){
  const [bg,surface,ink,muted,accent] = p[mode];
  for(const color of [ink,muted,accent]) for(const background of [bg,surface]) assert(contrast(color,background)>=4.5,`${p.id}/${mode} ${color} contrast ${contrast(color,background)}`);
 }
}
for(const value of [null,{},'unknown','__proto__']) assert.equal(resolvePalette(value).id,'neutral');
assert.equal(resolvePalette('liquid').glass,true);
console.log('PASS six complete light/dark palettes, 4.5:1 text/accent contrast, invalid preference fallback');
