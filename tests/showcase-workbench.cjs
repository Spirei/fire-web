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
const derive = new Function('structure', 'previewIsCurrent', 'wheelPick', 'materialCatalog', 'previewFile', 'report',
  `const useMemo = fn => fn(); ${names.map(name => `const ${name} = ${initializers.get(name)};`).join('\n')}
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
