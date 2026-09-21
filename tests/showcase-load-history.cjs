const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const data = new Map();
const storage = {getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v)};
function load(file, extras = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText, {exports, localStorage:storage, ...extras});
  return exports;
}
let history = load('components/showcase/loadHistory.ts');
assert.equal(history.hasLoadedModel('v1:4K'), false);
history.rememberLoadedModel('v1:4K');
history = load('components/showcase/loadHistory.ts');
assert.equal(history.hasLoadedModel('v1:4K'), true, 'survives module reload');
assert.equal(history.hasLoadedModel('v2:4K'), false, 'new asset version has no success receipt');
assert.equal(history.hasLoadedModel('v1:RAW'), false, 'quality changes are independent');
data.set('fire:showcase:loaded-models:v1','broken');
assert.equal(history.hasLoadedModel('missing'),false);
history = load('components/showcase/loadHistory.ts', {localStorage:{getItem(){throw Error();},setItem(){throw Error();}}});
history.rememberLoadedModel('private');
assert.equal(history.hasLoadedModel('private'),true);
(async () => {
 const cache = load('components/showcase/assetCache.ts', {caches:{open:async()=>({match:async()=>({arrayBuffer(){throw Error('must not read model bytes');}})})}});
 assert.equal(await cache.isAssetCached('/car.glb'),true);
 const idb = load('components/showcase/assetCache.ts', {indexedDB:{open(){
   const request = {};
   queueMicrotask(()=>{request.result={transaction:()=>({objectStore:()=>({count(){const count={};queueMicrotask(()=>{count.result=1;count.onsuccess();});return count;}})})};request.onsuccess();});
   return request;
 }}});
 assert.equal(await idb.isAssetCached('/car.glb'),true);
 console.log('PASS persistent success, version/quality isolation, disabled storage, metadata-only Cache API and IndexedDB probes');
})().catch(error=>{console.error(error);process.exitCode=1;});
