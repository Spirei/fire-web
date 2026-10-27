const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), resolve = Module._resolveFilename, load = Module._load;
Module._resolveFilename = function(id, parent, ...rest) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...rest); };
Module._load = function(id, parent, ...rest) {
  if (id === '@/lib/auth') return { getAuthUser: () => ({ id: 1 }), isAdmin: () => true };
  if (id === '@/lib/db') return { getDb: () => ({ prepare: () => ({ get: () => undefined }) }) };
  if (id === '@/lib/deploySecrets') return { decryptDeploySecret: () => '' };
  return load.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
process.env.GITHUB_TOKEN = 'isolated-test'; process.env.GITHUB_REPOSITORY = 'example/test';
const sha = 'a'.repeat(40), run = { id: 1, path: '.github/workflows/docker-publish.yml', event: 'schedule', status: 'completed', conclusion: 'success', head_sha: sha };
const route = require('../app/api/deploy-status/route.ts');
let dispatches = 0, mode = 'published';
global.fetch = async (url, options) => {
  if (options?.method === 'POST') { dispatches++; return new Response(null, { status: 204 }); }
  if (mode === 'error') return Response.json({}, { status: 503 });
  if (String(url).includes('/commits/main')) return Response.json({ sha });
  if (String(url).includes('/jobs?')) return Response.json({ jobs: [{ name: 'Publish linux/amd64 image', conclusion: 'success' }] });
  if (String(url).includes('status=success')) return Response.json({ workflow_runs: [run] });
  return Response.json({ workflow_runs: mode === 'active' ? [{ ...run, status: 'queued' }] : [] });
};
(async () => {
  const req = () => new Request('https://example.test/api/deploy-status', { method: 'POST' });
  let response = await route.POST(req()); assert.equal(response.status, 409); assert.match((await response.json()).error, /已有可用镜像/);
  mode = 'error'; response = await route.POST(req()); assert.equal(response.status, 502);
  mode = 'active'; response = await route.POST(req()); assert.equal(response.status, 409);
  assert.equal(dispatches, 0);
  console.log('PASS deploy status: published SHA, unavailable preflight and active release never dispatch duplicate builds');
})().catch(error => { console.error(error); process.exitCode = 1; });
