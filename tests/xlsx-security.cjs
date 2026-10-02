// Hostile archives are tiny fixtures; no real account files are opened or changed.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module'), ts = require('typescript'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const ledger = require(path.join(root, 'lib/simpleLedgerXlsx.ts'));
const { readSafeXlsxEntries } = require(path.join(root, 'lib/orderImportXlsx.ts'));
function archive(data, declared = data.length) {
  const packed = zlib.deflateRawSync(data), name = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('ordinary ExcelJS ledger exports round-trip through the shared bounded preflight', async () => {
    const bytes = await ledger.xlsxBuffer([{ name: '中英文 O\'Brien', cur: 'USD', bucket: '长期', expected: 8, hist: [{ d: '2026-09-01', v: 1000, inn: 1000, out: 0 }, { d: '2026-10-01', v: 1120, inn: 20, out: 0 }] }]);
    assert(readSafeXlsxEntries(bytes).some(entry => entry.name === 'xl/workbook.xml'));
    const accounts = await ledger.parseYouzhiyouxing(bytes);
    assert.equal(accounts.length, 1); assert.equal(accounts[0].name, '中英文 O\'Brien'); assert.equal(accounts[0].cur, 'USD');
    assert.equal(accounts[0].amount, 1120); assert.equal(accounts[0].hist[1].d, '2026-10-01');
  });
  await test('forged decompressed sizes are blocked before ExcelJS parses ZIP contents', async () => {
    const bytes = archive(Buffer.alloc(1024 * 1024), 10);
    assert.throws(() => ledger.assertSafeXlsxArchive(bytes), error => error.code === 'ERR_BUFFER_TOO_LARGE');
    await assert.rejects(() => ledger.parseYouzhiyouxing(bytes), error => error.code === 'ERR_BUFFER_TOO_LARGE');
  });
  await test('compression ratio, entry size and inaccurate lengths are rejected', () => {
    assert.throws(() => ledger.assertSafeXlsxArchive(archive(Buffer.alloc(1024 * 1024))), /解压后过大/);
    assert.throws(() => ledger.assertSafeXlsxArchive(archive(Buffer.from('small'), 21 * 1024 * 1024)), /解压后过大/);
    assert.throws(() => ledger.assertSafeXlsxArchive(archive(Buffer.from('small'), 6)), /大小不符/);
  });
  await test('directory boundaries, local-header mismatches and encryption cannot reach a workbook parser', () => {
    const valid = archive(Buffer.from('small')), end = valid.length - 22, central = valid.readUInt32LE(end + 16);
    for (const change of [
      bytes => bytes.writeUInt16LE(1, end + 4),
      bytes => bytes.writeUInt16LE(2001, end + 10),
      bytes => bytes.writeUInt32LE(central + 1, end + 16),
      bytes => bytes.writeUInt16LE(1, central + 8),
      bytes => bytes.writeUInt16LE(0, 8),
      bytes => bytes.writeUInt32LE(central + 1, central + 20)
    ]) { const bytes = Buffer.from(valid); change(bytes); assert.throws(() => ledger.assertSafeXlsxArchive(bytes)); }
    assert.throws(() => ledger.assertSafeXlsxArchive(Buffer.concat([valid, Buffer.from('trailing archive')])));
  });
  console.log(`${passed} XLSX security suites passed (generated workbooks and bounded hostile fixtures)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
