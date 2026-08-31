import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const localCompose = read("docker-compose.yml");
const ghcrCompose = read("docker-compose.ghcr.yml");
const dockerfile = read("Dockerfile");
const entrypoint = read("scripts/entrypoint.sh");
const uploadRoute = read("app/uploads/[...path]/route.ts");
const assetsModule = read("lib/assets.ts");

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
requireText("上传资源路由", uploadRoute, ["resource-default", "defaultAbs", "fs.readFileSync(source)"]);
requireText("素材播种", assetsModule, ["resource-default", "ensureBrokerAssets", "ensureCategoryAssets"]);

for (const [label, directory, minimum] of [
  ["国旗默认素材", "public/uploads/asset/flag", 200],
  ["券商默认素材", "public/uploads/asset/broker", 1],
  ["贵金属默认素材", "public/uploads/asset/metal", 4]
]) {
  const full = path.join(root, directory);
  const count = fs.existsSync(full) ? fs.readdirSync(full).filter((file) => /\.(svg|png|webp|jpe?g)$/i.test(file)).length : 0;
  if (count < minimum) failures.push(`${label}不完整：${count}/${minimum}`);
}

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
