// Client input boundaries; server persistence/ownership/concurrency live in native PG tests.
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const moduleValue={exports:{}};new Function('module','exports',ts.transpileModule(fs.readFileSync(require.resolve('../lib/searchHistory.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(moduleValue,moduleValue.exports);
const {normalizeSearchQuery,parseSearchMutation}=moduleValue.exports;
assert.equal(normalizeSearchQuery('  ＰＧ   搜索  '),'PG 搜索');
assert.equal(normalizeSearchQuery('x'.repeat(81)),'');
assert.equal(normalizeSearchQuery('x\0y'),'');
assert.equal(parseSearchMutation({action:'clear',revision:0,ownerId:'bob'}),null);
assert.equal(parseSearchMutation({action:'clear',revision:-1}),null);
assert.equal(parseSearchMutation({action:'record',revision:true,query:'query'}),null);
assert.deepEqual(parseSearchMutation({action:'record',revision:0,query:' ＰＧ '}),{action:'record',revision:0,query:'PG'});
console.log('Search history client boundaries passed; PG coverage belongs to test_fire_current_web.py');
