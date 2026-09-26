const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const Database = require('better-sqlite3');
const ts = require('typescript');

// Production limiter with real SQLite, isolated from app data and seeding.
function loadLimiter(db) {
  const filename = path.resolve(__dirname, '../lib/rateLimit.ts');
  const m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = m.require.bind(m);
  m.require = name => name === './db' ? { getDb: () => db } : original(name);
  m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText, filename);
  return m.exports;
}
if (!isMainThread) {
  process.env.RATE_LIMIT_STORE = 'sqlite';
  const db = new Database(workerData.file);
  const { rateLimit } = loadLimiter(db);
  const gate = new Int32Array(workerData.gate);
  parentPort.postMessage('ready'); Atomics.wait(gate, 0, 0);
  let admitted = 0;
  for (let i=0; i<40; i++) if (rateLimit('concurrent', 25, 60000)) admitted++;
  db.close(); parentPort.postMessage(admitted);
} else {
  (async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-rate-limit-'));
    const file = path.join(temp, 'limit.db');
    const db = new Database(file);
    const workers = [];
    try {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE rate_limit(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)');
      const { rateLimit, clientIp } = loadLimiter(db);
      process.env.RATE_LIMIT_STORE = 'sqlite';
      assert.equal(rateLimit('boundary', 2, 60000), true);
      assert.equal(rateLimit('boundary', 2, 60000), true);
      assert.equal(rateLimit('boundary', 2, 60000), false);
      assert.equal(db.prepare('SELECT count FROM rate_limit WHERE key=?').get('boundary').count, 2);
      db.prepare('UPDATE rate_limit SET reset_at=0 WHERE key=?').run('boundary');
      assert.equal(rateLimit('boundary', 2, 60000), true);
      assert.equal(db.prepare('SELECT count FROM rate_limit WHERE key=?').get('boundary').count, 1);
      console.log('PASS SQLite limit boundary and expired-window reset');
      const contended = loadLimiter({ prepare() { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); } });
      assert.equal(contended.rateLimit('contention', 25, 60000), false);
      console.log('PASS database contention cannot bypass the shared budget via memory fallback');
      const req = value => new Request('https://fire.example.test', { headers: { 'x-forwarded-for': value } });
      delete process.env.FIRE_TRUST_PROXY_HEADERS;
      assert.equal(clientIp(req('192.0.2.1')), 'direct');
      process.env.FIRE_TRUST_PROXY_HEADERS = 'true';
      for (const bad of ['deadbeef', '999.1.1.1', '::::', 'fe80::1%en0', '']) assert.equal(clientIp(req(bad)), 'unknown');
      assert.equal(clientIp(req('192.0.2.1, 10.0.0.1')), '192.0.2.1');
      assert.equal(clientIp(req('2001:0DB8:0000:0000:0000:0000:0000:0001')), clientIp(req('2001:db8::1')));
      console.log('PASS proxy trust, malformed IP rejection and IPv6 canonicalization');
      process.env.RATE_LIMIT_STORE = 'memory';
      assert.equal(rateLimit('memory', 1, 60000), true);
      assert.equal(rateLimit('memory', 1, 60000), false);
      console.log('PASS memory fallback enforces its limit');
      const gate = new SharedArrayBuffer(4);
      const ready = [], results = [];
      for (let i=0; i<4; i++) {
        const worker = new Worker(__filename, { workerData: { file, gate } });
        workers.push(worker);
        ready.push(new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
        results.push(new Promise((resolve, reject) => {
          worker.on('message', value => { if (typeof value === 'number') resolve(value); });
          worker.once('error', reject);
          worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
        }));
      }
      await Promise.all(ready);
      Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
      const counts = await Promise.all(results);
      assert.equal(counts.reduce((a,b) => a+b, 0), 25);
      assert.equal(db.prepare('SELECT count FROM rate_limit WHERE key=?').get('concurrent').count, 25);
      console.log('PASS four concurrent workers admit exactly 25 of 160 attempts');
      console.log('5 rate-limit suites passed');
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
      db.close(); fs.rmSync(temp, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
