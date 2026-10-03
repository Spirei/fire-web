// File/API integration regression: all writes use a disposable database and tree.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alcor-file-security-'))); process.chdir(temp);
fs.mkdirSync('data'); fs.writeFileSync('data/backup-config.json', JSON.stringify({ enabled: false }));
process.env.STOCKLOG_FUTU = 'off'; process.env.FIRE_APP_ORIGIN = 'https://files.test.example';
global.fetch = async () => { throw new Error('Network disabled in isolated tests'); };
const load = file => require(path.join(root, file));
const auth = load('lib/auth.ts'), db = load('lib/db.ts').getDb();
const owner = auth.createUser('file_owner', 'File-test-123'), other = auth.createUser('file_other', 'File-test-123');
const admin = auth.createUser('file_admin', 'File-test-123'); db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
const sessions = new Map([owner, other, admin].map(user => [user.id, auth.createSession(user.id)]));
const origin = process.env.FIRE_APP_ORIGIN;
function request(endpoint, user = owner, method = 'GET', body) {
  const headers = user ? { cookie: 'fire_session=' + sessions.get(user.id), origin } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(origin + endpoint, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const groups = load('lib/watchGroupsStore.ts'), groupRoute = load('app/api/v1/watch-groups/[id]/route.ts');
const cleanup = load('lib/fileCleanup.ts'), cards = load('app/api/cards/custom/route.ts');
const uploads = load('app/uploads/[...path]/route.ts'), attachments = load('app/api/attachments/route.ts');
function fixture(relative, bytes = 'protected fixture') {
  const file = path.join(temp, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
function groupContext(id) { return { params: Promise.resolve({ id }) }; }
async function icon(group, url) {
  const response = await groupRoute.PUT(request('/api/v1/watch-groups/' + group.id, owner, 'PUT', { icon: url }), groupContext(group.id));
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
}
let passed = 0;
async function test(name, run) { db.prepare('DELETE FROM rate_limit').run(); await run(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('cleanup confines decoded paths and symlink parents to uploads', () => {
    fixture('public/uploads/asset/safe.png');
    assert.equal(cleanup.localPathOf('/uploads/asset/safe.png'), path.join(temp, 'public/uploads/asset/safe.png'));
    for (const url of ['/uploads/../protected.js', '/uploads/%2e%2e/protected.js', '/uploads/asset/../../protected.js', '/uploads/asset\\..\\protected.js', '/uploads/%00.png']) assert.throws(() => cleanup.localPathOf(url));
    fixture('outside/data.txt'); fs.symlinkSync(path.join(temp, 'outside'), path.join(temp, 'public/uploads/escape'));
    assert.throws(() => cleanup.localPathOf('/uploads/escape/data.txt'));
    assert.throws(() => cleanup.localPathOf('/uploads/escape/new.txt'));
  });
  await test('ordinary watch-group icon delete cannot remove public files outside uploads', async () => {
    const file = fixture('public/protected.js'), group = groups.createWatchGroup(owner.id, '越界图标');
    await icon(group, '/uploads/../protected.js');
    const response = await groupRoute.DELETE(request('/api/v1/watch-groups/' + group.id, owner, 'DELETE'), groupContext(group.id));
    assert.equal(response.status, 200); assert.equal(fs.readFileSync(file, 'utf8'), 'protected fixture');
  });
  await test('borrowed uploads survive ordinary group replacement, reset and delete', async () => {
    const urls = ['/uploads/fonts/custom-2-victim.woff2', `/uploads/asset/group/${other.id}/wg-victim/owned.png`];
    for (const [index, url] of urls.entries()) {
      const file = fixture('public' + url);
      for (const action of ['replace', 'reset', 'delete']) {
        const group = groups.createWatchGroup(owner.id, `借图${index}${action}`); await icon(group, url);
        if (action === 'delete') {
          assert.equal((await groupRoute.DELETE(request('/api/v1/watch-groups/' + group.id, owner, 'DELETE'), groupContext(group.id))).status, 200);
        } else await icon(group, action === 'reset' ? '' : '/uploads/asset/new.png');
        assert.equal(fs.readFileSync(file, 'utf8'), 'protected fixture');
      }
    }
  });
  await test('owned watch-group files still clean up after replacement and deletion', async () => {
    const group = groups.createWatchGroup(owner.id, '自己的图标');
    const prefix = `/uploads/asset/group/${owner.id}/${group.id}/`;
    const first = fixture('public' + prefix + 'first.png'), next = fixture('public' + prefix + 'next.png');
    await icon(group, prefix + 'first.png'); await icon(group, prefix + 'next.png'); assert(!fs.existsSync(first));
    assert.equal((await groupRoute.DELETE(request('/api/v1/watch-groups/' + group.id, owner, 'DELETE'), groupContext(group.id))).status, 200);
    assert(!fs.existsSync(next));
    const symlinkGroup = groups.createWatchGroup(owner.id, '链接图标');
    const foreignDir = path.join(temp, 'public/uploads/asset/group', other.id, 'wg-linked');
    const foreign = fixture(path.relative(temp, path.join(foreignDir, 'foreign.png')));
    const link = path.join(temp, 'public/uploads/asset/group', owner.id, symlinkGroup.id); fs.symlinkSync(foreignDir, link);
    await icon(symlinkGroup, `/uploads/asset/group/${owner.id}/${symlinkGroup.id}/foreign.png`);
    await groupRoute.DELETE(request('/api/v1/watch-groups/' + symlinkGroup.id, owner, 'DELETE'), groupContext(symlinkGroup.id));
    assert(fs.existsSync(foreign));
  });
  await test('ordinary personal cards neither overwrite shared assets nor delete their files', async () => {
    const assetStore = load('lib/assets.ts'), key = '/uploads/asset/card/shared.png';
    const file = fixture('public' + key);
    assetStore.upsertAsset({ id: 'card:' + key, type: 'card', market: 'HK', code: 'SHARED', name: '公共卡面', url: key });
    const before = db.prepare('SELECT * FROM assets WHERE id=?').get('card:' + key);
    const response = await cards.POST(request('/api/cards/custom', owner, 'POST', { name: '我的自建卡', bank: '我的银行', region: 'CN', image: key }));
    assert.equal(response.status, 200); const card = (await response.json()).card;
    assert.deepEqual(db.prepare('SELECT * FROM assets WHERE id=?').get('card:' + key), before);
    assert.equal((await cards.DELETE(request('/api/cards/custom?id=' + card.id, owner, 'DELETE'))).status, 200);
    assert.deepEqual(db.prepare('SELECT * FROM assets WHERE id=?').get('card:' + key), before); assert(fs.existsSync(file));
    const font = fixture('public/uploads/fonts/card-victim.woff2');
    const borrowed = await cards.POST(request('/api/cards/custom', owner, 'POST', { name: '借图卡', bank: '借图银行', image: '/uploads/fonts/card-victim.woff2' }));
    assert.equal(borrowed.status, 200); const borrowedCard = (await borrowed.json()).card;
    assert.equal((await cards.DELETE(request('/api/cards/custom?id=' + borrowedCard.id, owner, 'DELETE'))).status, 200); assert(fs.existsSync(font));
  });
  await test('custom card references protect their image from generic orphan cleanup', () => {
    const url = '/uploads/asset/card/private-reference.png', file = fixture('public' + url);
    load('lib/cardCustom.ts').createCustomCard(owner.id, { name: '引用卡', bank: '引用银行', region: '', type: '其他', brand: '', level: '', image: url, currencyScope: '' });
    fs.utimesSync(file, new Date(0), new Date(0));
    assert(cleanup.urlReferenced(url)); assert.equal(cleanup.removeFileIfUnused(url), false);
    cleanup.cleanupOrphanFiles(); assert(fs.existsSync(file));
  });
  await test('administrator card cleanup preserves assets still used by another account', async () => {
    const key = '/uploads/asset/card/multi-user.png', file = fixture('public' + key);
    const userResponse = await cards.POST(request('/api/cards/custom', owner, 'POST', { name: '用户共享卡', bank: '共享银行', image: key })); assert.equal(userResponse.status, 200);
    const adminResponse = await cards.POST(request('/api/cards/custom', admin, 'POST', { name: '管理员共享卡', bank: '共享银行', image: key })); assert.equal(adminResponse.status, 200);
    const card = (await adminResponse.json()).card;
    assert.equal((await cards.DELETE(request('/api/cards/custom?id=' + card.id, admin, 'DELETE'))).status, 200);
    assert(db.prepare('SELECT 1 FROM assets WHERE id=?').get('card:' + key)); assert(fs.existsSync(file));
  });
  await test('report delivery rejects decoded separators and keeps admin authorization', async () => {
    fixture('public/uploads/reports/US/report.pdf', '%PDF report fixture');
    const call = (segments, user) => uploads.GET(request('/uploads/' + segments.join('/'), user), { params: Promise.resolve({ path: segments }) });
    assert.equal((await call(['reports', 'US', 'report.pdf'], null)).status, 403);
    assert.equal((await call(['reports', 'US', 'report.pdf'], owner)).status, 403);
    const adminResponse = await call(['reports', 'US', 'report.pdf'], admin); assert.equal(adminResponse.status, 200); assert.equal(adminResponse.headers.get('cache-control'), 'private, no-store'); await adminResponse.arrayBuffer();
    assert.equal((await call(['reports/US/report.pdf'], null)).status, 400);
    assert.equal((await call(['reports\\US\\report.pdf'], null)).status, 400);
    assert.equal((await call(['REPORTS', 'US', 'report.pdf'], null)).status, 403);
  });
  await test('arbitrary attachment preview is sandboxed and private; users remain denied', async () => {
    fixture('data/attachments/malicious.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>window.attachedScript=true</script></svg>');
    assert.equal((await attachments.GET(request('/api/attachments?action=preview&path=malicious.svg', owner))).status, 403);
    for (const action of ['preview', 'download']) {
      const response = await attachments.GET(request('/api/attachments?action=' + action + '&path=malicious.svg', admin));
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(response.headers.get('content-security-policy'), /^sandbox;/); assert(!response.headers.get('content-security-policy').includes('allow-scripts'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  });
  await test('attachment reads, writes and listings cannot follow an escaping symlink', () => {
    const store = load('lib/attachments.ts'); fixture('outside/attachment.txt');
    fs.symlinkSync(path.join(temp, 'outside'), path.join(temp, 'data/attachments/escape'));
    assert.throws(() => store.readAttachment('escape/attachment.txt')); assert.throws(() => store.writeAttachment('escape/new.txt', Buffer.from('bad')));
    assert.equal(store.listAttachments().files.some(item => item.name === 'escape'), false);
    assert(!fs.existsSync(path.join(temp, 'outside/new.txt')));
  });
  await test('showcase cover cancels an over-limit body without Content-Length before buffering the remainder', async () => {
    const cover = load('app/api/showcase/models/cover/route.ts'); let pulls = 0, cancelled = false;
    const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
    const request = new Request(origin + '/api/showcase/models/cover?id=mcl35m&name=cover.png', { method: 'POST', headers: { cookie: 'fire_session=' + sessions.get(admin.id), origin }, body, duplex: 'half' });
    const response = await cover.POST(request); assert.equal(response.status, 413); assert(cancelled); assert(pulls <= 9, 'bounded body consumption');
  });
  await test('broker XLSX import accepts valid files but bounds real inflation despite forged sizes', () => {
    const { readBrokerOrderSheet } = load('lib/orderImportXlsx.ts'), { buildXlsx } = load('lib/xlsx.ts');
    const valid = buildXlsx([{ name: '订单', headers: ['订单状态', '股票代码'], rows: [['已成交', 'AAPL']] }]);
    assert.equal(readBrokerOrderSheet(valid).rows[0]['股票代码'], 'AAPL');
    function archive(data, declared) {
      const packed = require('node:zlib').deflateRawSync(data), name = Buffer.from('xl/workbook.xml');
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.length, 28);
      const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
      return Buffer.concat([local, name, packed, central, name, end]);
    }
    assert.throws(() => readBrokerOrderSheet(archive(Buffer.alloc(1024 * 1024), 1024 * 1024)), /解压后过大/);
    assert.throws(() => readBrokerOrderSheet(archive(Buffer.alloc(1024 * 1024), 10)), error => error.code === 'ERR_BUFFER_TOO_LARGE');
    assert.throws(() => readBrokerOrderSheet(archive(Buffer.from('tiny'), 21 * 1024 * 1024)), /解压后过大/);
    const invalid = Buffer.from(valid); const eocd = invalid.length - 22; invalid.writeUInt16LE(2001, eocd + 10);
    assert.throws(() => readBrokerOrderSheet(invalid), /结构无效或过大/);
    assert.throws(() => readBrokerOrderSheet(buildXlsx([{ name: '订单', headers: ['订单状态'], rows: Array.from({ length: 20_001 }, () => ['已成交']) }])), /最多导入 20000/);
  });
  await test('backup configuration rounds fractions safely and constrains stored corrupt ranges', async () => {
    const backup = load('lib/backup.ts'), route = load('app/api/backup/route.ts');
    const response = await route.PUT(request('/api/backup', admin, 'PUT', { enabled: false, intervalHours: 0.1, keep: 0.1 }));
    assert.equal(response.status, 200); const config = (await response.json()).config;
    assert.equal(config.intervalHours, 1); assert.equal(config.keep, 1); assert.equal(config.enabled, false);
    backup.saveBackupConfig({ ...config, intervalHours: Infinity, keep: 10000, lastAt: -1, lastSize: NaN });
    const normalized = backup.getBackupConfig(); assert.equal(normalized.intervalHours, 24); assert.equal(normalized.keep, 90); assert.equal(normalized.lastAt, 0); assert.equal(normalized.lastSize, 0);
  });
  await test('concurrent manual backups share one snapshot while same-second follow-ups stay distinct', async () => {
    const backup = load('lib/backup.ts'), Database = require('better-sqlite3');
    const original = Database.prototype.backup, RealDate = Date, now = Date.now(); let calls = 0;
    global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
    Database.prototype.backup = function(...args) { calls++; return original.apply(this, args); };
    backup.saveBackupConfig({ ...backup.getBackupConfig(), enabled: false, keep: 4 });
    fixture('public/uploads/backup-fixture.txt', 'backup fixture');
    try {
      const first = backup.runBackup(), same = backup.runBackup(); assert.strictEqual(first, same);
      const result = await first; assert.equal(calls, 1); assert.deepEqual(await same, result); assert(result.size > 0);
      const snapshot = new Database(path.join(temp, 'data/backups', result.name, 'fire.db'), { readonly: true });
      try { assert(snapshot.prepare('SELECT 1 FROM users WHERE id=?').get(owner.id)); } finally { snapshot.close(); }
      assert.equal(fs.readFileSync(path.join(temp, 'data/backups', result.name, 'uploads/backup-fixture.txt'), 'utf8'), 'backup fixture');
      const followup = await backup.runBackup(); assert.equal(calls, 2); assert.notEqual(followup.name, result.name);
      assert(followup.name.startsWith(result.name + '-')); assert.equal(backup.listBackups().length, 2); assert.equal(backup.getBackupConfig().enabled, false);
    } finally { Database.prototype.backup = original; global.Date = RealDate; }
  });
  await test('scheduled backup respects disablement after its delayed check', () => {
    const backup = load('lib/backup.ts'), now = Date.now, timeout = global.setTimeout; let callback;
    Date.now = () => now() + 60_001;
    global.setTimeout = fn => { callback = fn; return 1; };
    try {
      backup.saveBackupConfig({ ...backup.getBackupConfig(), enabled: true, lastAt: 0 }); backup.maybeRunBackup(); assert.equal(typeof callback, 'function');
      backup.saveBackupConfig({ ...backup.getBackupConfig(), enabled: false }); callback(); assert.equal(backup.listBackups().length, 2);
    } finally { Date.now = now; global.setTimeout = timeout; }
  });
  await test('failed snapshots remove incomplete directories and release the shared backup lock', async () => {
    const backup = load('lib/backup.ts'), Database = require('better-sqlite3'), original = Database.prototype.backup;
    const count = backup.listBackups().length, before = backup.getBackupConfig();
    Database.prototype.backup = () => Promise.reject(new Error('isolated backup failure'));
    try { await assert.rejects(backup.runBackup(), /isolated backup failure/); }
    finally { Database.prototype.backup = original; }
    assert.equal(backup.listBackups().length, count); assert.deepEqual(backup.getBackupConfig(), before);
    const result = await backup.runBackup(); assert(fs.existsSync(path.join(temp, 'data/backups', result.name, 'fire.db'))); assert.equal(backup.listBackups().length, count + 1);
  });
  await test('completed backup sizes remain readable without traversing network uploads and reject invalid indexes', () => {
    const backup = load('lib/backup.ts'), config = backup.getBackupConfig();
    const directory = path.join(temp, 'data/backups', config.lastFile), metaFile = path.join(directory, '.backup-meta.json');
    const originalMeta = fs.readFileSync(metaFile, 'utf8'), originalRead = fs.readdirSync;
    fs.readdirSync = function(directory, ...args) {
      if (String(directory).includes(path.sep + 'uploads')) throw new Error('network traversal prohibited');
      return originalRead.call(this, directory, ...args);
    };
    try {
      assert.equal(backup.listBackups().find(item => item.name === config.lastFile).size, config.lastSize);
      for (const invalid of [JSON.stringify({ version: 1, name: config.lastFile, payloadSize: -1 }), JSON.stringify({ version: 1, name: 'other-snapshot', payloadSize: 1 }), originalMeta + ' '.repeat(1025)]) {
        fs.writeFileSync(metaFile, invalid);
        assert.throws(() => backup.listBackups(), /network traversal prohibited/);
      }
    } finally { fs.readdirSync = originalRead; fs.writeFileSync(metaFile, originalMeta); }
  });
  await test('slow asynchronous backup copies leave completed backups and settings available', async () => {
    const backup = load('lib/backup.ts'), fsp = fs.promises, originalCopy = fsp.copyFile;
    backup.saveBackupConfig({ ...backup.getBackupConfig(), enabled: false, keep: 10 });
    const before = backup.getBackupConfig(), count = backup.listBackups().length;
    let start, release, timeout, settled = false;
    const started = new Promise(resolve => { start = resolve; }), gate = new Promise(resolve => { release = resolve; });
    fsp.copyFile = async function(...args) { start(); await gate; return originalCopy.apply(this, args); };
    const pending = backup.runBackup(); pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('backup never yielded to asynchronous copies')), 2000); })]);
      clearTimeout(timeout);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false); assert.deepEqual(backup.getBackupConfig(), before);
      assert.equal(backup.listBackups().length, count, 'in-progress snapshots must not require a network traversal');
      release(); const result = await pending;
      assert.equal(backup.listBackups().length, count + 1);
      assert.equal(backup.listBackups().find(item => item.name === result.name).size, result.size);
    } finally { clearTimeout(timeout); release(); fsp.copyFile = originalCopy; await pending.catch(() => {}); }
  });
  await test('copy failure waits for outstanding writes before cleaning the failed snapshot', async () => {
    const backup = load('lib/backup.ts'), fsp = fs.promises, originalCopy = fsp.copyFile;
    const before = backup.getBackupConfig(), names = fs.readdirSync('data/backups');
    let otherStarted, release, timeout, calls = 0, settled = false;
    const started = new Promise(resolve => { otherStarted = resolve; }), gate = new Promise(resolve => { release = resolve; });
    fsp.copyFile = async function(...args) {
      if (++calls === 1) { await started; throw new Error('isolated copy failure'); }
      otherStarted(); await gate; return originalCopy.apply(this, args);
    };
    const pending = backup.runBackup(); pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('no outstanding copy')), 2000); })]);
      clearTimeout(timeout); await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'cleanup must wait for outstanding filesystem writes');
      release(); await assert.rejects(pending, /isolated copy failure/);
      assert.deepEqual(fs.readdirSync('data/backups'), names); assert.deepEqual(backup.getBackupConfig(), before);
    } finally { clearTimeout(timeout); release(); fsp.copyFile = originalCopy; await pending.catch(() => {}); }
  });
  console.log(`PASS ${passed} file security regressions`);
  db.close(); process.chdir(root); fs.rmSync(temp, { recursive: true, force: true }); process.exit(0);
})().catch(error => { console.error(error); try { db.close(); process.chdir(root); fs.rmSync(temp, { recursive: true, force: true }); } catch {} process.exit(1); });
