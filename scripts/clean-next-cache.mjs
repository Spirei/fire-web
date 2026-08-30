#!/usr/bin/env node
/**
 * Next.js 构建缓存清理（防膨胀）
 *
 * .next/cache（生产构建）与 .next-dev/cache（开发模式）都是 webpack 持久化缓存，
 * 由构建自动再生。反复构建会无限堆大（实测可达 700MB+），这里做阈值式治理：
 *   - 默认：任一缓存目录超过 200MB 即删除（保留小缓存，加速增量构建 / HMR）；
 *   - --force：无论大小一律删除；
 *   - 顺带清理缓存目录树里的 .DS_Store。
 * 用法：npm run clean:caches            # 阈值清理（fire.sh 启动前自动执行）
 *       npm run clean:caches -- --force  # 强制清空
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const WEB_DIR = process.cwd();
const THRESHOLD = 200 * 1024 * 1024; // 200MB
const force = process.argv.includes("--force");
const TARGETS = [".next", ".next-dev"];

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function cleanDsStore(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return 0;
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === ".DS_Store") {
      await fs.rm(path.join(dir, entry.name), { force: true }).catch(() => {});
      removed += 1;
    } else if (entry.isDirectory()) {
      removed += await cleanDsStore(path.join(dir, entry.name));
    }
  }
  return removed;
}

let totalFreed = 0;
for (const dist of TARGETS) {
  const cacheDir = path.join(WEB_DIR, dist, "cache");
  const size = await dirSize(cacheDir);
  if (size === 0) continue;
  if (force || size > THRESHOLD) {
    await fs.rm(cacheDir, { recursive: true, force: true });
    totalFreed += size;
    console.log(`已清理 ${dist}/cache（${fmt(size)}${force ? "，强制" : "，超过阈值"}）`);
  } else {
    console.log(`${dist}/cache ${fmt(size)}，未超阈值，保留以加速构建`);
  }
  await cleanDsStore(path.join(WEB_DIR, dist));
}

console.log(totalFreed > 0 ? `本次释放 ${fmt(totalFreed)}` : "无需清理");
