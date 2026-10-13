const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(require.resolve('../lib/workspaceMotion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function harness({ reduced = false, loading = false } = {}) {
  const calls = [], timers = new Map(), listeners = new Set();
  let observer, waiting = loading;
  const preference = { matches: reduced, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const element = (top, left = 0, height = 80) => ({
    getBoundingClientRect: () => ({ top, left, bottom: top + height, width: 100, height }),
    animate: (frames, options) => {
      const animation = { frames, options, canceled: false, cancel() { this.canceled = true; } };
      calls.push(animation); return animation;
    }
  });
  const targets = [element(280), element(90, 300), element(90, 0), element(900), element(20, 0, 0)];
  const panel = { ...element(0), hidden: false,
    closest: () => ({ getBoundingClientRect: () => ({ top: 60, bottom: 640 }) }),
    querySelector: () => waiting ? {} : null, querySelectorAll: () => targets
  };
  const context = { exports: {}, window: { innerHeight: 720, matchMedia: () => preference,
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) },
    MutationObserver: class { constructor(fn) { this.fn = fn; observer = this; } observe() { this.connected = true; } disconnect() { this.connected = false; } }
  };
  vm.runInNewContext(source, context);
  return { calls, timers, listeners, panel, targets, preference,
    start: () => context.exports.animateWorkspaceEntrance(panel),
    ready: () => { waiting = false; if (observer.connected) observer.fn(); },
    update: () => { if (observer.connected) observer.fn(); },
    reduce: () => { preference.matches = true; [...listeners].forEach(fn => fn()); }
  };
}

let h = harness({ loading: true });
const cancelPending = h.start();
assert.equal(h.calls.length, 0, 'loading placeholder is not animated as final content');
cancelPending(); h.ready();
assert.equal(h.calls.length, 0, 'late content cannot restart an abandoned navigation');
assert.equal(h.timers.size + h.listeners.size, 0);

h = harness({ loading: true });
const cancel = h.start(); h.ready();
assert.equal(h.calls.length, 3, 'offscreen and hidden modules are excluded');
assert.deepEqual(h.calls.map(call => call.options.delay), [0, 35, 70]);
h.update();
assert.equal(h.calls.length, 3, 'live data does not replay the entrance');
cancel(); assert(h.calls.every(call => call.canceled));

h = harness({ reduced: true }); h.start();
assert.equal(h.calls.length + h.timers.size + h.listeners.size, 0);
h = harness(); h.start(); h.reduce();
assert(h.calls.every(call => call.canceled), 'changing motion preference cancels in-flight work');
assert.equal(h.listeners.size, 0);
h = harness(); h.targets.length = 0; h.start();
assert.equal(h.calls.length, 1);
assert(!('transform' in h.calls[0].frames[0]), 'fallback cannot rebase fixed descendants');
h = harness({ loading: true }); h.start(); [...h.timers.values()][0](); h.ready();
assert.equal(h.calls.length, 0, 'bounded loading observer is cleaned after timeout');

console.log('PASS workspace motion: readiness, viewport, cancellation, live data and reduced motion');

// Render the real chart with retained hook slots to catch instance churn on quote updates.
const React = require('react');
const slots = [], effects = [], charts = [];
let cursor = 0;
const hooks = { ...React,
  useRef: value => { const i = cursor++; return slots[i] || (slots[i] = { current: value }); },
  useEffect: (run, deps) => {
    const i = cursor++, old = slots[i];
    if (!old || deps.some((value, j) => value !== old.deps[j])) {
      effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: run() }; });
    }
  }
};
const chartPreference = { matches: false, addEventListener() {}, removeEventListener() {} };
let chartDark = false, themeObserver;
const chartContext = { exports: {},
  require: name => name === 'react' ? hooks : name === '@/lib/echarts' ? {
    init() { const chart = { options: [], disposed: false, setOption(option) { this.options.push(option); }, resize() {}, clear() { this.cleared = true; }, dispose() { this.disposed = true; } }; charts.push(chart); return chart; },
    graphic: { LinearGradient: function () {} }
  } : require(name),
  window: { matchMedia: () => chartPreference }, document: { documentElement: { classList: { contains: () => chartDark } } },
  MutationObserver: class { constructor(fn) { this.fn = fn; themeObserver = this; } observe() {} disconnect() {} },
  ResizeObserver: class { observe() {} disconnect() {} }
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../components/PnlTrendChart.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText, chartContext);
function renderChart(props) {
  cursor = 0; const element = chartContext.exports.default(props);
  element.props.ref.current = {}; effects.splice(0).forEach(run => run());
}
const props = { points: [{ date: '2026-10-01', asset: 100, timeIndex: 100, benchmark: 100 }, { date: '2026-10-02', asset: 110, timeIndex: 105, benchmark: 102 }], tab: 'return', weighting: 'time', benchLabel: '基准' };
renderChart(props);
renderChart({ ...props, points: props.points.map(point => ({ ...point, asset: point.asset + 1 })) });
assert.equal(charts.length, 1, 'data updates reuse the canvas and preserve update animations');
assert.equal(charts[0].disposed, false);
assert(Math.abs(charts[0].options.at(-1).series[0].data[1] - 5) < .0001, 'time-weighted return is unchanged');
const updates = charts[0].options.length;
themeObserver.fn(); assert.equal(charts[0].options.length, updates, 'navigation classes do not redraw the chart');
chartDark = true; themeObserver.fn(); assert.equal(charts[0].options.length, updates + 1, 'actual theme changes redraw the retained canvas');
assert.equal(charts[0].options.at(-1).tooltip.backgroundColor, '#202630');
renderChart({ ...props, tab: 'asset' });
assert.equal(charts[0].options.at(-1).series.length, 1, 'switching to assets removes the comparison series');
chartPreference.matches = true; renderChart({ ...props, benchLabel: '新基准' });
assert.equal(charts[0].options.at(-1).animation, false);
assert.equal(charts[0].options.at(-1).series[1].name, '新基准');
renderChart({ ...props, points: [] }); assert.equal(charts[0].cleared, true, 'empty data clears the previous curve');
slots.forEach(slot => slot?.cleanup?.()); assert.equal(charts[0].disposed, true);
console.log('PASS trend chart: retained canvas, correct series/data, reduced motion and cleanup');
