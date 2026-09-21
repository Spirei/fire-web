const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(fs.readFileSync('components/showcase/generationProgress.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(mod, mod.exports);
const { generationDetail, readGenerationStatus } = mod.exports;
(async () => {
  assert.match(generationDetail({ phase: 'gpu', fileBytes: 1048576, textureBytes: 2 * 1024 ** 3, startedAt: 1000 }, 62000), /文件 1.0 MiB.*贴图展开约 2.00 GiB.*61 秒/);
  assert.match(generationDetail({ phase: 'done' }), /处理完成/);
  let calls = 0; const retries = [], delays = [];
  const result = await readGenerationStatus('job', n => retries.push(n), { wait: async ms => delays.push(ms), fetcher: async (url, options) => {
    assert.match(url, /jobId=job/); assert.equal(options.method, undefined, 'never restart encoding');
    if (++calls === 1) throw new Error('offline');
    if (calls === 2) return new Response('', { status: 503 });
    return Response.json({ status: 'done', gpuReused: 1 });
  } });
  assert.equal(result.status, 'done'); assert.deepEqual(retries, [1, 2]); assert.deepEqual(delays, [1000, 2000]);
  calls = 0;
  const denied = await readGenerationStatus('job', () => assert.fail('must not retry auth'), { fetcher: async () => { calls++; return Response.json({ error: '未登录' }, { status: 401 }); } });
  assert.equal(denied.error, '未登录'); assert.equal(calls, 1);
  await assert.rejects(readGenerationStatus('job', () => {}, { wait: async () => {}, fetcher: async () => { throw new Error('offline'); } }), /后台任务可能仍在运行/);
  console.log('PASS progress metrics, elapsed time, transient retry, no duplicate POST, authorization and disconnect messages');
})().catch(error => { console.error(error); process.exitCode = 1; });
