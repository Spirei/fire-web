// Controlled fetches, React effects and clocks. No real financial data or server writes.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compile = name => ts.transpileModule(fs.readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const categories = ['securities', 'cash', 'investment', 'fixed', 'receivable', 'debt'];
const snapshot = (currency = 'USD', revision = 'a') => ({ version: 1, accountId: 'owner', currency, observedAt: '2026-10-07T12:00:00.000Z', snapshotRevision: revision.repeat(64),
 summary: { totalAsset: 100, totalDebt: 0, netAsset: 100, knownAsset: 100, complete: true, accountCount: 1, portfolioTotalAsset: 100, difference: 0 },
 accounts: [{ id: 'fund:USD', name: 'Cash', kind: 'fund', category: 'cash', currency: 'USD', amount: 100, value: 100, holdings: null, cash: 100, recordIds: [], icon: '', source: 'funds', updatedAt: null, excluded: false, reconciled: false, revision: 0, components: { cash: 100 } }],
 bankSummary: { count: 0, includedCount: 0, value: 0 }, brokers: [], positions: [], categories: categories.map(id => ({ id, name: id, value: id === 'cash' ? 100 : 0, weightPct: id === 'cash' ? 100 : 0 })), issues: [], quoteStatus: { pending: false, cached: [], missing: [] } });
