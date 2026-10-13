const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), React = require('react'), ts = require('typescript');
const compile = file => ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText;
const geometry = { exports: {} };
vm.runInNewContext(compile('../lib/selectPopover.ts'), geometry);
const place = geometry.exports.selectPopoverPlacement;
const viewport = { left: 0, top: 0, width: 390, height: 844 };
let p = place({ left: 24, top: 100, bottom: 140, width: 220 }, { width: 220, height: 194 }, viewport);
assert.equal(p.above, false); assert.equal(p.top, 146); assert.equal(p.width, 220);
p = place({ left: 270, top: 760, bottom: 800, width: 100 }, { width: 180, height: 122 }, viewport);
assert.equal(p.above, true); assert.equal(p.top + 122, 754, 'upward menus keep the same 6px gap');
assert.equal(p.left + p.width, 382, 'right edge stays inside viewport');
p = place({ left: 4, top: 180, bottom: 220, width: 500 }, { width: 500, height: 700 }, { ...viewport, height: 360 });
assert(p.width <= 374); assert(p.top >= 8); assert(p.top + p.maxHeight <= 352);
p = place({ left: 45, top: 340, bottom: 380, width: 250 }, { width: 250, height: 600 }, { left: 20, top: 250, width: 300, height: 300 });
assert(p.left >= 28 && p.left + p.width <= 312); assert(p.top >= 258 && p.top + p.maxHeight <= 542, 'visible viewport, including keyboard/pinch offsets, bounds the menu');
console.log('PASS menu geometry: preserved size, actual upward gap, screen edges and visual viewport');

function harness(file, props) {
  const slots = [], effects = [], timers = new Map(), elements = new Map();
  const listeners = new Map(); let cursor = 0, tree, dirty = false, timerId = 0;
  const doc = { activeElement: null, body: null };
  class Element {
    constructor(key) { this.key = key; this.style = {}; this.isConnected = true; this.scrollTop = 0; this.offsetTop = 0; this.offsetWidth = 180; this.offsetHeight = 36; this.clientHeight = 298; this.scrollHeight = 518; }
    focus() { doc.activeElement = this; }
    contains(other) { for (let target = other; target; target = target.parentElement) if (target === this) return true; return false; }
    matches() { return !!this.disabled; }
    querySelector() { return null; }
    getBoundingClientRect() { return { top: 100, bottom: 140, left: 20, width: 180 }; }
  }
  doc.body = new Element('body'); doc.body.style.overflow = '';
  const triggerBeforeModal = new Element('original-trigger'); doc.activeElement = triggerBeforeModal;
  const listen = (scope, name, fn, capture = false) => { const key = `${scope}:${name}:${!!capture}`; if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); };
  const unlisten = (scope, name, fn, capture = false) => listeners.get(`${scope}:${name}:${!!capture}`)?.delete(fn);
  doc.addEventListener = (...args) => listen('document', ...args); doc.removeEventListener = (...args) => unlisten('document', ...args);
  doc.querySelector = () => null;
  const win = { innerWidth: 390, innerHeight: 844, matchMedia: () => ({ matches: false }), addEventListener: (...args) => listen('window', ...args), removeEventListener: (...args) => unlisten('window', ...args) };
  const hooks = { ...React,
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { value: { current: initial } }; return slots[i].value; },
    useId() { cursor++; return 'select-test'; },
    useEffect(run, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((d, j) => !Object.is(d, old.deps[j]))) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = run(); }); } }
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const context = { exports: {}, window: win, document: doc, Node: Element, HTMLElement: Element,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    require: name => name === 'react' ? hooks : name === 'react-dom' ? { createPortal: children => children } : name === '@/lib/selectPopover' ? geometry.exports : name === '@tabler/icons-react' ? { IconCheck: () => null, IconChevronDown: () => null } : require(name)
  };
  vm.runInNewContext(compile(file), context);
  function nodes(node = tree) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(item => nodes(item)); return [node, ...React.Children.toArray(node.props?.children).flatMap(child => nodes(child))]; }
  function attach(node, parent = doc.body, path = 'root') {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((child, index) => attach(child, parent, `${path}.${index}`)); return; }
    let element = parent;
    if (typeof node.type === 'string') {
      const optionKey = String(node.key).replace(/^\.\$/, '');
      const key = node.props.role === 'option' ? `option-${optionKey}` : node.props.role === 'listbox' ? 'menu' : node.props['aria-label'] ? `${node.type}-${node.props['aria-label']}` : path;
      if (!elements.has(key)) elements.set(key, new Element(key));
      element = elements.get(key); element.parentElement = parent; element.disabled = node.props.disabled; element.isConnected = true;
      if (node.props.role === 'option') element.offsetTop = props.options.findIndex(o => o.value === optionKey) * 36 + 6;
      if (node.props.role === 'listbox') { element.offsetHeight = 300; element.clientHeight = 298; }
      if (typeof node.props.ref === 'function') node.props.ref(element); else if (node.props.ref) node.props.ref.current = element;
    }
    React.Children.toArray(node.props?.children).forEach((child, index) => attach(child, element, `${path}.${index}`));
  }
  function render() { let passes = 0; do { dirty = false; cursor = 0; tree = context.exports.default(props); attach(tree); effects.splice(0).forEach(run => run()); assert(++passes < 12, 'render should settle'); } while (dirty); return tree; }
  function dispatch(name, event, capture = false, scope = 'window') { for (const fn of listeners.get(`${scope}:${name}:${capture}`) || []) fn(event); }
  return { props, render, nodes, doc, timers, elements, listeners, triggerBeforeModal, dispatch,
    find: (key, value) => nodes().find(node => node.props?.[key] === value),
    flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); render(); },
    cleanup() { slots.forEach(slot => slot?.cleanup?.()); }
  };
}
function keyEvent(key) { return { key, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; } }; }
const changes = [];
const h = harness('../components/AppSelect.tsx', { ariaLabel: 'test-select', value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }], onChange: value => changes.push(value) });
h.render(); h.find('aria-label', 'test-select').props.onClick(); h.render();
assert(h.find('role', 'listbox')); assert.equal(h.doc.activeElement.key, 'option-a');
h.dispatch('scroll', { target: h.elements.get('menu') }, true); h.render();
assert(h.find('role', 'listbox'), 'scrolling the menu cannot close it');
h.find('role', 'listbox').props.onKeyDown(keyEvent('ArrowDown'));
assert.equal(h.doc.activeElement.key, 'option-c', 'arrow navigation skips disabled options');
h.find('role', 'listbox').props.onKeyDown(keyEvent('Home')); assert.equal(h.doc.activeElement.key, 'option-a');
h.find('role', 'listbox').props.onKeyDown(keyEvent('End')); assert.equal(h.doc.activeElement.key, 'option-c');
const esc = keyEvent('Escape'); h.dispatch('keydown', esc, true); h.render();
assert(esc.defaultPrevented && esc.stopped, 'Escape is consumed before parent dialog handlers');
assert(!h.find('role', 'listbox')); assert.equal(changes.length, 0, 'keyboard browsing and Escape cannot commit a value');
h.find('aria-label', 'test-select').props.onClick(); h.render();
h.find('role', 'listbox').props.onKeyDown(keyEvent('Tab')); h.render(); assert(!h.find('role', 'listbox'));
h.find('aria-label', 'test-select').props.onClick(); h.render(); h.dispatch('scroll', { target: h.doc.body }, true); h.render(); assert(!h.find('role', 'listbox'), 'scrolling the page dismisses a detached menu');
h.find('aria-label', 'test-select').props.onClick(); h.render();
h.nodes().find(node => node.props?.role === 'option' && node.props.disabled !== true && node.props['aria-selected'] === false).props.onClick(); h.render();
assert.deepEqual(changes, ['c'], 'only an explicit selection changes the value'); assert.equal(h.doc.activeElement.key, 'button-test-select');
h.find('aria-label', 'test-select').props.onClick(); h.render(); h.props.disabled = true; h.render(); assert(!h.find('role', 'listbox'), 'disabled controls cannot leave an interactive menu behind');
h.cleanup(); assert([...h.listeners.values()].every(set => set.size === 0));
console.log('PASS select interactions: internal scroll, keyboard browsing, Escape layering, Tab and cleanup');

