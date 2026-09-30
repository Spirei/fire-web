const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) {
  return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, filename);
const { createPasskeySettingsData } = require('../lib/passkeySettingsData.ts');
const art = require('../app/api/system-assets/passkey/route.ts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-passkey-settings-'));
const nativeNow = Date.now;
let time = 100000;
Date.now = () => time;
const config = { enabled: true, origin: 'https://fire.example.test', name: 'Alcor', revision: '1' };
const snapshot = { config, keys: [], totpEnabled: true };
let calls = 0;
global.fetch = async url => {
  calls++;
  return Response.json(url.endsWith('/config') ? config : { keys: [], totpEnabled: true });
};
(async () => {
  const source = createPasskeySettingsData(snapshot);
  assert.equal(source.peek(), snapshot);
  await source.read();
  assert.equal(calls, 0, 'Fresh server snapshot avoids duplicate entry requests');
  time += 11000;
  assert.equal(source.peek(), snapshot, 'Expired cache keeps a non-empty first frame');
  const first = source.read(), second = source.read();
  assert.equal(first, second, 'Concurrent entry and prefetch share one request');
  await first;
  assert.equal(calls, 2);
  time += 11000;
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(source.read());
  assert.equal(source.peek().totpEnabled, true, 'Failure cannot silently erase TOTP state');
  source.invalidate();
  assert.equal(source.peek(), null, 'Writes/account unmount discard cached metadata');
  assert.equal(createPasskeySettingsData().peek(), null, 'Accounts never share snapshots');
  console.log('PASS seed, expiry, single-flight, failure and invalidation');

  process.chdir(temp);
  const relative = 'feature/passkey/passkey.png';
  fs.mkdirSync(path.dirname(path.join(temp, 'resource-default', relative)), { recursive: true });
  fs.copyFileSync(path.join(root, 'public/uploads', relative), path.join(temp, 'resource-default', relative));
  let response = art.GET();
  assert.equal(response.status, 200, 'Empty upload volume still serves bundled image');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  fs.mkdirSync(path.dirname(path.join(temp, 'public/uploads', relative)), { recursive: true });
  fs.writeFileSync(path.join(temp, 'public/uploads', relative), 'invalid host override');
  response = art.GET();
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, 'System copy wins over host upload');
  fs.unlinkSync(path.join(temp, 'resource-default', relative));
  fs.unlinkSync(path.join(temp, 'public/uploads', relative));
  response = art.GET();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  console.log('PASS empty volume, host override and missing-resource response');

  process.env.STOCKLOG_FUTU = 'off';
  const auth = require('../lib/auth.ts');
  const user = auth.createUser('snapshot_user', 'Test-only-password-938!');
  const { passkeySettingsSnapshot } = require('../lib/passkeySettingsSnapshot.ts');
  const publicSnapshot = passkeySettingsSnapshot(user.id);
  assert.deepEqual(Object.keys(publicSnapshot.config).sort(), ['enabled', 'name', 'origin', 'revision']);
  assert.deepEqual(publicSnapshot.keys, []);
  assert.equal(typeof publicSnapshot.totpEnabled, 'boolean');
  assert(!JSON.stringify(publicSnapshot).includes('password_hash'));
  const other = auth.createUser('snapshot_other', 'Test-only-password-429!');
  const db = require('../lib/db.ts').getDb();
  db.prepare('INSERT INTO passkeys(id,user_id,user_handle,rp_id,public_key,counter,name,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('public-credential-id', user.id, 'private-user-handle', 'fire.example.test', Buffer.from('credential-material'), 0, 'iCloud', time);
  const withKey = passkeySettingsSnapshot(user.id);
  assert.deepEqual(Object.keys(withKey.keys[0]).sort(), ['backedUp', 'createdAt', 'id', 'lastUsedAt', 'name', 'rpID']);
  assert(!JSON.stringify(withKey).includes('private-user-handle'));
  assert(!JSON.stringify(withKey).includes('credential-material'));
  assert.deepEqual(passkeySettingsSnapshot(other.id).keys, [], 'Only current-account keys enter the HTML snapshot');
  console.log('PASS authenticated snapshot exposes public metadata only');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  Date.now = nativeNow;
  process.chdir(root);
  // Only this explicitly-created disposable test directory is removed.
  fs.rmSync(temp, { recursive: true, force: true });
});
