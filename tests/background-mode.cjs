const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/backgroundMode.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const context = {exports:{},process:{env:{}}}; vm.runInNewContext(code, context);
const {backgroundMode,verifyWorkerIdentity} = context.exports;
assert.equal(backgroundMode(), 'embedded');
for (const mode of ['embedded','external','off']) assert.equal(backgroundMode(mode), mode);
for (const mode of ['External','unknown',' external']) assert.throws(() => backgroundMode(mode));
for (const [actual,expected] of [[undefined,undefined],['same',undefined],[undefined,'same'],['one','two']]) assert.throws(() => verifyWorkerIdentity(actual,expected));
verifyWorkerIdentity('same','same');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'fire-worker-'));
try {
  const worker = path.resolve(__dirname,'../server-tools/worker.cjs');
  for (const [mode,args] of [['embedded',[]],['off',[]],['external',['--check']],['external',['--invalid']]]) {
    const result = spawnSync(process.execPath,[worker,...args], {cwd:temp,encoding:'utf8',env:{PATH:process.env.PATH,FIRE_BACKGROUND_MODE:mode,NODE_ENV:'test'}});
    assert.equal(result.status,1, result.stderr);
    assert.equal(fs.existsSync(path.join(temp,'data')),false,'refused startup must not initialize any database');
  }
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
console.log('PASS background modes, target identity, refused startup without database side effects');
