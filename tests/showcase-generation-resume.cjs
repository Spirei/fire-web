const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync('components/showcase/ModelImporter.tsx', 'utf8');
const ast = ts.createSourceFile('ModelImporter.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'generatePreviews') initializer = node.initializer.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast); assert(initializer);
const compiled = ts.transpileModule(`export const generate = ${initializer}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
async function scenario(id, status) {
  const exports = {}, ref = { current: false }, messages = []; let posts = 0, reads = 0, refreshes = 0;
  new Function('exports', 'previewGeneratingRef', 'setPreviewGenerating', 'setGenerationDetail', 'fetch', 'showToast', 'window', 'readGenerationStatus', 'formatGenerationDetail', 'router', compiled)(
    exports, ref, () => {}, () => {}, async () => { posts++; return Response.json({ status: 'running', id, jobId: 'existing', error: '任务正在运行' }, { status }); },
    (...message) => messages.push(message), { setTimeout: fn => { fn(); return 0; } },
    async jobId => { assert.equal(jobId, 'existing'); reads++; return { status: 'done', reused: 1, gpuCount: 1, gpuReused: 1 }; }, () => '', { refresh: () => refreshes++ }
  );
  await exports.generate({ id: 'mcl35m', label: 'MCL35M' });
  assert.equal(ref.current, false); assert.equal(posts, 1);
  return { reads, messages, refreshes };
}
(async () => {
  const resumed = await scenario('mcl35m', 409); assert.equal(resumed.reads, 1); assert.equal(resumed.refreshes, 1); assert.match(resumed.messages[0][0], /复用已有预览.*复用 GPU/);
  const other = await scenario('mp45', 409); assert.equal(other.reads, 0); assert.equal(other.messages[0][1], 'err');
  const started = await scenario('mcl35m', 202); assert.equal(started.reads, 1);
  console.log('PASS same-model task resume, cross-model isolation, no duplicate start and reuse completion message');
})().catch(error => { console.error(error); process.exitCode = 1; });
