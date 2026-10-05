const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ts = require('typescript'), Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..'), previous = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-backup-runtime-'));
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
(async () => {
  const copy = fs.promises.copyFile;
  try {
    process.chdir(temp); fs.mkdirSync('data', { recursive: true }); fs.mkdirSync('public/uploads/logo', { recursive: true });
    const db = new Database('data/fire.db'); db.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES(\'kept\')'); db.close();
    for (let i = 0; i < 8; i++) fs.writeFileSync(`public/uploads/logo/${i}.txt`, `artwork-${i}`);
    let active = 0, peak = 0, copies = 0;
    fs.promises.copyFile = async (...args) => { active++; peak = Math.max(peak, active); copies++; try { await new Promise(resolve => setTimeout(resolve, 15)); return await copy(...args); } finally { active--; } };
    const file = path.join(root, 'lib/backup.ts'), first = require(file);
    first.saveBackupConfig({ enabled: false, intervalHours: 24, keep: 7, lastAt: 0, lastFile: '', lastSize: 0 });
    const pending = first.runBackup();
    delete require.cache[file]; const reloaded = require(file);
    assert.strictEqual(reloaded.runBackup(), pending, 'HMR and module copies must share one backup');
    const snapshot = await pending;
    assert.equal(peak, 1, 'large copies must leave libuv workers free for the server'); assert.equal(copies, 8);
    assert.deepEqual((await first.listBackups()).map(b => b.name), [snapshot.name]);
    assert.equal(fs.readFileSync(`data/backups/${snapshot.name}/uploads/logo/7.txt`, 'utf8'), 'artwork-7');
    const restore = new Database(`data/backups/${snapshot.name}/fire.db`, { readonly: true }); assert.equal(restore.prepare('SELECT value FROM sample').get().value, 'kept'); restore.close();
    assert.equal(reloaded.getBackupConfig().lastFile, snapshot.name);
    console.log('PASS slow copies are serialized, HMR shares one snapshot, and database/assets remain restorable');
    fs.unlinkSync(`data/backups/${snapshot.name}/.backup-meta.json`);
    const stat = fs.promises.stat, syncStat = fs.statSync;
    let timerRan = false;
    fs.promises.stat = async (...args) => { await new Promise(resolve => setTimeout(resolve, 10)); return stat(...args); };
    fs.statSync = (...args) => { if (String(args[0]).includes('backups')) throw Error('backup scan cannot use synchronous filesystem access'); return syncStat(...args); };
    try {
      const timer = setTimeout(() => { timerRan = true; }, 5);
      const legacy = await reloaded.listBackups(); clearTimeout(timer);
      assert(timerRan, 'event loop remains responsive while a legacy snapshot is scanned');
      assert.equal(legacy[0].name, snapshot.name); assert(legacy[0].size > 0);
    } finally { fs.promises.stat = stat; fs.statSync = syncStat; }
    console.log('PASS legacy backup scans yield to requests and preserve their file-size result');
    fs.promises.copyFile = async () => { throw new Error('simulated copy failure'); };
    await assert.rejects(first.runBackup(), /simulated copy failure/);
    assert.deepEqual(fs.readdirSync('data/backups'), [snapshot.name]);
    assert.equal(reloaded.getBackupConfig().lastFile, snapshot.name, 'failed copy cannot replace the completed snapshot');
    fs.promises.copyFile = copy;
    assert((await reloaded.runBackup()).size > 0, 'failure must release the process-wide task');
    console.log('PASS failed copy removes only its incomplete snapshot and permits retry');
  } finally { fs.promises.copyFile = copy; process.chdir(previous); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
