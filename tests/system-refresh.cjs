const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  ts = require("typescript"),
  vm = require("node:vm");
const source = ts.createSourceFile(
  "SystemView.tsx",
  fs.readFileSync(
    path.join(__dirname, "../components/views/SystemView.tsx"),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let effect, readTasks, load;
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useEffect" &&
    node.arguments[0]?.getText(source).includes("const poll =")
  )
    effect = node.arguments[0];
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "readTasks"
  )
    readTasks = node.initializer;
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "load" && ts.isCallExpression(node.initializer)) load = node.initializer.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert(effect && readTasks);
const compile = (node) =>
  ts.transpileModule("exports.run=" + node.getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
function harness(active = true, seeded = false) {
  const timers = new Map(),
    events = new Map(),
    signals = [];
  let calls = 0,
    closed = 0,
    number = 0;
  const context = {
    exports: {},
    active,
    firstSeed: { current: seeded },
    seed: undefined,
    filter: "",
    mode: "overview",
    AbortController,
    generation: { current: 0 },
    pauseRefresh: { current: false },
    document: {
      hidden: false,
      addEventListener: (key, fn) => events.set(key, fn),
      removeEventListener: (key) => events.delete(key),
    },
    load: async (signal) => {
      calls++;
      signals.push(signal);
    },
    setConnection: () => closed++,
    setSelected: () => closed++,
    setTimeout: (fn, delay) => {
      timers.set(++number, { fn, delay });
      return number;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(compile(effect), context);
  const cleanup = context.exports.run();
  return {
    context,
    timers,
    events,
    signals,
    cleanup,
    get calls() {
      return calls;
    },
    get closed() {
      return closed;
    },
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.fn();
      return timer.delay;
    },
  };
}
(async () => {
  const h = harness();
  assert.equal(h.calls, 1);
  assert.equal(await h.tick(), 15000);
  assert.equal(h.calls, 2);
  h.context.document.hidden = true;
  await h.tick();
  assert.equal(h.calls, 2, "hidden page must not poll");
  h.events.get("visibilitychange")();
  assert.equal(h.closed, 2, "hidden page retires sensitive dialogs");
  h.context.document.hidden = false;
  h.context.pauseRefresh.current = true;
  await h.tick();
  assert.equal(
    h.calls,
    2,
    "mutation/dialog must not be interrupted by polling",
  );
  h.context.pauseRefresh.current = false;
  h.events.get("visibilitychange")();
  assert.equal(h.calls, 3);
  h.cleanup();
  assert.equal(h.timers.size, 0);
  assert.equal(h.events.size, 0);
  assert(h.signals.every((signal) => signal.aborted));
  const seeded = harness(true, true);
  assert.equal(seeded.calls, 0, "server bootstrap removes the duplicate mount read");
  await seeded.tick();
  assert.equal(seeded.calls, 1, "live polling still revalidates the server snapshot");
  seeded.cleanup();
  const inactive = harness(false);
  assert.equal(inactive.calls, 0);
  assert.equal(inactive.timers.size, 0);
  const requests = [],
    results = [
      {
        items: Array.from({ length: 100 }, (_, i) => ({ id: i })),
        next_cursor: "cursor-100",
      },
      {
        items: Array.from({ length: 50 }, (_, i) => ({ id: i + 100 })),
        next_cursor: "cursor-150",
      },
    ];
  const context = {
    exports: {},
    mode: "tasks",
    visibleTaskCount: { current: 150 },
    filter: "queued",
    identity: { csrf: "synthetic" },
    signal: new AbortController().signal,
    json: async (url, options) => {
      requests.push({ url, options });
      return results.shift();
    },
  };
  vm.runInNewContext(compile(readTasks), context);
  const page = await context.exports.run();
  assert.equal(page.items.length, 150);
  assert.equal(page.next_cursor, "cursor-150");
  assert(requests[0].url.includes("limit=100"));
  assert(
    requests[1].url.includes("limit=50") &&
      requests[1].url.includes("cursor=cursor-100"),
  );
  assert(
    requests.every(
      (row) => row.options.headers["x-csrf-token"] === "synthetic",
    ),
  );
  const stale = [], observations = [], loading = [];
  let unavailable = true;
  const probe = {
    exports: {}, document: { hidden: false }, generation: { current: 0 },
    csrf: { current: "" }, instance: { current: "" }, ownerId: "owner", mode: "overview", filter: "",
    visibleTaskCount: { current: 25 }, clear(){}, fail(){}, setLoading(value){loading.push(value);}, setError(){},
    setMigration(){}, setTasks(){}, setCursor(){}, setReceipt(){},
    setOverview: value => observations.push(value), setOverviewStale: value => stale.push(value),
    json: async url => {
      if (url === "/api/fire/session") return { user: { id: "owner", role: "admin" }, csrf: "csrf", instance_id: "instance" };
      if (url.startsWith("/api/fire/tasks")) return { items: [], next_cursor: null };
      if (unavailable) throw Error("temporary outage");
      return { services: [], task_counts: {} };
    }
  };
  vm.runInNewContext(compile(load), probe);
  await probe.exports.run(); assert.equal(stale.at(-1), true); assert.equal(observations.length, 0, "failed probe retains last observation rather than inventing a new one");
  unavailable = false; await probe.exports.run(); assert.equal(stale.at(-1), false); assert.equal(observations.length, 1);
  loading.length=0; await probe.exports.run(undefined,true); assert.equal(loading.length,0,"background reads never toggle foreground loading or collapse empty states");
  console.log(
    "PASS system refresh: visible-only polling, dialog/mutation pause, cleanup and retained task pagination",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Exercise the actual header expression so an unresolved test cannot reuse old green status.
let connectionState;
(function find(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='connectionState')connectionState=node.initializer;ts.forEachChild(node,find);})(source);
assert(connectionState);
const stateCode=ts.transpileModule('exports.state='+connectionState.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function observed(values){const c={exports:{},busy:false,requestId:'',receipt:null,error:'',observation:{state:'up'},...values};vm.runInNewContext(stateCode,c);return c.exports.state;}
assert.equal(observed({}), 'up');
assert.equal(observed({observation:undefined}), 'unknown');
assert.equal(observed({requestId:'one'}), 'unknown');
assert.equal(observed({requestId:'one',busy:true}), 'checking');
assert.equal(observed({requestId:'one',receipt:{status:'failed'}}), 'down');
assert.equal(observed({requestId:'one',receipt:{status:'passed'}}), 'up');
assert.equal(observed({error:'read failed'}), 'stale');
console.log('PASS connection header: checking, unknown, failure and stale observations cannot masquerade as success');
