const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE custom_cards(id TEXT PRIMARY KEY,user_id TEXT,name TEXT,bank TEXT,region TEXT,type TEXT,brand TEXT,level TEXT,image TEXT,currency_scope TEXT,created_at TEXT);CREATE TABLE card_holdings(user_id TEXT,card_key TEXT,created_at TEXT,PRIMARY KEY(user_id,card_key));CREATE TABLE card_amounts(user_id TEXT,card_key TEXT,amount REAL NOT NULL,currency TEXT,note TEXT,updated_at TEXT,PRIMARY KEY(user_id,card_key));`);
const calls = [], cache = new Map(); let next = 0, limited = false;
const aliases = {
  'next/server': { NextResponse: { json: (body, options = {}) => ({ status: options.status || 200, body, headers: options.headers || {} }) } },
  '@/lib/requestBody': { readJsonBody: async request => request.body },
  '@/lib/auth': { getAuthUser: request => request.owner ? { id: request.owner, role: request.owner === 'admin' ? 'admin' : 'user' } : null, isAdmin: user => user.role === 'admin' },
  '@/lib/rateLimit': { clientIp: () => 'synthetic-peer', rateLimit: () => !limited },
  '@/lib/cardLibrary': { readCardManifest: () => input.manifest },
  '@/lib/assets': { upsertAsset: value => calls.push({ kind: 'upsert', value }), deleteAsset: id => calls.push({ kind: 'delete', id }) },
  './db': { getDb: () => db },
  'node:crypto': { randomUUID: () => '11111111-1111-4111-8111-' + String(++next).padStart(12, '0') },
};
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const mapping = { '@/lib/cardCustom': 'cardCustom.ts', '@/lib/hanConvert': 'hanConvert.ts', '@/lib/cardAssets': 'cardAssets.ts', '@/lib/cardAmounts': 'cardAmounts.ts', route: 'route.ts', amountsRoute: 'amountsRoute.ts' };
  if (aliases[name]) return aliases[name];
  if (!mapping[name]) throw new Error('Unsupported frozen dependency: ' + name);
  const file = path.join(__dirname, 'fixtures', 'card-custom-source', mapping[name]);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} }; cache.set(name, module.exports);
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { URL, console }, { filename: mapping[name] })(load, module, module.exports);
  return module.exports;
}
(async () => {
  for (const row of input.amounts || []) db.prepare('INSERT INTO card_amounts VALUES(?,?,?,?,?,?)').run(row.owner,row.cardKey,row.amount,row.currency,row.note,row.updatedAt);
  const route = load(input.route === 'amounts' ? 'amountsRoute' : 'route'), references = {}, results = [];
  for (const step of input.steps) {
    limited = !!step.limited;
    if (step.method === 'HOLD') {
      db.prepare('INSERT INTO card_holdings VALUES(?,?,?) ON CONFLICT DO NOTHING').run(step.owner, step.image, '2020-01-01');
      continue;
    }
    const query = step.idRef ? '?id=' + encodeURIComponent(references[step.idRef]) : step.query || '';
    const response = await route[step.method]({ url: 'http://legacy.invalid/api/cards/custom' + query, owner: step.owner || null, body: step.body });
    if (step.ref && response.body.card) references[step.ref] = response.body.card.id;
    results.push({ name: step.name, status: response.status, body: response.body });
  }
  process.stdout.write(JSON.stringify({ results, calls, holdings: db.prepare('SELECT user_id,card_key FROM card_holdings ORDER BY user_id,card_key').all() }));
  db.close();
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
