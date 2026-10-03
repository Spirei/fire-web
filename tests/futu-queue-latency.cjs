// Execute the production bridge queue against fake sockets and child processes.
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), originalLoad = Module._load, children = [];
process.env.STOCKLOG_FUTU = 'on';
Module._load = function(id, parent, ...rest) {
  if (parent?.filename === path.join(root, 'lib/futuQuotes.ts')) {
    if (id === './settings') return { getSiteSettings: () => ({ futuHost: 'localhost', futuPort: '11111' }), normalizeFutuHost: x => x };
    if (id === 'node:net') return { connect: () => {
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.setTimeout = () => {};
      setImmediate(() => socket.emit('connect')); return socket;
    } };
    if (id === 'node:child_process') return { spawn: () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end: raw => { child.input = JSON.parse(raw); } };
      child.kill = () => { child.killed = true; };
      child.finish = () => {
        child.stdout.emit('data', JSON.stringify({ ok: true, quotes: Object.fromEntries(child.input.items.map(x => [x.id, { price: 100 }])) }));
        child.emit('close', child.killed ? null : 0);
      };
      children.push(child); return child;
    } };
  }
  return originalLoad.call(this, id, parent, ...rest);
};
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const { fetchFutuQuotes } = require('../lib/futuQuotes.ts');
const item = id => [{ id, market: 'US', code: 'AAPL' }];
const flush = () => new Promise(resolve => setImmediate(resolve));
let count = 0; const test = async (name, run) => { await run(); console.log('PASS ' + name); count++; };
(async () => {
  await test('expired queued reads return immediately and never start a child after the queue clears', async () => {
    const first = fetchFutuQuotes(item('first')); await flush(); await flush(); assert.equal(children.length, 1);
    const controller = new AbortController(), second = fetchFutuQuotes(item('expired'), controller.signal);
    const rejected = assert.rejects(second, /queue deadline/); await flush(); controller.abort(new Error('queue deadline')); await rejected;
    assert.equal(children.length, 1); assert.equal(children[0].killed, undefined);
    children[0].finish(); await first; await flush(); assert.equal(children.length, 1);
    const third = fetchFutuQuotes(item('third')); await flush(); assert.equal(children.length, 2);
    children[1].finish(); assert.equal((await third).get('third').price, 100);
  });
  await test('running timeout kills its child but queue waits for actual close before opening another connection', async () => {
    const controller = new AbortController(), current = fetchFutuQuotes(item('running'), controller.signal);
    const rejected = assert.rejects(current, /execution deadline/); await flush(); assert.equal(children.length, 3);
    controller.abort(new Error('execution deadline')); await rejected; assert.equal(children[2].killed, true);
    const later = fetchFutuQuotes(item('later')); await flush(); assert.equal(children.length, 3);
    children[2].finish(); await flush(); assert.equal(children.length, 4);
    children[3].finish(); assert.equal((await later).get('later').price, 100);
  });
  await test('pre-cancelled reads never probe or open a bridge', async () => {
    const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    await assert.rejects(fetchFutuQuotes(item('cancelled'), controller.signal), /already cancelled/);
    assert.equal(children.length, 4);
  });
  console.log(`PASS ${count} Futu queue latency suites (fake OpenD only)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