const response = (data, status = 200, headers = {}) => new Response(status === 304 ? null : JSON.stringify(status === 200 ? { code: 0, data } : { code: status * 100 + 1, message: 'Rejected' }), { status, headers: { 'Content-Type': 'application/json', ETag: `W/"${data?.snapshotRevision || 'a'.repeat(64)}"`, 'X-Allocation-Observed-At': '2026-10-07T12:01:00.000Z', ...headers } });
function harness(initial = null) {
 let cursor = 0, dirty = false, currency = 'USD', foreground = true, value, now = Date.parse('2026-10-07T12:00:00.000Z'), timerId = 0;
 const states = [], effects = [], requests = [], events = [], timers = new Map(), listeners = new Map(), modules = new Map();
 const hooks = {
  useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial; return [states[i], next => { const v = typeof next === 'function' ? next(states[i]) : next; if (!Object.is(v, states[i])) { states[i] = v; dirty = true; } }]; },
  useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; },
  useCallback(fn, deps) { const i = cursor++, old = states[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) states[i] = { fn, deps }; return states[i].fn; },
  useEffect(fn, deps) { const i = cursor++, old = effects[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) effects[i] = { deps, fn, cleanup: old?.cleanup, pending: true }; }
 };
 class Clock extends Date { static now() { return now; } }
 const environment = { AbortController, DOMException, Response, Headers, Error, Number, Object, Promise, Set, Map, Date: Clock, performance: { now: () => now },
  setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => timers.delete(id),
  fetch: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  window: { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); } }
 };
 const load = name => { if (modules.has(name)) return modules.get(name); const exports = {}; modules.set(name, exports); vm.runInNewContext(compile(name), { ...environment, exports, require: id => id === 'react' ? hooks : load(id.replace('./', '')) }); return exports; };
 const client = load('assetAllocationClient'), hook = load('useAssetAllocationSnapshot').useAssetAllocationSnapshot;
 const notify = event => events.push({ ...event });
 function render() { for (let n = 0; n < 12; n++) { dirty = false; cursor = 0; value = hook(currency, foreground, notify, initial); for (const e of effects) if (e?.pending) { e.pending = false; e.cleanup?.(); e.cleanup = e.fn(); } if (!dirty) return value; } throw Error('Render loop'); }
 const drain = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); await new Promise(setImmediate); return render(); };
 return { client, requests, events, timers, listeners, render, drain, get value() { return value; },
  currency: cur => { currency = cur; return render(); }, foreground: on => { foreground = on; return render(); },
  tick(ms) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); } },
  reply: (i, data = snapshot(requests[i].url.includes('CNY') ? 'CNY' : 'USD'), status = 200, headers) => requests[i].resolve(response(data, status, headers)),
  dispatch: name => listeners.get(name)?.(),
  close() { for (const e of effects) e?.cleanup?.(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0); }
 };
}
let checks = 0;
async function test(name, fn) { await fn(); checks++; console.log('PASS ' + name); }
(async () => {
 await test('server bootstrap displays immediately, refreshes quietly and never reuses wrong-currency or invalid data', async () => {
  const s=snapshot(),h=harness(s);h.render();assert.equal(h.value.data,s);assert.equal(h.value.checkedAt,s.observedAt);assert.equal(h.value.loading,false);assert.equal(h.requests.length,1);assert.equal(h.events.at(-1).animate,false);
  h.reply(0,s,304);await h.drain();assert.equal(h.value.data,s);h.close();
  const wrong=harness(snapshot('CNY'));wrong.render();assert.equal(wrong.value.data,null);assert(wrong.value.loading);wrong.reply(0);await wrong.drain();wrong.close();
  const invalid=harness({...s,summary:{...s.summary,knownAsset:NaN}});invalid.render();assert.equal(invalid.value.data,null);invalid.reply(0);await invalid.drain();invalid.close();
 });
 await test('account form distinguishes a rename from explicit same-amount reconciliation', async () => {
  const h=harness(),a=snapshot().accounts[0];assert.equal(h.client.allocationAmountMode(a,100),'automatic');assert.equal(h.client.allocationAmountMode(a,101),'statement');assert.equal(h.client.allocationAmountMode({...a,reconciled:true},100),'statement');assert.equal(h.client.allocationAmountMode({...a,kind:'manual'},100),'statement');assert.equal(h.client.allocationAmountMode(null,100),'statement');
  assert.equal(h.client.allocationAmountMode(a,100,true),'statement','retyping the same amount is an explicit checkpoint, not a metadata-only rename');
  assert.equal(h.client.allocationAmountMode({...a,amount:null,value:null},0),'automatic','a missing valuation must not turn a label edit into a new statement');
  assert.equal(h.client.allocationAmountMode({...a,amount:null,value:null},0,true),'statement','entering zero remains an explicit reconciliation');
 });
 await test('snapshot contract rejects wrong currency, owner, malformed amounts and missing categories', async () => {
  const h = harness(), s = snapshot(); assert(h.client.validAllocationSnapshot(s, 'USD', 'owner'));
  assert(h.client.validAllocationSnapshot({ ...s, accounts: [{ ...s.accounts[0], excluded: true }], summary: { ...s.summary, accountCount: 0 } }, 'USD', 'owner'), 'excluded accounts remain readable but are not counted in the summary');
  assert(h.client.validAllocationSnapshot({ ...s, accounts: [{ ...s.accounts[0], currency: 'UNKNOWN', value: null }], summary: { ...s.summary, complete: false, netAsset: null } }, 'USD', 'owner'), 'unknown source currency remains visible with missing valuation');
  for (const bad of [{ ...s, currency: 'CNY' }, { ...s, accountId: 'foreign' }, { ...s, summary: { ...s.summary, netAsset: NaN } }, { ...s, bankSummary: { ...s.bankSummary, value: undefined } }, { ...s, categories: s.categories.slice(1) }, { ...s, accounts: [s.accounts[0], s.accounts[0]] }, { ...s, snapshotRevision: 'not-a-revision' }]) assert(!h.client.validAllocationSnapshot(bad, 'USD', 'owner'));
 });
 await test('account-position links reject misplaced, missing and duplicate holdings while retaining old market-less snapshots', async () => {
  const h=harness(),s=snapshot(),a={...s.accounts[0],recordIds:['record-cn']},p={id:'record-cn',name:'Baosteel',code:'600019',market:'CN',currency:'CNY',brokerId:null,revision:0,accountId:a.id};
  const linked={...s,accounts:[a],positions:[p]};assert(h.client.validAllocationSnapshot(linked,'USD','owner'));
  const {market,...legacy}=p;assert(h.client.validAllocationSnapshot({...linked,positions:[legacy]},'USD','owner'));
  for(const bad of [{...linked,positions:[{...p,accountId:'another'}]},{...linked,positions:[]},{...linked,accounts:[{...a,recordIds:[]}]},{...linked,accounts:[{...a,recordIds:[p.id,p.id]}]},{...linked,positions:[{...p,market:123}]}]) assert(!h.client.validAllocationSnapshot(bad,'USD','owner'));
  h.close();
 });
 await test('conditional read binds owner/currency, preserves snapshot identity and validates 304 headers', async () => {
  const h = harness(), s = snapshot(), p = h.client.readAllocation('USD', s); h.reply(0, s, 304); const result = await p;
  assert.equal(result.snapshot, s); assert.equal(result.checkedAt, '2026-10-07T12:01:00.000Z'); assert.equal(h.requests[0].init.headers['X-Allocation-User'], 'owner'); assert.equal(h.requests[0].init.headers['If-None-Match'], `W/"${s.snapshotRevision}"`);
  const c = h.client.readAllocation('CNY', s); assert.equal(h.requests[1].init.headers['If-None-Match'], undefined); h.reply(1, snapshot('CNY')); assert.equal((await c).snapshot.currency, 'CNY');
  const bad = h.client.readAllocation('USD', null); h.reply(2, s, 304); await assert.rejects(bad, /响应无效/);
  const other = h.client.readAllocation('USD', s); h.reply(3, { ...s, accountId: 'foreign' }); await assert.rejects(other, e => e.status === 409);
  const mismatch = h.client.readAllocation('USD', s); h.reply(4, s, 304, { ETag: 'W/"other"' }); await assert.rejects(mismatch, /响应无效/);
 });
 await test('read deadline includes delayed JSON and cancellation never leaves a timer or starts an aborted fetch', async () => {
  const h = harness(), p = h.client.readAllocation('USD', null), rejected = assert.rejects(p, /读取超时/);
  h.requests[0].resolve({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) });
  await Promise.resolve(); h.tick(8000); await rejected; assert(h.requests[0].init.signal.aborted); assert.equal(h.timers.size, 0);
  const controller = new AbortController(); controller.abort(); await assert.rejects(h.client.readAllocation('USD', null, controller.signal), e => e.name === 'AbortError'); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
 });
 await test('writes validate acknowledgements, time out once and never automatically replay mutations', async () => {
  const h = harness(), body = { requestId: 'fixed-id', revision: 0 }, p = h.client.writeAllocation('POST', '/api/asset-allocation', 'owner', body);
  h.requests[0].resolve(response({ id: 'manual:fixed-id', revision: 1 })); await p;
  const timed = h.client.writeAllocation('POST', '/api/asset-allocation', 'owner', body), rejected = assert.rejects(timed, e => e.uncertain && /保存超时/.test(e.message)); h.tick(12000); await rejected;
  assert.equal(h.requests.length, 2); assert(h.requests[1].init.signal.aborted); assert.equal(h.timers.size, 0);
  const malformed = h.client.writeAllocation('PUT', '/api/asset-allocation', 'owner', { id: 'x', revision: 2 }); h.requests[2].resolve(response({ id: 'other', revision: 3 })); await assert.rejects(malformed, e => e.uncertain);
  const conflict = h.client.writeAllocation('PUT', '/api/asset-allocation', 'owner', { id: 'x', revision: 2 }); h.reply(3, null, 409); await assert.rejects(conflict, e => e.status === 409 && !e.uncertain);
  const assignment = h.client.writeAllocation('POST', '/api/asset-allocation/assign', 'owner', { brokerId: 'b', records: [{ id: 'one' }, { id: 'two' }] }); h.requests[4].resolve(response({ brokerId: 'b', recordIds: ['one', 'one'] })); await assert.rejects(assignment, e => e.uncertain);
 });
 await test('manual requests coalesce, successful background checks are quiet and unchanged data is retained', async () => {
  const h = harness(); h.render(); assert(h.value.loading); const first = h.value.refresh(), second = h.value.refresh(); assert.equal(first, second); assert.equal(h.requests.length, 1);
  h.reply(0); await h.drain(); const s = h.value.data; assert(!h.value.loading);
  h.tick(30000); h.render(); assert.equal(h.requests.length, 2); assert(!h.value.loading); assert.equal(h.events.at(-1).animate, false);
  h.reply(1, s, 304); await h.drain(); assert.equal(h.value.data, s); assert.equal(h.value.checkedAt, '2026-10-07T12:01:00.000Z'); h.close();
 });
 await test('currency switches retain labelled accounts, cancel previous reads and ignore out-of-order results', async () => {
  const h = harness(); h.render(); h.reply(0); await h.drain(); const old = h.value.data;
  h.currency('CNY'); assert.equal(h.value.data, old); assert(h.value.changingCurrency); assert(h.value.loading);
  h.currency('USD'); assert(h.requests[1].init.signal.aborted); assert.equal(h.requests.length, 2, 'returning to the still-fresh currency reuses its snapshot'); const current = h.value.data;
  h.reply(1, snapshot('CNY', 'b')); await h.drain(); assert.equal(h.value.data, current); assert.equal(h.value.data.currency, 'USD'); assert(!h.value.changingCurrency); h.close();
 });
 await test('hidden workspaces cancel reads/timers, retain layout and resume only when due', async () => {
  const h = harness(); h.render(); h.reply(0); await h.drain(); const s = h.value.data;
  h.foreground(false); assert.equal(h.timers.size, 0); assert.equal(h.value.data, s); h.foreground(true); assert.equal(h.requests.length, 1);
  h.tick(30000); h.render(); assert.equal(h.requests.length, 2); h.foreground(false); assert(h.requests[1].init.signal.aborted); assert.equal(h.timers.size, 0);
  h.foreground(true); assert.equal(h.requests.length, 3); h.reply(1, snapshot('USD', 'c')); await h.drain(); assert.equal(h.value.data, s);
  h.reply(2); await h.drain(); h.close(); assert.equal(h.timers.size, 0);
 });
 await test('mutations invalidate earlier reads and source changes while hidden are refreshed on return', async () => {
  const h = harness(); h.render(); h.reply(0); await h.drain(); h.value.refresh(); h.render(); h.value.refresh('mutation'); h.render(); assert(h.requests[1].init.signal.aborted);
  h.reply(2, snapshot('USD', 'b')); await h.drain(); h.reply(1, snapshot('USD', 'c')); await h.drain(); assert.equal(h.value.data.snapshotRevision, 'b'.repeat(64));
  h.foreground(false); h.dispatch('fire:records-updated'); assert.equal(h.requests.length, 3); h.foreground(true); assert.equal(h.requests.length, 4); h.reply(3); await h.drain(); h.close();
 });
 await test('paired record/order notifications collapse to one read, and unmount discards late results', async () => {
  const h = harness(); h.render(); h.reply(0); await h.drain(); h.dispatch('fire:records-updated'); h.dispatch('fire:orders-updated'); assert.equal(h.requests.length, 1);
  h.tick(0); h.render(); assert.equal(h.requests.length, 2); h.close(); assert(h.requests[1].init.signal.aborted);
  h.reply(1, snapshot('USD', 'b')); await h.drain(); assert.equal(h.value.data.snapshotRevision, 'a'.repeat(64)); assert.equal(h.timers.size, 0);
 });
 await test('cash and card changes invalidate old reads, coalesce together and refresh hidden workspaces on return', async () => {
  const h=harness();h.render();h.reply(0);await h.drain();h.value.refresh();h.render();
  h.dispatch('fire:funds-updated');h.dispatch('fire:cards-updated');h.tick(0);h.render();assert(h.requests[1].init.signal.aborted);assert.equal(h.requests.length,3);
  h.reply(2,snapshot('USD','b'));await h.drain();h.reply(1,snapshot('USD','c'));await h.drain();assert.equal(h.value.data.snapshotRevision,'b'.repeat(64));
  h.foreground(false);h.dispatch('fire:cards-updated');h.dispatch('fire:funds-updated');h.tick(0);assert.equal(h.requests.length,3);
  h.foreground(true);assert.equal(h.requests.length,4);h.reply(3);await h.drain();h.close();
 });
 await test('transient failures retain balances and back off; authorization failure clears private data', async () => {
  const h = harness(); h.render(); h.reply(0); await h.drain(); const s = h.value.data; h.value.refresh(); h.reply(1, null, 500); await h.drain(); assert.equal(h.value.data, s); assert(h.value.error); assert(!h.value.loading);
  h.tick(30000); h.render(); h.reply(2, null, 500); await h.drain(); h.tick(30000); assert.equal(h.requests.length, 3); h.tick(30000); h.render(); assert.equal(h.requests.length, 4);
  h.reply(3, null, 401); await h.drain(); assert.equal(h.value.data, null); assert.equal(h.value.checkedAt, '');
  h.value.refresh(); h.reply(4); await h.drain(); assert(h.value.data); assert.equal(h.value.error, ''); h.close();
 });
 console.log(`Asset allocation client: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
