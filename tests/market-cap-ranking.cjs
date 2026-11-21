const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};

const { compareMarketCapRanks } = require('../lib/marketCapRankHistory.ts');
const { marketCapStockKey, marketCapLibraryIcon } = require('../lib/marketCapIcons.ts');
const us = { market: 'US', code: 'TEST', type: 'stock' };
const hk = { market: 'HK', code: '700.HK', type: 'stock' };
const crypto = { market: null, code: 'TEST', type: 'crypto' };
const unknown = { market: null, code: 'TEST', type: 'stock' };
const firstTime = Date.parse('2026-11-21T07:00:00Z');
const secondTime = Date.parse('2026-11-21T08:00:00Z');

assert.deepEqual(marketCapStockKey(hk), { market: 'HK', code: '00700' });
assert.equal(marketCapStockKey(unknown), null);
assert.equal(marketCapLibraryIcon(unknown, { 'US:TEST': '/stock.png' }, { TEST: '/coin.png' }), undefined);
assert.equal(marketCapLibraryIcon(crypto, {}, { TEST: '/coin.png' }), '/coin.png');

const first = compareMarketCapRanks([us, hk, crypto, unknown], firstTime, null);
assert.deepEqual(first.changes, [null, null, null, null]);
const next = [crypto, { ...hk, code: '00700' }, us, unknown];
const second = compareMarketCapRanks(next, secondTime, first.history);
assert.deepEqual(second.changes, [2, 0, -2, null]);
assert.equal(second.comparedAt, firstTime);
assert.deepEqual(compareMarketCapRanks(next, secondTime, JSON.parse(JSON.stringify(second.history))), second);
assert.deepEqual(compareMarketCapRanks([us], firstTime, second.history), { changes: [null] });
assert.deepEqual(compareMarketCapRanks([us], NaN, second.history), { changes: [null] });

const duplicate = compareMarketCapRanks([hk, { ...hk, code: '00700' }], secondTime, first.history);
assert.deepEqual(duplicate.changes, [null, null]);
assert.deepEqual(compareMarketCapRanks([hk], secondTime + 1, duplicate.history).changes, [null]);
assert.deepEqual(compareMarketCapRanks([us], secondTime, { previous: { at: -1e30, ranks: {} } }).changes, [null]);

console.log('PASS ranking comparisons use different observations and unambiguous asset identities.');
