import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const ghcrCompose = read("docker-compose.ghcr.yml");
const dockerfile = read("Dockerfile");
const entrypoint = read("scripts/entrypoint.sh");
const uploadRoute = read("app/uploads/[...path]/route.ts");
const assetsModule = read("lib/assets.ts");
const dockerignore = read(".dockerignore");
const workerDockerfile = read("tools/model-optimizer/Dockerfile");
const imageWorkflow = read(".github/workflows/docker-publish.yml");

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
  // 插图 / 字体 / 图标 / 分享图既不进仓库也不进镜像，只能靠运行时挂载提供；
  // 少了它们 FIRE 页面的小丑鱼、礁石、自定义字体与图标会 404（曾以「我的鱼丢了」的形式暴露）。
  "${IMAGES_DIR:-./images}:/app/public/images:ro",
  "${FONTS_DIR:-./fonts}:/app/public/fonts:ro",
  "${ICONS_DIR:-./icons}:/app/public/icons:ro",
  "${SHARE_DIR:-./share}:/app/public/share:ro",
  "http://127.0.0.1:3000/api/settings/public"
];
requireText("GHCR Compose", ghcrCompose, sharedCompose);
requireText("模型处理独立容器", ghcrCompose, ["fire-model-worker:", "-model-worker:${IMAGE_TAG:-latest}", "network_mode: none", "cpus: 2.0", "mem_limit: 8g", "pids_limit: 128"]);
requireText("模型处理镜像", workerDockerfile, ["npm ci --omit=dev", "sha256sum -c -", "USER node", 'CMD ["node", "online-worker.mjs"]']);
requireText("模型处理镜像发布", imageWorkflow, ["Model worker metadata", "Build and push model worker", "context: ./tools/model-optimizer"]);
requireText("GHCR 受限容器更新", ghcrCompose, [
  "containrrr/watchtower:1.7.1",
  "WATCHTOWER_HTTP_API_UPDATE: \"true\"",
  "WATCHTOWER_HTTP_API_TOKEN:",
  "WATCHTOWER_LABEL_ENABLE: \"true\"",
  "WATCHTOWER_SCOPE: fire",
  "DOCKER_CONFIG: /config",
  "com.centurylinklabs.watchtower.enable: \"true\"",
  "com.centurylinklabs.watchtower.scope: \"fire\"",
  "/var/run/docker.sock:/var/run/docker.sock",
  "${DOCKER_CONFIG_DIR:-/root/.docker}:/config:ro"
]);

const updaterBlock = ghcrCompose.split("  fire-updater:")[1] || "";
if (/^\s{4}ports:/m.test(updaterBlock)) failures.push("Watchtower 不得映射宿主机端口");

requireText("生产镜像", dockerfile, [
  "COPY --from=build /app/public/uploads /app/resource-default",
  "/app/public-cache-default/asset-quotes-cache.json",
  "/app/public-cache-default/celebs-cache.json",
  "/app/public-cache-default/earnings-cache/",
  "python3 python3-venv",
  "pip install --no-cache-dir -r /app/scripts/requirements-futu.txt",
  'ENV PATH="/opt/futu-venv/bin:${PATH}"',
  'ENTRYPOINT ["sh", "/app/entrypoint.sh"]'
]);
requireText("启动脚本", entrypoint, [
  // 校验的是「镜像内路径必须被启动脚本引用」这一不变式；路径已改为带默认值的变量，
  // 因此断言路径本身，不再断言具体某行 shell 写法。
  "/app/resource-default",
  "/app/public/uploads",
  "/app/public-cache-default",
  "seed-trading-square.mjs",
  // 部署素材缺失必须有一条日志线索，不能只靠肉眼发现「图不见了」。
  "缺少部署素材",
  "docs/synology-deploy.md"
]);
requireText("Docker 构建上下文", dockerignore, [
  "!data/asset-quotes-cache.json",
  "!data/celebs-cache.json",
  "!data/earnings-cache/*.json"
]);
requireText("上传资源路由", uploadRoute, ["resource-default", "defaultAbs", "fs.createReadStream(source)"]);
requireText("素材播种", assetsModule, ["resource-default", "ensureBrokerAssets", "ensureCategoryAssets"]);

requireText("部署者自行提供素材", dockerignore, ["public/uploads/**", "!public/uploads/.gitkeep"]);
requireText("非 root 运行", dockerfile, ["USER node", "chmod -R 750"]);

for (const [label, file] of [
  ["交易广场段永平缓存", "data/duan-posts.json"],
  ["交易广场特朗普缓存", "data/trump-posts.json"],
  ["全球市值排行缓存", "data/top-stocks-cache.json"],
  ["加密货币与贵金属行情缓存", "data/asset-quotes-cache.json"],
  ["名人持仓缓存", "data/celebs-cache.json"]
]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || fs.statSync(full).size < 3) failures.push(`${label}缺失或为空：${file}`);
}
const earningsDir = path.join(root, "data/earnings-cache");
const earningsCount = fs.existsSync(earningsDir)
  ? fs.readdirSync(earningsDir).filter((file) => file.endsWith(".json")).length
  : 0;
if (earningsCount === 0) failures.push("财报日历公开缓存缺失");

if (/\/volume\d+\//.test(ghcrCompose)) failures.push("GHCR Compose 含群晖个人绝对路径");
if (/\b(?:16000|3001):3000\b/.test(ghcrCompose)) failures.push("GHCR Compose 含写死的宿主机端口");

if (failures.length) {
  console.error(`部署一致性审计失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("部署一致性审计通过：GHCR Compose、Dockerfile、默认资源和富途运行时约定一致。");
