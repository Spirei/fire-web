const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// Exercise the workbench's actual derived UI state across a model reload.
const source = fs.readFileSync('components/showcase/ModelImporter.tsx', 'utf8');
const ast = ts.createSourceFile('ModelImporter.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['wheelsOk', 'previewPending', 'wheelWarning', 'materialOptions'];
const initializers = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    initializers.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(initializers.size, names.length);
const derive = new Function('structure', 'previewIsCurrent', 'wheelPick', 'materialCatalog', 'previewFile', 'report', 'previewStatus' ,
  `previewStatus ??= "ready"; const useMemo = fn => fn(); ${names.map(name => `const ${name} = ${initializers.get(name)};`).join('\n')}
   return { previewPending, wheelWarning, materialOptions };`);
const selected = ['front_tire', 'rear_tire'];
const catalog = { file: 'car.glb', names: [...selected, 'body'] };
const result = (structure, current = true, picks = selected) => derive(structure, current, picks, catalog, 'car.glb', null);
assert.equal(result({ wheelGroups: 4 }).wheelWarning, null);
for (const state of [result(null), result({ wheelGroups: 0 }, false)]) {
  assert.equal(state.previewPending, true);
  assert.equal(state.wheelWarning, null, 'pending recognition must not claim the selected wheels are missing');
  assert.deepEqual(state.materialOptions, catalog.names, 'restored workbench without an upload report retains all choices during reload');
}
assert.equal(result({ wheelGroups: 4 }).previewPending, false);
assert.match(result({ wheelGroups: 0 }).wheelWarning, /已勾选.*轴/);
assert.match(result({ wheelGroups: 0 }, true, []).wheelWarning, /请选择/);
assert.deepEqual(derive(null, true, [], catalog, 'other.glb', null).materialOptions, [], 'never carry another model’s materials into the current model');
assert.deepEqual(derive(null, true, selected, null, 'car.glb', { suggestions: { materialNames: selected } }).materialOptions, selected);
console.log('PASS workbench pending/ready/unrecognized/unselected states and material catalog retention/isolation');

function loadTs(file) {
  const mod = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'module', js)(mod.exports, mod);
  return mod.exports;
}
const { wheelSelectionPattern, matchingWheelMaterials, suggestWheelMaterials, validateWorkbench } = loadTs('components/showcase/workbenchUtils.ts');
const choices = ['wheel_screw', 'wheel_screw.001', 'wheel_screw.001_extra', 'front_tire', 'front_wheel_windlet', 'st_wheel'];
assert.deepEqual(matchingWheelMaterials(choices, wheelSelectionPattern(['wheel_screw.001'])), ['wheel_screw.001']);
assert.deepEqual(matchingWheelMaterials(choices, wheelSelectionPattern([])), [], 'clearing selection must not trigger engine defaults');
assert.deepEqual(matchingWheelMaterials(choices, 'tire|wheel_screw'), choices.slice(0, 4), 'legacy regex selections are restored from actual material names');
assert.deepEqual(suggestWheelMaterials(choices), choices.slice(0, 4));
assert(validateWorkbench({ id: 'car', label: 'Car', note: '' }, { wheelLateral: 'x', wheelLongitudinal: 'x' }));
assert(validateWorkbench({ id: 'car', label: 'Car', note: '' }, { length: 0 }));
assert.equal(validateWorkbench({ id: 'car', label: 'Car', note: '' }, { length: 5.6 }), null);

