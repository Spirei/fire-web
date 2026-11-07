const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
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
