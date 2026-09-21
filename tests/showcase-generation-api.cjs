const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
let child, args, admin = true;
const source = ts.transpileModule(fs.readFileSync('app/api/showcase/models/previews/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const mod = { exports: {} };
const mocks = {
  'next/server': { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
  '@/lib/auth': { getAuthUser: () => ({}), isAdmin: () => admin, isTrustedMutationRequest: () => true },
  '@/lib/requestBody': { readJsonBody: request => request.json() },
  '@/components/showcase/presets/models': { SHOWCASE_MODELS: [{ id: 'mcl35m', config: { assets: { model: '/car.glb' } } }] },
  '@/lib/showcaseModels': { readStoredModels: () => [], validModelId: id => /^[a-z0-9-]+$/.test(id), modelUrlExists: () => true },
  '@/lib/rateLimit': { clientIp: () => 'test', rateLimit: () => true, rateLimitGlobal: () => true },
  'node:child_process': { spawn: (_cmd, argv) => { args = argv; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child; } }
};
new Function('require', 'module', 'exports', source)(id => mocks[id] ?? require(id), mod, mod.exports);
(async () => {
  try {
    const request = () => new Request('http://localhost/api/showcase/models/previews', { method: 'POST', body: JSON.stringify({ id: 'mcl35m' }) });
    admin = false; assert.equal((await mod.exports.POST(request())).status, 403); admin = true;
    const started = await mod.exports.POST(request()); assert.equal(started.status, 202); assert.deepEqual(args.slice(-2), ['--id', 'mcl35m']);
    const concurrent = await mod.exports.POST(request());
    assert.equal(concurrent.status, 409); assert.equal(concurrent.body.jobId, started.body.jobId); assert.equal(concurrent.body.id, "mcl35m");
    const get = () => mod.exports.GET(new Request(`http://localhost/api/showcase/models/previews?jobId=${started.body.jobId}`));
    child.stdout.write('SHOWCASE_PRO'); child.stdout.write('GRESS {"phase":"gpu","model":"MCL35M","count":1,"gpuCount":0}\n');
    assert.equal((await get()).body.phase, 'gpu');
    child.stdout.write('SHOWCASE_PROGRESS {"phase":"done","count":1,"gpuCount":1,"gpuReused":1}\n'); child.emit('close', 0);
    assert.equal((await get()).body.status, 'done'); assert.equal((await get()).body.gpuReused, 1);
    await mod.exports.POST(request()); child.stdout.write('SHOWCASE_PROGRESS {"phase":"error","count":1,"error":"GPU failed"}\n'); child.emit('close', 1);
    const failed = await mod.exports.GET(new Request('http://localhost/api/showcase/models/previews')); assert.equal(failed.body.status, 'error'); assert.equal(failed.body.error, 'GPU failed');
    console.log('PASS admin gate, per-model subprocess, concurrent rejection, split progress stream, success and GPU failure');
  } finally { child?.emit('close', 1); delete globalThis.__showcasePreviewJob; }
})().catch(error => { console.error(error); process.exitCode = 1; });
