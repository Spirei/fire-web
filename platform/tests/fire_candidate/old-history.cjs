const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const root = process.env.ALCOR_FIRE_LEGACY_ROOT;
if (!root) throw new Error('Readonly legacy source root is required');
const filename = path.join(root, 'lib/fireAssetHistory.ts');
const source = fs.readFileSync(filename, 'utf8');
const compiled = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const mod = {exports: {}};
new Function('module', 'exports', compiled)(mod, mod.exports);
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  amounts: data.amounts.map(x => mod.exports.validFireAssetAmount(...x)),
  history: mod.exports.readFireAssetHistory(data.history)
}));
