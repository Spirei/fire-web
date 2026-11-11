const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
function slice(file, start, end, exported = '') {
  const text = source(file), a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `fixture boundaries: ${file}`);
  return ts.transpileModule(text.slice(a, b) + exported, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const ref = current => ({ current });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function network() {
  const requests = [];
  return { requests, fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, signal: options.signal, resolve: data => resolve({ ok: true, json: async () => data }), reject })) };
}
function timers() {
  const pending = new Map(); let id = 0;
  return { pending, setTimeout: (fn, delay) => { pending.set(++id, { fn, delay }); return id; }, clearTimeout: id => pending.delete(id), run() { const batch = [...pending.values()]; pending.clear(); batch.forEach(timer => timer.fn()); } };
}

module.exports = async function workspaceBackground() {
  const api = 'components/ApiRequests.tsx', library = 'components/views/AssetCatalogView.tsx', activities = 'components/views/ActivitiesView.tsx';
  const apiCode = slice(api, '  const refresh = useCallback', '  useEffect(() => {', '\nexports.refresh=refresh;exports.scheduleRefresh=scheduleRefresh;');
  const net = network(), clock = timers(), commits = [];
  const apiContext = { exports: {}, ...net, ...clock, AbortController, Date, document: { hidden: false }, foreground: true, foregroundRef: ref(true), filtersRef: ref({ q: 'first' }), filterParams: value => new URLSearchParams(value), flight: ref(null), flightKey: ref(''), changedDuringRead: ref(false), confirmed: ref({ key: '', at: 0 }), queueRefresh: ref(null), timer: ref(null), loadingShape: ref({}), useCallback: fn => fn, setRefreshing() {}, setResult: value => commits.push(value), setError() {}, setBlocked() {}, setCheckedAt() {} };
  vm.runInNewContext(apiCode, apiContext);
  apiContext.exports.scheduleRefresh(0, true); clock.run();
  for (let i = 0; i < 20; i++) apiContext.exports.scheduleRefresh();
  assert.equal(clock.pending.size, 1); clock.run();
  assert.equal(net.requests.length, 1, 'live events share the current query');
  assert(!net.requests[0].signal.aborted, 'a slow valid query must not be restarted');
  const payload = { code: 0, data: { logs: [], endpoints: [] } };
  net.requests[0].resolve(payload); await settle();
  assert.equal(commits.length, 1); assert.equal(clock.pending.size, 1, 'changes during the read leave one trailing refresh');
  clock.run(); assert.equal(net.requests.length, 2);
  apiContext.filtersRef.current = { q: 'second' };
  apiContext.exports.scheduleRefresh(0, true); clock.run();
  assert(net.requests[1].signal.aborted); assert.equal(net.requests.length, 3);
  const current = apiContext.flight.current;
  net.requests[1].resolve(payload); await settle();
  assert.equal(commits.length, 1); assert.equal(apiContext.flight.current, current, 'old finally cannot unlock the new filter');
  net.requests[2].resolve(payload); await settle(); assert.equal(commits.at(-1).key, 'q=second');
  const cleanups = [];
  apiContext.useEffect = fn => cleanups.push(fn()); apiContext.filterKey = 'q=second';
  vm.runInNewContext(slice(api, '  useEffect(() => {\n    if (foreground)', '  useEffect(() => {'), apiContext);
  apiContext.exports.scheduleRefresh(0, true); clock.run();
  apiContext.foregroundRef.current = false; cleanups.pop()();
  assert(net.requests.at(-1).signal.aborted); assert.equal(clock.pending.size, 0);
  net.requests.at(-1).resolve(payload); await settle(); assert.equal(commits.length, 2);
  apiContext.exports.scheduleRefresh(); await apiContext.exports.refresh(); assert.equal(net.requests.length, 4);
  console.log('PASS live logs coalesce slow reads, retain one trailing update and reject hidden/old-filter results');

  const streams = [], intervals = new Map(), connections = [], streamCleanups = [];
  class EventSource { constructor() { this.listeners = {}; this.closed = false; streams.push(this); } addEventListener(key, fn) { this.listeners[key] = fn; } close() { this.closed = true; } }
  Object.assign(apiContext, { foreground: true, foregroundRef: ref(true), live: true, blocked: false, EventSource, setConnection: value => connections.push(value), setInterval: fn => { intervals.set(1, fn); return 1; }, clearInterval: id => intervals.delete(id), useEffect: fn => streamCleanups.push(fn()) });
  const streamCode = slice(api, '  useEffect(() => {\n    if (!foreground || !live', '  useEffect(() => () =>');
  vm.runInNewContext(streamCode, apiContext); assert.equal(streams.length, 1); assert.equal(intervals.size, 1);
  streamCleanups.pop()(); assert(streams[0].closed); assert.equal(intervals.size, 0);
  const connectionCount = connections.length, requestCount = net.requests.length;
  streams[0].onopen(); streams[0].onerror(); streams[0].listeners.change();
  assert.equal(connections.length, connectionCount); assert.equal(net.requests.length, requestCount);
  apiContext.foreground = false; vm.runInNewContext(streamCode, apiContext); assert.equal(streams.length, 1); assert.equal(connections.at(-1), 'paused');
  console.log('PASS cached request-log pages close SSE and fallback polling while hidden');

  let active = true, visible = true, installed = false, release;
  const documentEvents = new Map(), windowEvents = new Map();
  const hookContext = { exports: {}, require: name => name === 'react' ? { useState: () => [visible, value => { visible = value; }], useEffect: fn => { if (!installed) { installed = true; release = fn(); } } } : { useWorkspaceActive: () => active }, document: { hidden: false, addEventListener: (key, fn) => documentEvents.set(key, fn), removeEventListener: key => documentEvents.delete(key) }, window: { addEventListener: (key, fn) => windowEvents.set(key, fn), removeEventListener: key => windowEvents.delete(key) } };
  vm.runInNewContext(ts.transpileModule(source('lib/useWorkspaceForeground.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, hookContext);
  assert(hookContext.exports.useWorkspaceForeground()); active = false; assert(!hookContext.exports.useWorkspaceForeground()); active = true;
  hookContext.document.hidden = true; documentEvents.get('visibilitychange')(); assert(!hookContext.exports.useWorkspaceForeground());
  hookContext.document.hidden = false; windowEvents.get('pageshow')(); assert(hookContext.exports.useWorkspaceForeground());
  release(); assert.equal(documentEvents.size + windowEvents.size, 0);
  console.log('PASS common foreground hook follows workspace, document and BFCache visibility and cleans up');

  const logNet = network(), logClock = timers(), logEffects = [], logCommits = []; let revisions = 0, finished = 0;
  const parent = { exports: {}, ...logNet, document: { hidden: false }, activeTabRef: ref('activities'), useCallback: fn => fn, setUserLogs: value => logCommits.push(value), setSystemLogs() {} };
  vm.runInNewContext(slice('components/RecordsApp.tsx', '  const reloadActivities = useCallback', '  const reloadSettings', '\nexports.reload=reloadActivities;'), parent);
  const logs = { exports: {}, ...logClock, Date, AbortController, document: parent.document, foreground: true, foregroundRef: ref(true), onRefresh: parent.exports.reload, logRead: ref(null), logsCheckedAt: ref(0), completeLogs: ref(false), scope: 'user', isAdmin: true, setRefreshing() {}, setLastRefreshed: () => ++finished, setSummaryRevision: () => ++revisions, showToast() {}, useEffect: fn => logEffects.push(fn()) };
  vm.runInNewContext(slice(activities, '  const refreshLogs =', '  const sourceLogs', '\nexports.refreshLogs=refreshLogs;'), logs);
  const first = logs.exports.refreshLogs(); assert.equal(first, logs.exports.refreshLogs()); assert.equal(logNet.requests.length, 1); assert.equal(finished, 0);
  logNet.requests[0].resolve({ userLogs: [{ event: 'fixture' }] }); await first;
  assert.equal(finished, 1); assert.equal(revisions, 1); assert.equal(logCommits.length, 1); assert(logs.completeLogs.current);
  const logPoll = slice(activities, '  useEffect(() => {\n    if (!foreground || !onRefresh', '  useEffect(() => {');
  vm.runInNewContext(logPoll, logs); assert([...logClock.pending.values()][0].delay > 29_000, 'warm return keeps the remaining deadline');
  logClock.run(); await settle(); assert.equal(logNet.requests.length, 1, 'an earlier scheduled tick honors the latest manual refresh timestamp');
  logs.exports.refreshLogs(); logs.foregroundRef.current = false; logEffects.pop()();
  assert(logNet.requests[1].signal.aborted); logNet.requests[1].resolve({ userLogs: [{ event: 'late' }] }); await settle(); assert.equal(logCommits.length, 1); assert.equal(finished, 1);
  logs.foregroundRef.current = true; logs.scope = 'system'; logs.completeLogs.current = false; vm.runInNewContext(logPoll, logs);
  assert.equal([...logClock.pending.values()][0].delay, 0, 'SSR user logs cannot suppress the first system read'); logEffects.pop()();
  console.log('PASS activity reads await the parent, share manual clicks, pause, preserve freshness and load unseeded system logs');

  const assetNet=network(),assetCommits=[],assetCleanups=[];
  const materialExports={}; vm.runInNewContext(ts.transpileModule(source('lib/materialRead.ts'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:materialExports,fetch:assetNet.fetch,AbortController,DOMException,setTimeout,clearTimeout,Error,TypeError});
  const assets={exports:{},...assetNet,readMaterialResponse:materialExports.readMaterialResponse,AbortController,URLSearchParams,Date,document:{hidden:false},foreground:true,foregroundRef:ref(true),readKey:'stock|US',current:ref('stock|US'),type:'stock',market:'US',query:'',page:1,removed:false,tick:0,seenTick:ref(0),pageCache:ref(new Map()),ownerId:'fixture-owner',marketCountCache:ref(new Map()),setListing:data=>assetCommits.push(data),setLoadedKey(){},setLoading(){},setError(){},setSelection(){},useEffect:fn=>assetCleanups.push(fn())};
  const effect=slice(library,'  useEffect(() => {\n    if (!foreground) return;','  useEffect(() => {\n    const controller = new AbortController();');
  vm.runInNewContext(effect,assets);assert.equal(assetNet.requests.length,1);
  assetCleanups.pop()();assets.readKey='stock|HK';assets.current.current=assets.readKey;assets.market='HK';vm.runInNewContext(effect,assets);assert(assetNet.requests[0].signal.aborted);
  assetNet.requests[0].resolve({assets:[{id:'wrong'}]});await settle();assert.equal(assetCommits.length,0);
  assetNet.requests[1].resolve({assets:[{id:'hk'}],total:1,page:1});await settle();assert.equal(assetCommits.at(-1).assets[0].id,'hk');
  assetCleanups.pop()();vm.runInNewContext(effect,assets);assert.equal(assetNet.requests.length,2,'fresh category cache avoids another transport');assert.equal(assetCommits.at(-1).assets[0].id,'hk');
  assets.tick++;vm.runInNewContext(effect,assets);assert.equal(assetNet.requests.length,3,'manual refresh still fetches');
  assets.document.hidden=true;assetNet.requests[2].resolve({assets:[{id:'hidden'}]});await settle();assert.equal(assetCommits.at(-1).assets[0].id,'hk');assetCleanups.pop()();
  assets.foreground=false;vm.runInNewContext(effect,assets);assert.equal(assetNet.requests.length,3);
  assert(!source(library).includes('/api/quotes'));assert(!source(library).includes('/api/rates'));assert(!source(library).includes('/api/assets/sync'));
  console.log('PASS shared material browser caches categories, refreshes explicitly, rejects superseded/hidden reads and never loads quotes');

};
if (require.main === module) module.exports().catch(error => { console.error(error); process.exitCode = 1; });
