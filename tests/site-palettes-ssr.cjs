const assert = require('node:assert/strict');
const fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
const m = new Module(__filename,module); m.paths=module.paths;
m._compile(ts.transpileModule(fs.readFileSync('lib/palettes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,__filename);
(async()=>{
 for(const p of m.exports.SITE_PALETTES) for(const theme of ['light','dark']){
  const prefs=encodeURIComponent(JSON.stringify({'fire:site-palette':p.id}));
  const res=await fetch('http://localhost:3000/',{headers:{Cookie:`fire_prefs=${prefs}; fire_theme=${theme}`}});
  assert.equal(res.status,200);
  const html=await res.text(); const tag=html.match(/<html[^>]*>/)[0];
  assert(tag.includes(`data-palette="${p.id}"`),`${p.id}: SSR choice`);
  assert(tag.includes(`data-material="${p.glass?'glass':'solid'}"`));
  assert(tag.includes('--site-accent-light:'));
  assert.equal(/class="[^"]*\bdark\b/.test(tag),theme==='dark');
 }
 console.log('PASS twelve palette/theme SSR combinations emit matching palette, material and tokens before hydration');
})().catch(e=>{console.error(e);process.exitCode=1;});
