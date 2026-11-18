// Client input boundaries; server persistence/ownership/concurrency live in native PG tests.
const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
function load(file) {
 const moduleValue={exports:{}};
 new Function('module','exports',ts.transpileModule(fs.readFileSync(require.resolve(file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(moduleValue,moduleValue.exports);
 return moduleValue.exports;
}
const {normalizeSearchQuery,parseSearchMutation}=load('../lib/searchHistory.ts');
const {matchPlatformDestinations}=load('../lib/platformSearch.ts');
assert.equal(normalizeSearchQuery('  ＰＧ   搜索  '),'PG 搜索');
assert.equal(normalizeSearchQuery('x'.repeat(81)),'');
assert.equal(normalizeSearchQuery('x\0y'),'');
assert.equal(parseSearchMutation({action:'clear',revision:0,ownerId:'bob'}),null);
assert.equal(parseSearchMutation({action:'clear',revision:-1}),null);
assert.equal(parseSearchMutation({action:'record',revision:true,query:'query'}),null);
assert.deepEqual(parseSearchMutation({action:'record',revision:0,query:' ＰＧ '}),{action:'record',revision:0,query:'PG'});
const destinations=[
 {label:'应用授权',group:'账号',keywords:'App API 连接'},
 {label:'API 说明',group:'系统',keywords:'API'},
 {label:'API',group:'系统',keywords:'接口 文档'},
 {label:'自动备份',group:'系统',keywords:'数据库 定时 备份'},
];
assert.deepEqual(matchPlatformDestinations(destinations,' ＡＰＩ '),[destinations[2],destinations[1],destinations[0]]);
assert.deepEqual(matchPlatformDestinations(destinations,'数据库　备份'),[destinations[3]]);
assert.deepEqual(matchPlatformDestinations(destinations,'备份 数据库'),[destinations[3]]);
assert.deepEqual(matchPlatformDestinations(destinations,'账号 API'),[destinations[0]]);
assert.deepEqual(matchPlatformDestinations(destinations,'API 缺失'),[]);
console.log('Search matching and history input boundaries passed');
