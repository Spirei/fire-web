import fs from "node:fs";
import path from "node:path";
const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const failures = [];
function requireText(file, needles) {
  const text = read(file);
  for (const needle of needles)
    if (!text.includes(needle)) failures.push(`${file}: 缺少 ${needle}`);
  return text;
}
const compose = requireText("docker-compose.ghcr.yml", [
  '"${HOST_PORT:-3000}:3000"',
  "FIRE_PYTHON: /platform/.venv/bin/python",
  "${FIRE_PRIVATE_DIR:?请填写私有运行目录}:/private",
  "${UPLOADS_DIR:-./uploads}:/app/public/uploads",
  "${IMAGES_DIR:-./images}:/app/public/images:ro",
  "${FONTS_DIR:-./fonts}:/app/public/fonts:ro",
  "${ICONS_DIR:-./icons}:/app/public/icons:ro",
  "${SHARE_DIR:-./share}:/app/public/share:ro",
  "containrrr/watchtower:1.7.1",
  "WATCHTOWER_HTTP_API_TOKEN:",
  "WATCHTOWER_SCOPE: fire",
  "${DOCKER_CONFIG_DIR:-/root/.docker}:/config:ro",
  "/health/ready",
  "external: true",
  "${FIRE_NETWORK:?请填写数据库所在网络}",
]);
if (
  /^\s{4}ports:/m.test(
    compose.split("  fire-updater:")[1]?.split("\nnetworks:")[0] || "",
  )
)
  failures.push("更新器不得映射公开端口");
if (/\/volume\d+\//.test(compose)) failures.push("部署配置含个人绝对路径");
requireText("Dockerfile", [
  "COPY platform/pyproject.toml platform/uv.lock",
  "uv sync --frozen --no-dev --no-editable --extra futu",
  "postgresql-client-$PG_MAJOR",
  "COPY --from=web /app/public/uploads resource-default",
  "RUN test -s public/fire-assets/clownfish-family.png",
  "COPY platform/migrations platform/migrations",
  "USER 1000:1000",
  "/health/ready",
  'CMD ["npm", "start"]',
]);
requireText("scripts/fire.mjs", [
  '"scripts/fire_platform.py"',
  '"serve"',
  '"worker"',
  "FIRE_PLATFORM_SOCKET: socket",
  "fs.chmodSync(runtime, 0o700)",
  '"SIGTERM"',
]);
requireText(".github/workflows/docker-publish.yml", [
  'cron: "7 16 * * *"',
  "npm run audit:deploy",
]);
requireText(".dockerignore", [
  "platform/.venv",
  "platform/.local",
  "**/.env",
  "public/uploads/**",
]);
const fish = fs.readFileSync("public/fire-assets/clownfish-family.png");
if (fish.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
  failures.push("Fire 内置鱼素材无效");
if (failures.length) {
  console.error("部署配置审计失败：\n" + failures.join("\n"));
  process.exit(1);
}
console.log(
  "部署配置审计通过：Fire 单一入口、内部后端、PG 工具、素材副本与更新流程。此结果不代表镜像已构建或线上已部署。",
);
