import assert from 'node:assert/strict';
import fs from 'node:fs';
import { environment, RELEASES } from '../scripts/showcase-ktx.mjs';
import { gltfCli, runGltf } from '../scripts/gltf-cli.mjs';
const env = environment('C:\\工具 空格\\KTX', { Path: 'C:\\Windows', PATH: 'C:\\Node', Other: 'keep' }, 'win32');
assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'), ['PATH']);
assert.equal(env.PATH, 'C:\\工具 空格\\KTX\\bin;C:\\Windows;C:\\Node'); assert.equal(env.Other, 'keep'); assert.equal(env.LD_LIBRARY_PATH, undefined);
for (const arch of ['x64','arm64']) { assert(RELEASES['win32-'+arch][0].endsWith('.exe')); assert.match(RELEASES['win32-'+arch][1], /^[0-9a-f]{64}$/); }
assert(fs.existsSync(gltfCli)); assert.equal(runGltf(['--version']).status, 0);
console.log('PASS cross-platform CLI entry, Windows PATH casing, official installer hashes');
