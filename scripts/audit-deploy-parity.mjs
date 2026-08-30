import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const localCompose = read("docker-compose.yml");
const ghcrCompose = read("docker-compose.ghcr.yml");
const dockerfile = read("Dockerfile");
const entrypoint = read("scripts/entrypoint.sh");

const failures = [];
function requireText(label, text, needles) {
  for (const needle of needles) {
    if (!text.includes(needle)) failures.push(`${label} 缺少：${needle}`);
  }
}

const sharedCompose = [
  '"${HOST_PORT:-3000}:3000"',
  "NODE_ENV: production",
  "HOSTNAME: 0.0.0.0",
  "PORT: 3000",
  "path: .env",
  "${DATA_DIR:-./data}:/app/data",
  "${UPLOADS_DIR:-./uploads}:/app/public/uploads",
  "http://127.0.0.1:3000/api/settings/public"
];
requireText("本地 Compose", localCompose, sharedCompose);
requireText("GHCR Compose", ghcrCompose, sharedCompose);

requireText("生产镜像", dockerfile, [
  "COPY --from=build /app/public/uploads /app/resource-default",
  "python3 python3-venv",
  "pip install --no-cache-dir -r /app/scripts/requirements-futu.txt",
  'ENV PATH="/opt/futu-venv/bin:${PATH}"',
  'ENTRYPOINT ["sh", "/app/entrypoint.sh"]'
]);
requireText("启动脚本", entrypoint, [
  "if [ -d /app/resource-default ]",
  "cp -rn /app/resource-default/* /app/public/uploads/"
]);

for (const [label, text] of [["本地 Compose", localCompose], ["GHCR Compose", ghcrCompose]]) {
  if (/\/volume\d+\//.test(text)) failures.push(`${label} 含群晖个人绝对路径`);
  if (/\b(?:16000|3001):3000\b/.test(text)) failures.push(`${label} 含写死的宿主机端口`);
}

if (failures.length) {
  console.error(`部署一致性审计失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("部署一致性审计通过：本地源码构建与 GHCR 共用端口、持久化目录、默认资源和富途运行时约定。");
