// Exercise the account editor with controlled hooks and writes; no real database or browser storage.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), React = require('react');
function harness(account) {
  let current, cursor = 0, closed = 0, saved = 0;
  const slots = new Map(), writes = [], exports = {};
  const hooks = { ...React,
    useState(initial) { const states = slots.get(current), i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; },
    useRef(initial) { const states = slots.get(current), i = cursor++; return states[i] || (states[i] = { current: initial }); },
    useMemo: fn => fn(), useCallback: fn => fn, useEffect() {}, useLayoutEffect() {}
  };
  const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const modules = new Map();
  function load(file) { if (modules.has(file)) return modules.get(file); const out = {}; modules.set(file, out); vm.runInNewContext(compile(file), { exports: out, require: id => id.startsWith('./') ? load('lib/' + id.slice(2) + '.ts') : require(id), AbortController, setTimeout, clearTimeout }); return out; }
  const client = load('lib/assetAllocationClient.ts');
  const data = { accountId: 'owner', currency: 'USD', positions: [], accounts: [account], brokers: [], categories: [], issues: [], quoteStatus: { missing: [] }, bankSummary: { count: 0, includedCount: 0, value: 0 }, summary: { accountCount: 1, complete: true } };
  const stub = () => null;
  vm.runInNewContext(compile('components/views/AssetAllocationView.tsx'), { exports, Date, Set, Map, window: {}, require: id => {
    if (id === 'react') return hooks;
    if (id === '@/lib/currencyPrefs') return { useDisplayCurrency: () => ({ currency: 'USD' }), CURRENCY_SYMBOLS: { USD: '$', CNY: '¥', HKD: 'HK$' } };
    if (id === '@/lib/useWorkspaceForeground') return { useWorkspaceForeground: () => true };
    if (id === '@/lib/usePersistedState') return { usePersistedState: (_, initial) => hooks.useState(initial) };
    if (id === '@/lib/useAssetAllocationSnapshot') return { useAssetAllocationSnapshot: () => ({ data, error: '', loading: false, checkedAt: '', refresh: async () => data }) };
    if (id === '@/lib/assetAllocationClient') return { ...client, writeAllocation: async (...args) => { writes.push(args); } };
    if (id.startsWith('@/components/')) return { __esModule: true, default: stub };
    if (id.startsWith('@/lib/')) return load(id.slice(2) + '.ts');
    return require(id);
  } });
  function render(fn, props) { current = fn; cursor = 0; if (!slots.has(fn)) slots.set(fn, []); return fn(props); }
  const view = () => render(exports.default, {});
  const graph = elements(view()).find(e => e.type?.name === 'RoutingGraph'); graph.props.onEdit(account);
  const editor = elements(view()).find(e => e.type?.name === 'AccountEditor');
  const props = { ...editor.props, onClose: () => closed++, onSaved: () => saved++ };
  return { view, client, writes, editor: () => render(editor.type, props), get closed() { return closed; }, get saved() { return saved; } };
}
function elements(tree) { if (Array.isArray(tree)) return tree.flatMap(elements); if (!tree?.props) return []; return [tree, ...elements(tree.props.children)]; }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); if (tree?.props) return text(tree.props.children); return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : ''; }
const account = (extra = {}) => ({ id: 'broker:test:USD', name: 'Broker', kind: 'broker', currency: 'USD', category: 'securities', amount: 1020, value: 1020, holdings: 120, recordIds: [], excluded: false, reconciled: true, revision: 5, statementAmount: 1000, reconciledAt: '2026-10-10T02:00:00.000Z', ...extra });
async function submit(h) { elements(h.editor()).find(e => e.type === 'form').props.onSubmit({ preventDefault() {} }); for (let i = 0; i < 5; i++) await Promise.resolve(); }
(async () => {
  const h = harness(account());
  assert(text(h.view()).includes('核对后更新'));
  const checkpoint = elements(h.editor()).find(e => e.props['aria-label'] === '核对基准');
  assert(text(checkpoint).includes('手动核对起点$1,000.00')); assert(text(checkpoint).includes('核对后变动$+20.00'));
  elements(h.editor()).find(e => e.type === 'input' && e.props.inputMode === 'decimal').props.onChange({ target: { value: '2000' } });
  assert(text(elements(h.editor()).find(e => e.props['aria-label'] === '核对基准')).includes('$+20.00'), 'drafts must not rewrite historical checkpoint information');
  await submit(h); assert.equal(h.writes[0][3].amount, 2000); assert.equal(h.writes[0][3].amountChanged, true);
  console.log('PASS manual checkpoint is distinct from current value and amount drafts establish a new checkpoint only on save');

  const rounded = harness(account({ amount: 1020.123456789, value: 1020.12, reconciled: false, reconciledAt: null }));
  assert.equal(elements(rounded.editor()).find(e => e.type === 'input' && e.props.inputMode === 'decimal').props.value, '1020.12345679');
  await submit(rounded); assert.equal(rounded.writes[0][3].amountChanged, false); assert.equal(rounded.writes[0][3].amountMode, 'automatic');
  console.log('PASS formatted input precision cannot turn an unchanged automatic account into a manual checkpoint');

  for (const reconciled of [true, false]) {
    const missing = harness(account({ amount: null, value: null, reconciled, reconciledAt: reconciled ? account().reconciledAt : null }));
    assert(text(missing.view()).includes(reconciled ? '核对待检查' : '待补余额'));
    let inputs = elements(missing.editor()).filter(e => e.type === 'input');
    assert.equal(inputs.find(e => e.props.inputMode === 'decimal').props.required, false);
    inputs.find(e => e.props['data-autofocus']).props.onChange({ target: { value: 'Renamed' } });
    inputs.find(e => e.props.type === 'checkbox').props.onChange({ target: { checked: false } });
    await submit(missing); assert.equal(missing.writes.length, 1); const body = missing.writes[0][3];
    assert.equal(body.name, 'Renamed'); assert.equal(body.excluded, true); assert.equal(body.amountChanged, false); assert.equal(body.amountMode, reconciled ? 'statement' : 'automatic'); assert.equal(body.revision, 5); assert.equal(missing.saved, 1); assert.equal(missing.closed, 1);
  }
  console.log('PASS missing valuation permits rename/exclusion with the original revision and metadata-only intent');

  const blank = harness(account({ amount: null, value: null }));
  elements(blank.editor()).find(e => e.type === 'input' && e.props.inputMode === 'decimal').props.onChange({ target: { value: ' ' } });
  await submit(blank); assert.equal(blank.writes.length, 0); assert(text(blank.editor()).includes('请填写名称和有效金额'));
  console.log('PASS intentionally editing a missing amount still requires a valid number');

  const status = h.client.allocationAccountStatus;
  assert.equal(status(account({ value: null })), '缺汇率'); assert.equal(status(account({ amount: null, value: null })), '核对待检查');
  assert.equal(status(account({ reconciledAt: null })), '固定核对额'); assert.equal(status(account({ kind: 'manual' })), '手动录入');
  assert.equal(status(account({ excluded: true, amount: null, value: null })), '未计入');
  assert(text(harness(account({ value: null })).view()).includes('缺汇率'));
  console.log('PASS unavailable amounts/rates take precedence over reconciliation, with legacy/manual/excluded states distinguished');
})().catch(error => { console.error(error); process.exitCode = 1; });
