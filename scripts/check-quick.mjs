import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checks = [
  ["提交标题", process.execPath, ["scripts/check-commit-title.mjs", process.env.PR_BASE_SHA || process.env.BEFORE_SHA || "", process.env.HEAD_SHA || "HEAD"]],
  ["公开源码", "npm", ["run", "audit:public"]],
  ["部署配置", "npm", ["run", "audit:deploy"]],
  ["镜像发布契约", process.execPath, ["tests/deploy-publication.mjs"]],
  ["前端与启动回归", "npm", ["run", "test:review"]],
  ["类型检查", process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"]],
  ["版本一致性、数据库只读检查与发布回执", "uv", ["run", "--frozen", "--project", "platform", "--group", "dev", "pytest", "platform/tests/test_releases.py", "platform/tests/test_fire_config_database.py", "platform/tests/test_deployment_build_receipts.py", "-q"]],
];

for (const [label, command, args] of checks) {
  console.log(`\nCHECK ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(`无法执行 ${label}：请检查 ${command} 是否已安装。`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("\n推送前快检通过；完整平台回归与 Linux 镜像检查由 CI 继续执行。");
