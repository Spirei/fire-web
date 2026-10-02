// Execute the actual renderer and browser-decoded inline handlers in an isolated VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(process.argv[2] || path.join(root, 'public/simple-app-runtime.js'), 'utf8');
const tree = ts.createSourceFile('simple-app-runtime.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
assert.equal(tree.parseDiagnostics.length, 0, 'runtime parses');
const constants = new Set(['EMPTY', 'CATS', 'EXAMPLES', 'CURS', 'MARKETS', 'INV_FILTERS', 'SIMPLE_BENCHMARKS', 'CF_INCOME_PRESETS', 'CF_EXPENSE_PRESETS', 'PAGES', 'RAINBOW', 'LEDGER_RULES']);
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) || (ts.isVariableStatement(node) && node.declarationList.declarations.every(d => ts.isIdentifier(d.name) && constants.has(d.name.text)))).map(node => node.getText(tree)).join('\n');
const calls = [];
const element = { classList: { add() {}, remove() {}, toggle() {} }, focus() {}, setSelectionRange() {}, querySelector() { return null; }, querySelectorAll() { return []; }, style: {}, dataset: {}, value: '', innerHTML: '' };
const context = vm.createContext({ console, Date, URL, URLSearchParams, Math, Number, String, JSON, setTimeout() {}, clearTimeout() {}, document: { getElementById() { return element; }, querySelector() { return null; }, querySelectorAll() { return []; }, documentElement: { classList: { contains() { return false; } } } }, localStorage: { getItem() { return null; }, setItem() {} }, window: {}, event: { stopPropagation() {}, preventDefault() {} }, S: {}, route: {}, marketIcons: {}, benchState: { key: 'spy', items: [] }, trendHoverModel: null });
vm.runInContext(declarations, context);
for (const name of ['render', 'go', 'openCfEditor', 'moveMember', 'removeMember', 'moveItem', 'patchItem', 'removeItem', 'commitEdit', 'saveEditAmount', 'openUpdate', 'copySummary', 'openMetricHelp', 'removeSummary', 'dragInvestStart', 'dropInvest', 'archiveInvest', 'archiveInvestFromSort', 'restoreArchivedInvest', 'exportXlsxForGroup', 'exportBookForGroup', 'importLedgerToGroup', 'pickInvestMarket', 'patchInvest', 'editInvestFlow', 'saveInvestFlow', 'toast', 'setFoot']) context[name] = (...args) => calls.push([name, ...args]);
context.save = () => {};
context.syncUrl = () => {};
function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, key) => {
    if (key[0] === '#') return String.fromCodePoint(parseInt(key.slice(key[1]?.toLowerCase() === 'x' ? 2 : 1), key[1]?.toLowerCase() === 'x' ? 16 : 10));
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[key.toLowerCase()];
  });
}
function handlers(html, attribute = 'onclick') {
  return [...html.matchAll(new RegExp('\\b' + attribute + '="([^"]*)"', 'g'))].map(match => decode(match[1]));
}
function execute(code) { vm.runInContext(code, context); assert.equal(context.injected, undefined, 'untrusted values must never execute script'); }
function executeMatching(html, prefix, attribute) {
  const matches = handlers(html, attribute).filter(code => code.includes(prefix));
  assert(matches.length > 0, 'expected handler ' + prefix);
  for (const code of matches) execute(code);
}
function fixture(overrides = {}) {
  context.S = context.normalize(JSON.parse(JSON.stringify(overrides)));
  context.route = { name: 'family', cat: 'cash', member: '全部', chartKind: 'mwr', chartRange: 'all', investSort: 'updated' };
  context.injected = undefined;
  calls.length = 0;
}
function noInjectedMarkup(html) {
  assert(!/<script\b|<img\b[^>]*\bsrc=x\b/i.test(html), 'imported text cannot create executable elements');
  assert(!/\bon(?:error|load)="globalThis\.injected/.test(html), 'imported values cannot create event attributes');
}
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + ': ' + error.message); }
}
const evil = "');globalThis.injected=1;//";
const quoted = '中英文 O\'Brien "家庭" \\ path\nline &quot;';
const attr = '"><img src=x onerror="globalThis.injected=1">';
test('cashflow choices and saved names/IDs survive HTML decoding without executing JavaScript', () => {
  for (const name of [evil, quoted, attr]) {
    fixture();
    const html = context.cfChoice('income', { name });
    executeMatching(html, 'openCfEditor');
    assert.deepEqual(calls.pop(), ['openCfEditor', 'income', name]);
    const row = context.cfItemRow('expense', { name, id: name, amount: 12, freq: 'month' });
    executeMatching(row, 'openCfEditor');
    assert.deepEqual(calls.pop(), ['openCfEditor', 'expense', name, name]);
    noInjectedMarkup(row);
  }
});
test('family filtering preserves quotes/backslashes and escapes selected names in ordinary text', () => {
  for (const name of [evil, quoted, attr]) {
    fixture({ members: [{ id: 'member', name }] });
    let html = context.family();
    executeMatching(html, 'route.member=');
    assert.equal(context.route.member, name);
    html = context.family();
    noInjectedMarkup(html);
    assert(html.includes(context.esc(name) + '当前资产'));
  }
});
test('imported IDs are preserved in composed navigation, member/item actions and summary checkbox attributes', () => {
  for (const id of [evil, quoted, attr]) {
    fixture({ cash: [{ id, name: 'Cash', amount: 10, cur: 'CNY' }], invest: [{ id, name: 'Investment', amount: 100, cur: 'CNY', market: 'CN', hist: [], inAmt: 100, outAmt: 0 }], members: [{ id, name: 'Member' }], summaries: [{ id, name: 'Summary', ids: [id] }] });
    executeMatching(context.updateFamily(), "go('editItem'");
    assert.equal(calls.find(call => call[0] === 'go' && call[1] === 'editItem')[2].itemId, id);
    context.route.memSort = true;
    executeMatching(context.managePage(), 'moveMember');
    assert.equal(calls.filter(call => call[0] === 'moveMember')[0][1], id);
    const picker = context.addSummaryPage();
    assert.equal(decode(picker.match(/data-summary-id="([^"]*)"/)[1]), id);
    noInjectedMarkup(picker);
    const html = context.investHome();
    executeMatching(html, 'openUpdate');
    executeMatching(html, "go('account'");
    executeMatching(html, 'removeSummary');
    assert.equal(calls.find(call => call[0] === 'openUpdate')[1], id);
    assert.equal(calls.find(call => call[0] === 'removeSummary')[1], id);
    assert.equal(calls.find(call => call[0] === 'go' && call[1] === 'account')[2].account, id);
  }
});
test('settings callbacks, market selection, drag handlers and financial flow actions decode exactly once', () => {
  const id = quoted + evil, group = attr + quoted;
  fixture({ invest: [{ id, group, name: 'Account', amount: 100, cur: 'CNY', market: 'CN', hist: [], inAmt: 100, outAmt: 0 }] });
  context.route.account = id;
  let html = context.settingsPage();
  executeMatching(html, "go('account'");
  executeMatching(html, 'exportBookForGroup');
  executeMatching(html, 'pickInvestMarket');
  assert.equal(calls.find(call => call[0] === 'go')[2].account, id);
  assert.equal(calls.find(call => call[0] === 'exportBookForGroup')[1], group);
  assert.equal(calls.find(call => call[0] === 'pickInvestMarket')[1], id);
  context.route.sorting = true;
  html = context.investHome();
  executeMatching(html, 'dragInvestStart', 'ondragstart');
  executeMatching(html, 'dropInvest', 'ondrop');
  assert.equal(calls.find(call => call[0] === 'dragInvestStart')[2], id);
  context.route.editFlow = true;
  const stats = context.investStats(context.S.invest[0]);
  html = context.compose(stats, id);
  executeMatching(html, 'editInvestFlow');
  assert.equal(calls.find(call => call[0] === 'editInvestFlow')[1], id);
});
test('malicious JSON dates, numeric-looking values, currencies and reminders remain text or single attributes', () => {
  fixture({ cash: [{ id: 'cash', name: 'Cash', amount: attr, cur: attr, date: attr }], snaps: [{ at: attr, assets: 10, debt: 0, cash: 10, inv: 0 }], invest: [{ id: 'invest', name: 'Account', amount: 10, cur: attr, market: 'CN', expected: attr, updated: attr, hist: [{ d: attr, v: 10, inn: 10, out: 0 }] }], expected: attr, reminder: attr });
  context.route.itemId = 'cash';
  context.route.account = 'invest';
  context.route.more = true;
  context.route.draft = { name: 'New', amount: 1, cur: 'CNY', expected: attr };
  for (const render of ['home', 'family', 'calendarPage', 'updateFamily', 'editItemPage', 'investHome', 'addInvestPage', 'account', 'settingsPage']) {
    const html = context[render]();
    try { noInjectedMarkup(html); } catch (error) { error.message = render + ': ' + error.message; throw error; }
    assert(!html.includes('value="' + attr + '"'), render + ' must escape attributes');
  }
  const chart = context.chartBlock([{ d: attr, v: 10, inn: 10, out: 0 }], attr, '元', 0);
  noInjectedMarkup(chart);
  executeMatching(chart, 'toast');
  assert(calls.find(call => call[0] === 'toast')[1].includes(attr));
  // Helpers remain plain text for export/clipboard callers; escaping belongs at HTML sinks.
  assert.equal(context.pretty(attr), attr);
  assert.equal(context.md(attr), attr);
  assert.equal(context.zhDate(attr), attr);
});
console.log(`${passed} simple-ledger security regressions passed${failed ? `, ${failed} failed` : ''}.`);
process.exitCode = failed ? 1 : 0;
