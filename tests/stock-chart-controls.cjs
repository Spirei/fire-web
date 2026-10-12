// Exercise the actual chart controls; no browser preferences, quotes or real data are written.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'components/StockKline.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText;

function harness() {
  let cursor = 0, timerId = 0, view;
  const states = [], timers = new Map();
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return states[i] || (states[i] = { current: initial }); },
    useMemo(fn) { return fn(); }, useEffect() {}, useLayoutEffect() {}
  };
  const exports = {};
  const localStorage = { getItem: () => null };
  vm.runInNewContext(code, {
    exports, localStorage, window: { innerWidth: 390, innerHeight: 844 },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    require: id => id === 'react' ? hooks : id === 'react/jsx-runtime' ? require(id)
      : id === '@/lib/usePersistedState' ? { usePersistedState: (_, initial) => hooks.useState(initial) }
      : { __esModule: true, default: () => null }
  });
  function elements(tree) {
    if (Array.isArray(tree)) return tree.flatMap(elements);
    if (!tree?.props) return [];
    return [tree, ...elements(tree.props.children)];
  }
  const captured = new Set();
  const scroller = { scrollLeft: 0, setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id), releasePointerCapture: id => captured.delete(id) };
  function render() {
    cursor = 0;
    view = elements(exports.default({ market: 'US', code: 'TEST' }));
    const ranges = view.find(el => el.props.className?.includes('stock-chart-primary-ranges'));
    ranges.props.ref.current = scroller;
    return ranges;
  }
  const button = value => view.find(el => el.type === 'button' && el.props['data-range'] === value);
  const event = (pointerId, clientX, type) => ({ pointerId, clientX, type, currentTarget: scroller });
  return {
    render, scroller, captured,
    down(id = 1, x = 0) { render().props.onPointerDown(event(id, x, 'pointerdown')); },
    move(id = 1, x = 60) { render().props.onPointerMove(event(id, x, 'pointermove')); },
    up(id = 1) { render().props.onPointerUp(event(id, 60, 'pointerup')); },
    cancel(id = 1) { render().props.onPointerCancel(event(id, 60, 'pointercancel')); },
    click(value) { render(); button(value).props.onClick(); render(); },
    active(value) { return button(value).props.className.includes('is-active'); },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } }
  };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
test('plain click selects a period without pointer capture or a second click', () => {
  const h = harness(); h.down(); h.up(); h.click('WEEK'); assert(h.active('WEEK')); assert.equal(h.captured.size, 0);
});
test('drag suppresses only the click from that gesture and releases capture', () => {
  const h = harness(); h.down(); h.move(); assert.equal(h.captured.size, 1); h.up(); h.click('MONTH'); assert(!h.active('MONTH')); assert.equal(h.captured.size, 0);
  h.flush(); h.down(2); h.up(2); h.click('MONTH'); assert(h.active('MONTH'));
});
test('when capture retargets the drag click, the first next pointer click still selects', () => {
  const h = harness(); h.down(); h.move(); h.up(); // Browser sends this click to the container, not a button.
  h.down(2); h.up(2); h.click('YEAR'); assert(h.active('YEAR'));
});
test('a keyboard click after a completed drag is not swallowed', () => {
  const h = harness(); h.down(); h.move(); h.up(); h.flush(); h.click('DAILY'); assert(h.active('DAILY'));
});
test('pointer cancellation does not suppress a subsequent selection', () => {
  const h = harness(); h.down(); h.move(); h.cancel(); h.click('5D'); assert(h.active('5D')); assert.equal(h.captured.size, 0);
});
console.log(`Stock chart control regression: ${passed} checks passed`);