(async () => {
  const { createPreviewUpdates } = loadTs('components/showcase/previewUpdates.ts');
  const a = { assets: { model: 'a.glb' }, model: { wheelPattern: 'tire', emissiveIntensity: .3 } };
  const b = { ...a, model: { ...a.model, wheelPattern: 'rim' } };
  const c = { ...b, model: { ...b.model, emissiveIntensity: .5 } };
  const calls = []; const ready = []; const errors = []; let finish;
  const handle = {
    setModel: args => { calls.push(['model', args]); return new Promise(resolve => { finish = resolve; }); },
    updateModelMaterials: model => calls.push(['material', model])
  };
  const queue = createPreviewUpdates(handle, a, { ready: config => ready.push(config), error: msg => errors.push(msg) });
  queue.update(b); queue.update(c);
  assert.equal(calls.length, 1, 'material edits wait for the matching geometry to finish');
  finish(true); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ready, [c], 'only newest completed config is reported');
  assert.equal(calls[1][0], 'material');
  queue.update(a); finish(false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  queue.update(a);
  assert.equal(calls.at(-1)[0], 'model', 'failed config must be retried, never treated as applied');
  queue.dispose(); finish(true); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ready, [c], 'disposed queue cannot publish stale results');

  // Run the component's actual save handler: fresh upload -> successful save -> edit.
  let saveNode;
  function findSave(node) { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'save') saveNode = node.initializer; ts.forEachChild(node, findSave); }
  findSave(ast);
  const code = ts.transpileModule(`const save = ${saveNode.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const writes = []; const storage = []; const attachment = new Blob(['glTF']);
  const context = {
    previewFile: 'car.glb', selectedFileRef: { current: attachment }, report: { file: 'car.glb' }, editingId: null, saveBlocked: false,
    savingRef: { current: false }, meta: { id: 'car', label: 'Car', note: '' }, params: { length: 5.6 },
    wheelPick: ['tire'], tuneRegion: 'overall', wireTuneOpen: false, WORKBENCH_STORAGE_KEY: 'test', mode: 'import', onSaved: undefined,
    setSaving() {}, setError(message) { context.error = message; },
    setEditingId(value) { context.editingId = value; }, setPreviewFile(value) { context.previewFile = value; },
    setMeta(value) { context.meta = value; }, setParams(value) { context.params = value; }, setPreviewParams() {},
    setLocalPreviewUrl() {}, reset() { context.previewFile = null; context.selectedFileRef.current = null; }, setReport(value) { context.report = value; }, setSavedSnapshot() {}, setNotice() {}, setDraftError() {}, router: { refresh() {} },
    window: { localStorage: { setItem: (...args) => storage.push(args) } },
    fetch: async (url, options) => {
      writes.push({ url, ...options, body: typeof options.body === "string" ? JSON.parse(options.body) : options.body });
      return { ok: true, json: async () => ({ model: { id: 'car', label: 'Car', note: '', file: 'car.glb', params: { length: 5.6 } } }) };
    }
  };
  const save = new Function('context', `with (context) { ${code}; return save; }`)(context);
  await save(); await save();
  assert.equal(writes[0].body, attachment, 'first save submits the transient original file');
  assert.equal(JSON.parse(decodeURIComponent(writes[0].headers['X-Showcase-Model'])).id, 'car');
  assert.equal(context.selectedFileRef.current, null, 'successful save releases the local attachment');
  assert.equal(writes[0].method, 'POST');
  assert.equal(writes[1].method, 'PUT');
  assert.equal(writes[1].url, '/api/showcase/models/car');
  assert.equal(JSON.parse(storage[0][1]).previewFile, 'car.glb', 'refresh after save resolves the renamed file');
  context.fetch = async () => ({ ok: false, json: async () => ({ error: '保存暂时失败' }) });
  await save();
  assert.equal(context.error, '保存暂时失败');
  assert.equal(context.previewFile, 'car.glb', 'saved model edit failure preserves the existing attachment');
  context.editingId = null; context.selectedFileRef.current = attachment;
  await save();
  assert.equal(context.previewFile, null);
  assert.equal(context.selectedFileRef.current, null, 'failed new-model save releases the unsaved attachment');
  console.log('PASS exact wheel selection, validation, queued preview races/retry/disposal, draft-save-edit lifecycle and save error retention');
})().catch(error => { console.error(error); process.exitCode = 1; });
