const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  ts = require("typescript"),
  vm = require("node:vm");
const mod = { exports: {} };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync(require.resolve("../lib/deployProgress.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
  mod,
);
const { buildStages, buildStatusLabel, workflowLabel } = mod.exports;
assert.equal(workflowLabel("Build request receipt · 550e8400-e29b-41d4-a716-446655440000"), "登记发布请求");
const job = (id, name, status = "in_progress", conclusion = null) => ({
  id,
  name,
  status,
  conclusion,
  startedAt: "2026-11-07T01:00:00Z",
  completedAt: status === "completed" ? "2026-11-07T01:02:00Z" : null,
  url: null,
  steps: [],
});
const checks = Array.from({ length: 8 }, (_, i) =>
  job(i + 10, `完整平台检查 (${7 - i})`),
);
let stages = buildStages([
  job(2, "Publish linux/amd64 image", "queued"),
  ...checks,
  job(1, "Check scheduled source changes", "completed", "success"),
  job(3, "发布不可变版本清单", "queued"),
]);
assert.equal(stages.length, 4);
assert.equal(stages[1].name, "完整平台检查");
assert.equal(stages[1].jobs.length, 8);
assert.equal(stages[1].jobs[0].name, "完整平台检查 (0)");
assert.equal(stages[2].name, "Publish linux/amd64 image");
assert.equal(stages[3].name, "发布不可变版本清单");
assert.equal(stages.flatMap((s) => s.jobs).length, 11);
assert.equal(checks[0].name, "完整平台检查 (7)");
assert.equal(stages[1].status, "in_progress");
assert.equal(stages[1].conclusion, null);
const completed = checks.map((j) => ({
  ...j,
  status: "completed",
  conclusion: "success",
  completedAt: "2026-11-07T01:02:00Z",
}));
assert.equal(buildStages(completed)[0].conclusion, "success");
assert.equal(
  buildStages([
    ...completed.slice(1),
    { ...completed[0], conclusion: "failure" },
  ])[0].conclusion,
  "failure",
);
assert.equal(
  buildStages(completed.map((j) => ({ ...j, conclusion: "skipped" })))[0]
    .conclusion,
  "skipped",
);
assert.equal(
  buildStages(completed.map((j) => ({ ...j, conclusion: null })))[0].conclusion,
  null,
);
assert.equal(
  buildStages([
    { ...completed[0], status: "queued", conclusion: null },
    ...completed.slice(1),
  ])[0].status,
  "in_progress",
);
assert.equal(buildStages(null).length, 0);
assert.equal(buildStages([]).length, 0);
assert.equal(buildStatusLabel("completed", null), "待核对");
assert.equal(
  buildStages([job(1, "TypeScript check"), job(2, "Publish linux/amd64 image")])
    .length,
  2,
);
assert.equal(buildStages([...checks, job(30, "额外安全检查")]).length, 2);
assert.equal(workflowLabel("完整平台检查 (0)"), "第 1 组检查");
assert.equal(
  workflowLabel("Run astral-sh/setup-uv@abcdef"),
  "准备 Python 环境",
);
console.log(
  "PASS deploy progress: matrix grouping retains every job, ordered stages, legacy jobs, failure/skip/unknown states and missing observations",
);
