const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
assert(!fs.existsSync(path.join(root,'scripts/platform.py')));
const result = spawnSync('python3', ['-c', `
import sys
sys.path.insert(0, sys.argv[1])
sys.platform = 'linux'
import uuid
import platform
assert callable(platform.system)
assert uuid.uuid4().version == 4
`, path.join(root,'scripts')], {encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
const launcher=fs.readFileSync(path.join(root,'scripts/fire.mjs'),'utf8');
assert.equal((launcher.match(/scripts\/fire_platform\.py/g)||[]).length,3);
console.log('PASS Linux uuid imports standard platform and all launch modes use renamed entry');

(async () => {
  const { pythonExecutable } = await import('../scripts/fire-runtime.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-startup-'));
  try {
    assert.equal(pythonExecutable(dir, {}), 'python3');
    fs.mkdirSync(path.join(dir, '.venv/bin'), {recursive:true});
    fs.writeFileSync(path.join(dir, '.venv/bin/python'), '');
    for (const platform of ['linux', 'darwin'])
      assert.equal(pythonExecutable(dir, {}, platform), path.join(dir, '.venv/bin/python'));
    assert.equal(pythonExecutable(dir, {FIRE_PYTHON:'/explicit/python'}), '/explicit/python');
    fs.mkdirSync(path.join(dir, '.venv/Scripts'), {recursive:true});
    fs.writeFileSync(path.join(dir, '.venv/Scripts/python.exe'), '');
    assert.equal(pythonExecutable(dir, {}, 'win32'), path.join(dir, '.venv/Scripts/python.exe'));
    console.log('PASS project Python on macOS/Linux/Windows and explicit interpreter override');
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