let oldClose = 0, newClose = 0;
const modal = harness('../components/AppModal.tsx', { title: 'Test', children: 'body', onClose: () => oldClose++ });
modal.render(); modal.dispatch('keydown', { ...keyEvent('Escape'), repeat: true }); assert.equal(modal.timers.size, 0, 'holding Escape after dismissing a menu cannot close its parent');
modal.dispatch('keydown', keyEvent('Escape')); modal.dispatch('keydown', keyEvent('Escape'));
assert.equal(modal.timers.size, 1, 'repeated Escape schedules exactly one close');
modal.props.onClose = () => newClose++; modal.render(); modal.flushTimers(); assert.equal(oldClose, 0); assert.equal(newClose, 1, 'close uses the latest callback');
modal.cleanup(); assert.equal(modal.doc.activeElement, modal.triggerBeforeModal, 'closing returns focus to the opener');
const guarded = harness('../components/AppModal.tsx', { title: 'Guarded', children: 'body', onClose: () => newClose++ });
guarded.render(); guarded.dispatch('keydown', keyEvent('Escape')); guarded.props.closeDisabled = true; guarded.render(); guarded.flushTimers();
assert.equal(newClose, 1, 'an operation starting during exit keeps the dialog open');
guarded.props.closeDisabled = false; guarded.render(); guarded.dispatch('keydown', keyEvent('Escape')); guarded.flushTimers(); assert.equal(newClose, 2, 'closing works again after the operation');
const nextFocus = new guarded.triggerBeforeModal.constructor('new-dialog'); nextFocus.focus(); guarded.cleanup(); assert.equal(guarded.doc.activeElement, nextFocus, 'unmount cannot steal focus from a newer dialog');
console.log('PASS modal lifecycle: one close, fresh callback, focus restoration and timer cleanup');
