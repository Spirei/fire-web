// Explicit, backed-up account migration. Run from the deployed fire-web directory.
// node scripts/migrate-stock-connect.cjs --user USER_ID --records ID1,ID2 [--apply]
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), swc = require('next/dist/build/swc');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (m, f) => m._compile(swc.transformSync(fs.readFileSync(f, 'utf8'), { filename: f, jsc: { parser: { syntax: 'typescript' }, target: 'es2022' }, module: { type: 'commonjs' } }).code, f);
const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
if (!args.includes('--user') || !args.includes('--records') || !value('--user') || !value('--records')) throw Error('Usage: --user USER_ID --records ID1,ID2 [--apply]');
const userId = value('--user'), ids = value('--records').split(',').filter(Boolean);
(async () => {
  // Next production dependencies provide native SWC; local development may use its cached WASM fallback.
  await swc.loadBindings();
  // Backup precedes even additive startup schema changes.
  const dataDir = path.join(process.cwd(), 'data');
  if (args.includes('--apply')) {
    const Database = require('better-sqlite3'), source = new Database(path.join(dataDir, 'fire.db'), { readonly: true, fileMustExist: true });
    const backupDir = path.join(dataDir, 'migration-backups'); fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const destination = path.join(backupDir, `stock-connect-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await source.backup(destination); source.close(); fs.chmodSync(destination, 0o600);
    const verified = new Database(destination, { fileMustExist: true });
    // A standalone backup must not depend on WAL sidecars or shared memory on its recovery volume.
    verified.pragma('journal_mode=DELETE');
    if (verified.pragma('integrity_check', { simple: true }) !== 'ok') throw Error('Backup verification failed');
    verified.close();
    console.log(`Backup: ${destination}`);
  }
  const { getDb } = require('../lib/db.ts'), { readRecord } = require('../lib/store.ts');
  const records = ids.map(id => { const r = readRecord(userId, id); if (!r) throw Error('Owner or record not found'); return r; });
  console.log(JSON.stringify(records.map(r => ({ id: r.id, name: r.name, code: r.code, market: r.market, accountMarket: r.accountMarket || r.market, qty: r.qty, revision: r.revision })), null, 2));
  if (args.includes('--apply')) {
    const { FALLBACK_RATES } = require('../lib/types.ts');
    const result = require('../lib/stockConnectMigration.ts').migrateStockConnect(userId, records.map(r => ({ id: r.id, revision: r.revision })), FALLBACK_RATES);
    console.log(JSON.stringify({ migrated: result.records.length, removedSources: result.removedSources, summary: result.summary }, null, 2));
  }
  getDb().close();
  process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
