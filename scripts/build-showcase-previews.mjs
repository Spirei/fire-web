import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const showroom = path.join(root, "public", "uploads", "mclaren");
const modelsDir = path.join(showroom, "models");
const previewsDir = path.join(showroom, "previews");
fs.mkdirSync(previewsDir, { recursive: true });

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--id" || !/^[a-z0-9][a-z0-9_-]{1,39}$/.test(args[1]))) throw new Error("用法：--id 车型代号");
const selectedId = args[1];
const jobs = [["mcl35m", path.join(root, "public", "mclaren", "mcl35m.glb"), path.join(root, "public", "mclaren", "mcl35m-preview.glb")]];
try {
  const registry = JSON.parse(fs.readFileSync(path.join(showroom, "showroom.json"), "utf8"));
  for (const item of registry.models ?? []) {
    if (!/^[A-Za-z0-9._-]+\.glb$/i.test(item.file)) continue;
    jobs.push([
      item.id,
      path.join(modelsDir, item.file),
      path.join(previewsDir, `${item.file.replace(/\.glb$/i, "")}-preview.glb`)
    ]);
  }
} catch { /* 没有 uploads 登记表时只处理内置车 */ }

const selectedJobs = selectedId ? jobs.filter(([id]) => id === selectedId) : jobs;
if (selectedId && selectedJobs.length !== 1) throw new Error("车型不存在或代号重复");
for (const [, input, output] of selectedJobs) {
  if (!fs.existsSync(input)) {
    if (selectedId) throw new Error("模型文件不存在");
    continue;
  }
  const result = spawnSync(path.join(root, "node_modules", ".bin", "gltf-transform"), [
    "optimize", input, output,
    "--compress", "meshopt",
    "--simplify", "false",
    "--join", "false",
    "--flatten", "false",
    "--palette", "false",
    "--texture-compress", "webp",
    "--texture-size", "1024"
  ], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
