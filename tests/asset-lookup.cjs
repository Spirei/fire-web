const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const db = new Database(':memory:');
db.exec('CREATE TABLE assets (id TEXT PRIMARY KEY, type TEXT, market TEXT, code TEXT, name TEXT, url TEXT, url_dark TEXT)');
const insert = db.prepare('INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?)');
for (const [type, market, code] of [['stock','US','AAPL.OQ'],['stock','HK','700'],['stock','JP','7203.T'],['stock','KR','005930.KS'],['stock','CN','000858'],['market','US',''],['crypto','','BTC'],['metal','','GOLD'],['stock','CN','AAPL'],['broker','','AAPL'],['stock','US','MSFT']]) {
  insert.run(type+':'+market+':'+code, type, market, code, code, '', '');
}
const load = Module._load;
let budget = true;
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root,'lib/assets.ts')) {
    if (id === './db') return { getDb: () => db };
    if (id === './settings') return { getSiteSettings: () => ({}) };
    if (id === './fileCleanup') return {};
    if (id === './managedAssetImages') return { managedImageUrl: id => '/api/asset-image/'+encodeURIComponent(id) };
  }
  if (parent?.filename === path.join(root,'app/api/v1/assets/lookup/route.ts') && id === '@/lib/rateLimit') return { clientIp: () => 'fixture', rateLimit: () => budget, rateLimitGlobal: () => budget };
  return load.call(this,id,parent,...rest);
};
const { parseAssetLookup } = require('../lib/assetLookup.ts');
const { getAssetMatches } = require('../lib/assets.ts');
const { GET } = require('../app/api/v1/assets/lookup/route.ts');
const key = (type, code, market = '') => ({type,code,market});
const request = keys => new Request('https://fire.test/api/v1/assets/lookup?keys='+encodeURIComponent(JSON.stringify(keys)));
(async () => {
  const keys = [key('stock','AAPL','US'),key('stock','00700','HK'),key('stock','7203','JP'),key('stock','005930','KR'),key('stock','000858','CN'),key('market','US'),key('crypto','BTC'),key('metal','GOLD')];
  const normalized = parseAssetLookup(JSON.stringify([...keys,key('stock','AAPL.OQ','US')]));
  assert.equal(normalized.length,8);
  const assets = getAssetMatches(normalized);
  assert.equal(assets.length,8); assert(!assets.some(x => x.code === 'MSFT' || x.type === 'broker' || (x.market === 'CN' && x.code === 'AAPL')));
  assert(assets.every(x => x.imageUrl.startsWith('/api/asset-image/')));
  console.log('PASS exact asset reads preserve aliases and fixed image IDs without unrelated catalog rows');
  const response = await GET(request(keys));
  assert.equal(response.status,200); assert.equal((await response.json()).data.length,8); assert(response.headers.get('cache-control').includes('no-store'));
  for (const bad of [null,'garbage',JSON.stringify(Array.from({length:51},()=>key('stock','AAPL','US'))),JSON.stringify([key('broker','AAPL')]),JSON.stringify([key('stock','AAPL')]),JSON.stringify([key('stock',"AAPL'); DROP TABLE assets;",'US')]),JSON.stringify([key('stock','AAPL','US')].concat([null]))]) assert.equal(parseAssetLookup(bad),null);
  assert.equal((await GET(request([key('broker','AAPL')]))).status,400);
  assert.equal((await GET(request([key('stock','.OQ','US')]))).status,400);
  budget = false; assert.equal((await GET(request(keys))).status,429);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,11);
  console.log('PASS malformed, excessive and private asset types are rejected; rate limits apply and reads never mutate rows');
})().catch(error => { console.error(error); process.exitCode=1; }).finally(()=>db.close());
